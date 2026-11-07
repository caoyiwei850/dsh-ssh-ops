import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { streamDownload } from "../src/client/stream-download.js";

function fixture(chunks, length, digest = createHash("sha256").update(Buffer.from(chunks.flat())).digest("hex")) {
  const state = { chunks: [], closed: false, aborted: false };
  const handle = { async createWritable() { return {
    async write(chunk) { state.chunks.push(...chunk); },
    async close() { state.closed = true; },
    async abort() { state.aborted = true; }
  }; } };
  const body = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk)); controller.close(); } });
  return { state, handle, response: new Response(body, { headers: { "content-length": String(length), "x-content-sha256": digest } }) };
}

test("streams bytes and reports progress before committing", async () => {
  const f = fixture([[1, 2], [3]], 3);
  const progress = [];
  await streamDownload(f.response, f.handle, undefined, (n, total) => progress.push([n, total]));
  assert.deepEqual(f.state.chunks, [1, 2, 3]);
  assert.deepEqual(progress, [[2, 3], [3, 3]]);
  assert.equal(f.state.closed, true);
});

test("checksum mismatch prevents committing the local file", async () => {
  const f = fixture([[1, 2]], 2, "0".repeat(64));
  await assert.rejects(streamDownload(f.response, f.handle), /SHA-256 verification failed/);
  assert.equal(f.state.aborted, true);
  assert.equal(f.state.closed, false);
});

test("missing checksum is rejected before the local file is opened", async () => {
  const f = fixture([[1]], 1);
  f.response.headers.delete("x-content-sha256");
  await assert.rejects(streamDownload(f.response, f.handle), /did not provide/);
  assert.equal(f.state.closed, false);
});

test("truncated and cancelled downloads abort the local write", async () => {
  const f = fixture([[1]], 2);
  await assert.rejects(streamDownload(f.response, f.handle), /before all bytes/);
  assert.equal(f.state.aborted, true);
  assert.equal(f.state.closed, false);
  const g = fixture([[1]], 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(streamDownload(g.response, g.handle, controller.signal), { name: "AbortError" });
  assert.equal(g.state.aborted, true);
});

test("resumes an interrupted response and verifies the complete file", async () => {
  const digest = createHash("sha256").update(Buffer.from([1, 2, 3, 4])).digest("hex");
  const first = fixture([[1, 2]], 4, digest);
  let requested;
  const resume = async (offset, expected) => {
    requested = [offset, expected];
    return new Response(Uint8Array.from([3, 4]), { headers: { "content-length": "2", "x-content-sha256": digest, "x-download-offset": "2", "x-file-size": "4" } });
  };
  await streamDownload(first.response, first.handle, undefined, undefined, resume);
  assert.deepEqual(requested, [2, digest]);
  assert.deepEqual(first.state.chunks, [1, 2, 3, 4]);
  assert.equal(first.state.closed, true);
});

test("rejects a changed remote file during resume", async () => {
  const digest = createHash("sha256").update(Buffer.from([1, 2])).digest("hex");
  const first = fixture([[1]], 2, digest);
  const resume = async () => new Response(Uint8Array.from([2]), { headers: { "x-content-sha256": "0".repeat(64), "x-download-offset": "1", "x-file-size": "2" } });
  await assert.rejects(streamDownload(first.response, first.handle, undefined, undefined, resume), /Resume refused/);
  assert.equal(first.state.aborted, true);
  assert.equal(first.state.closed, false);
});

test("cancelling while waiting for a reconnect discards the temporary write", async () => {
  const digest = createHash("sha256").update(Buffer.from([1, 2])).digest("hex");
  const first = fixture([[1]], 2, digest);
  const controller = new AbortController();
  const resume = async () => {
    queueMicrotask(() => controller.abort());
    return new Response("offline", { status: 503 });
  };
  await assert.rejects(streamDownload(first.response, first.handle, controller.signal, undefined, resume), { name: "AbortError" });
  assert.equal(first.state.aborted, true);
  assert.equal(first.state.closed, false);
});
