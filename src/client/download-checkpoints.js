import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

/** Browser-private staging for explicitly enabled restartable downloads. */
const DIRECTORY = "dsh-ssh-ops-downloads-v1";
const CHECKPOINT_INTERVAL = 4 * 1024 * 1024;

async function rootDirectory() {
  if (!globalThis.navigator?.storage?.getDirectory || !globalThis.navigator?.locks?.request) throw new Error("Persistent downloads are unavailable in this browser");
  return (await navigator.storage.getDirectory()).getDirectoryHandle(DIRECTORY, { create: true });
}

export async function listDownloadCheckpoints(identity) {
  if (!identity) return [];
  const root = await rootDirectory();
  const result = [];
  for await (const [id, entry] of root.entries()) {
    if (entry.kind !== "directory" || !/^[0-9a-f-]{36}$/i.test(id)) continue;
    try {
      const meta = JSON.parse(await (await (await entry.getFileHandle("meta.json")).getFile()).text());
      if (meta.identity !== identity || typeof meta.path !== "string" || !/^[0-9a-f]{64}$/.test(meta.digest) || !Number.isSafeInteger(meta.total) || meta.total < 0) continue;
      const data = await (await entry.getFileHandle("data")).getFile();
      if (data.size <= meta.total) result.push({ id, ...meta, offset: data.size });
    } catch { /* Incomplete metadata stays untouched for manual cleanup. */ }
  }
  return result;
}

export async function deleteDownloadCheckpoint(id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid checkpoint ID");
  const root = await rootDirectory();
  await root.removeEntry(id, { recursive: true });
}

export async function createDownloadCheckpoint(meta) {
  const root = await rootDirectory();
  const id = crypto.randomUUID();
  const dir = await root.getDirectoryHandle(id, { create: true });
  try {
    const metadata = await dir.getFileHandle("meta.json", { create: true });
    const writer = await metadata.createWritable();
    await writer.write(JSON.stringify(meta));
    await writer.close();
    await dir.getFileHandle("data", { create: true });
    return { id, ...meta, offset: 0 };
  } catch (error) {
    await root.removeEntry(id, { recursive: true }).catch(() => {});
    throw error;
  }
}

export async function checkpointFile(id) {
  const root = await rootDirectory();
  const dir = await root.getDirectoryHandle(id);
  return (await dir.getFileHandle("data")).getFile();
}

/** Stage locally; the user's chosen destination is changed only after validation. */
export function checkpointDestination(id, destination, signal, expectedDigest) {
  return { async createWritable() {
    const root = await rootDirectory();
    const dir = await root.getDirectoryHandle(id);
    const file = await dir.getFileHandle("data");
    let position = (await file.getFile()).size;
    let lastCommit = position;
    let writer = await file.createWritable({ keepExistingData: true });
    await writer.seek(position);
    return {
      async write(chunk) {
        await writer.write(chunk);
        position += chunk.byteLength;
        if (position - lastCommit >= CHECKPOINT_INTERVAL) {
          await writer.close();
          lastCommit = position;
          writer = await file.createWritable({ keepExistingData: true });
          await writer.seek(position);
        }
      },
      async abort() { await writer.close(); },
      async close() {
        await writer.close();
        const stored = await file.getFile();
        const hash = sha256.create();
        const verifyReader = stored.stream().getReader();
        try { for (;;) {
          if (signal?.aborted) throw new DOMException("Download cancelled", "AbortError");
          const item = await verifyReader.read();
          if (item.done) break;
          hash.update(item.value);
        } } finally { verifyReader.releaseLock(); }
        if (!expectedDigest || bytesToHex(hash.digest()) !== expectedDigest) throw new Error("Saved download checksum does not match");
        const target = await destination.createWritable();
        try {
          const reader = stored.stream().getReader();
          try { for (;;) {
            if (signal?.aborted) throw new DOMException("Download cancelled", "AbortError");
            const item = await reader.read();
            if (item.done) break;
            await target.write(item.value);
          } }
          finally { reader.releaseLock(); }
          if (signal?.aborted) throw new DOMException("Download cancelled", "AbortError");
          await target.close();
        } catch (error) { await target.abort().catch(() => {}); throw error; }
        await deleteDownloadCheckpoint(id).catch(() => {});
      }
    };
  } };
}

export async function withDownloadLock(id, work) {
  return navigator.locks.request(`dsh-download-${id}`, { ifAvailable: true }, (lock) => {
    if (!lock) throw new Error("This download is already active in another window");
    return work();
  });
}
