import { open } from "node:fs/promises";

const CHUNK_BYTES = 32 * 1024;
const WINDOW = 64;
const IDLE_MS = 30000;

/** Write bounded, independent blocks. Report only a contiguous acknowledged prefix. */
export async function uploadPipeline(sftp, localPath, remotePath, { signal, onProgress, start = 0, chunkBytes = CHUNK_BYTES, window = WINDOW, idleMs = IDLE_MS } = {}) {
  const local = await open(localPath, "r");
  let remote;
  let timer;
  let abortListener;
  let stopped = false;
  let finished = false;
  let firstError;
  const pending = new Set();
  try {
    const size = (await local.stat()).size;
    if (!Number.isSafeInteger(start) || start < 0 || start > size) throw new Error("Invalid upload checkpoint");
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 4096 || chunkBytes > 256 * 1024 || !Number.isSafeInteger(window) || window < 1 || window > 64) throw new Error("Invalid upload window");
    const cancelled = new Promise((_, reject) => {
      abortListener = () => reject(signal.reason ?? new Error("SFTP upload cancelled"));
      if (signal?.aborted) abortListener();
      else signal?.addEventListener("abort", abortListener, { once: true });
    });
    // Attach immediately, even if the first SFTP operation later fails.
    cancelled.catch(() => {});
    const call = (method, ...args) => new Promise((resolve, reject) => {
      try { sftp[method](...args, (error, value) => error ? reject(error) : resolve(value)); }
      catch (error) { reject(error); }
    });
    const bounded = async (promise) => {
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("SFTP upload stalled")), idleMs); });
      try { return await Promise.race([promise, cancelled, deadline]); } finally { clearTimeout(timer); }
    };
    const opening = call("open", remotePath, start > 0 ? "r+" : "w");
    try {
      remote = await bounded(opening);
    } catch (error) {
      // An OPEN reply may arrive after cancellation or timeout. Do not leak
      // the server handle in that case.
      void opening.then((handle) => { try { sftp.close(handle, () => {}); } catch {} }, () => {});
      throw error;
    }
    let next = start;
    let committed = start;
    const completed = new Map();
    while (committed < size) {
      while (!stopped && next < size && pending.size < window) {
        const offset = next;
        const length = Math.min(chunkBytes, size - offset);
        next += length;
        const work = (async () => {
          const buffer = Buffer.allocUnsafe(length);
          const result = await local.read(buffer, 0, length, offset);
          if (result.bytesRead !== length) throw new Error("Local file changed during upload");
          if (finished || stopped) return;
          if (signal?.aborted) throw signal.reason ?? new Error("SFTP upload cancelled");
          await call("write", remote, buffer, 0, length, offset);
          if (finished || stopped) return;
          completed.set(offset, length);
          while (completed.has(committed)) {
            const written = completed.get(committed);
            completed.delete(committed);
            committed += written;
          }
          onProgress?.(committed, size);
        })().catch((error) => { stopped = true; firstError ??= error; }).finally(() => pending.delete(work));
        pending.add(work);
      }
      if (pending.size) await bounded(Promise.race(pending));
      if (firstError) throw firstError;
    }
    await bounded(Promise.all(pending));
    return { bytes: size };
  } finally {
    finished = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortListener);
    // Close the SFTP handle before the caller removes its unique temporary file.
    if (remote !== undefined) await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 2000);
      try { sftp.close(remote, () => { clearTimeout(timeout); resolve(); }); }
      catch { clearTimeout(timeout); resolve(); }
    });
    await local.close();
  }
}
