import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { checkpointDestination, checkpointFile, createDownloadCheckpoint, listDownloadCheckpoints, withDownloadLock } from "../src/client/download-checkpoints.js";
import { streamDownload } from "../src/client/stream-download.js";

class FakeFile {
  constructor() { this.bytes = new Uint8Array(); this.kind = "file"; }
  async getFile() { return new Blob([this.bytes]); }
  async createWritable(options = {}) {
    let data = options.keepExistingData ? this.bytes.slice() : new Uint8Array();
    let position = 0;
    return {
      seek: async (value) => { position = value; },
      write: async (value) => {
        const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
        const next = new Uint8Array(Math.max(data.length, position + bytes.length));
        next.set(data); next.set(bytes, position); position += bytes.length; data = next;
      },
      close: async () => { this.bytes = data; },
      abort: async () => {}
    };
  }
}
class FakeDirectory {
  constructor() { this.items = new Map(); this.kind = "directory"; }
  async getDirectoryHandle(name, options = {}) {
    if (!this.items.has(name) && options.create) this.items.set(name, new FakeDirectory());
    if (!this.items.has(name)) throw new Error("missing directory");
    return this.items.get(name);
  }
  async getFileHandle(name, options = {}) {
    if (!this.items.has(name) && options.create) this.items.set(name, new FakeFile());
    if (!this.items.has(name)) throw new Error("missing file");
    return this.items.get(name);
  }
  async removeEntry(name) { this.items.delete(name); }
  async *entries() { yield* this.items.entries(); }
}

test("interrupted download survives reopening and verifies before committing", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const root = new FakeDirectory();
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    storage: { getDirectory: async () => root },
    locks: { request: async (_name, _options, callback) => callback({}) }
  } });
  try {
    const digest = createHash("sha256").update(Buffer.from([1, 2, 3, 4])).digest("hex");
    const checkpoint = await createDownloadCheckpoint({ identity: "test-server", path: "/file", digest, total: 4 });
    const target = new FakeFile();
    const first = new Response(Uint8Array.from([1, 2]), { headers: { "content-length": "4", "x-content-sha256": digest } });
    await assert.rejects(withDownloadLock(checkpoint.id, () => streamDownload(first, checkpointDestination(checkpoint.id, target, undefined, digest))), /before all bytes/);
    assert.equal((await target.getFile()).size, 0, "partial data never overwrites the chosen destination");
    const saved = await listDownloadCheckpoints("test-server");
    assert.equal(saved[0].offset, 2);
    assert.equal((await listDownloadCheckpoints("other-server")).length, 0);
    const prefix = await checkpointFile(checkpoint.id);
    const resumed = new Response(Uint8Array.from([3, 4]), { headers: { "content-length": "2", "x-file-size": "4", "x-download-offset": "2", "x-content-sha256": digest } });
    await withDownloadLock(checkpoint.id, () => streamDownload(resumed, checkpointDestination(checkpoint.id, target, undefined, digest), undefined, undefined, undefined, prefix));
    assert.deepEqual([...new Uint8Array(await (await target.getFile()).arrayBuffer())], [1, 2, 3, 4]);
    assert.deepEqual(await listDownloadCheckpoints("test-server"), []);

    const corrupted = await createDownloadCheckpoint({ identity: "test-server", path: "/file", digest, total: 4 });
    const stage = await checkpointDestination(corrupted.id, target, undefined, digest).createWritable();
    await stage.write(Uint8Array.from([9, 2]));
    await stage.abort();
    const badPrefix = await checkpointFile(corrupted.id);
    const response = new Response(Uint8Array.from([3, 4]), { headers: { "content-length": "2", "x-file-size": "4", "x-download-offset": "2", "x-content-sha256": digest } });
    await assert.rejects(streamDownload(response, checkpointDestination(corrupted.id, target, undefined, digest), undefined, undefined, undefined, badPrefix), /SHA-256 verification failed/);
    assert.deepEqual([...new Uint8Array(await (await target.getFile()).arrayBuffer())], [1, 2, 3, 4], "a modified checkpoint cannot overwrite a previously saved destination");
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
  }
});
