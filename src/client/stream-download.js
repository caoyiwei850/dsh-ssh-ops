import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

/** Copy and verify a response without buffering the whole file. */
export async function streamDownload(response, handle, signal, onProgress, resume, prefix) {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Download failed (HTTP ${response.status})`);
  }
  if (!response.body) throw new Error("Streaming download is unavailable");
  const expected = response.headers.get("x-content-sha256");
  if (!expected || !/^[0-9a-f]{64}$/i.test(expected)) {
    await response.body.cancel().catch(() => {});
    throw new Error("The server did not provide a SHA-256 checksum");
  }
  const hash = sha256.create();
  const header = response.headers.get("content-length");
  const totalHeader = response.headers.get("x-file-size") ?? header;
  const total = totalHeader !== null && /^\d+$/.test(totalHeader) ? Number(totalHeader) : null;
  let received = 0;
  if (prefix) {
    if (response.headers.get("x-download-offset") !== String(prefix.size) || total === null || prefix.size > total) throw new Error("Invalid saved download checkpoint");
    const prefixReader = prefix.stream().getReader();
    try {
      for (;;) {
        if (signal?.aborted) throw new DOMException("Download cancelled", "AbortError");
        const part = await prefixReader.read();
        if (part.done) break;
        hash.update(part.value);
        received += part.value.byteLength;
      }
    } finally { prefixReader.releaseLock(); }
    if (received !== prefix.size) throw new Error("Saved download checkpoint could not be read completely");
  }
  const writer = await handle.createWritable();
  const reader = response.body.getReader();
  let currentReader = reader;
  let retries = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException("Download cancelled", "AbortError");
      let part;
      try { part = await currentReader.read(); }
      catch (error) {
        if (signal?.aborted) throw error;
        part = { done: true };
      }
      if (part.done) {
        if (total === null || received === total) break;
        if (!resume || retries >= 3) throw new Error("Download ended before all bytes were received");
        await currentReader.cancel().catch(() => {});
        currentReader.releaseLock();
        currentReader = null;
        let next;
        while (retries < 3) {
          retries += 1;
          try { next = await resume(received, expected); }
          catch (error) { if (signal?.aborted || retries >= 3) throw error; }
          if (next && ![404, 502, 503, 504].includes(next.status)) break;
          if (retries >= 3) break;
          await next?.body?.cancel().catch(() => {});
          await new Promise((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(new DOMException("Download cancelled", "AbortError")); };
            const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, retries * 1000);
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
          });
        }
        if (!next?.ok || !next.body || next.headers.get("x-content-sha256") !== expected || next.headers.get("x-download-offset") !== String(received) || next.headers.get("x-file-size") !== String(total)) {
          await next?.body?.cancel().catch(() => {});
          throw new Error("Resume refused: the remote file changed or the server does not support resume");
        }
        currentReader = next.body.getReader();
        continue;
      }
      const { value } = part;
      await writer.write(value);
      hash.update(value);
      received += value.byteLength;
      onProgress?.(received, total);
    }
    if (signal?.aborted) throw new DOMException("Download cancelled", "AbortError");
    if (total !== null && received !== total) throw new Error("Download ended before all bytes were received");
    if (bytesToHex(hash.digest()) !== expected.toLowerCase()) throw new Error("SHA-256 verification failed; file was not saved");
    await writer.close();
  } catch (error) {
    await currentReader?.cancel().catch(() => {});
    await writer.abort().catch(() => {});
    throw error;
  } finally {
    currentReader?.releaseLock();
  }
}
