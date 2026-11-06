import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadPipeline } from "../src/sftp-pipeline.js";

test("out-of-order writes advance only the contiguous prefix", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sftp-pipeline-"));
  const path = join(dir, "source");
  const source = Buffer.alloc(12288); for (let i = 0; i < source.length; i += 1) source[i] = i % 251;
  const data = Buffer.alloc(source.length);
  const seen = [];
  const sftp = {
    open(_path, _flags, cb) { cb(null, 1); },
    write(_handle, bytes, _start, length, offset, cb) {
      setTimeout(() => { bytes.copy(data, offset); cb(null); }, offset === 0 ? 30 : 0);
    },
    close(_handle, cb) { cb(null); }
  };
  try {
    await writeFile(path, source);
    await uploadPipeline(sftp, path, "/remote", { chunkBytes: 4096, window: 3, onProgress: (n) => seen.push(n) });
    assert.deepEqual(data, source);
    assert.deepEqual(seen, [0, 0, 12288]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("write failure and cancellation close the remote handle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sftp-pipeline-"));
  const path = join(dir, "source");
  await writeFile(path, Buffer.alloc(100));
  try {
    for (const cancel of [false, true]) {
      let closed = false;
      const controller = new AbortController();
      const sftp = {
        open(_path, _flags, cb) { cb(null, 1); },
        write(_handle, _data, _start, _length, _offset, cb) { if (cancel) controller.abort(new Error("cancelled")); else cb(new Error("write failed")); },
        close(_handle, cb) { closed = true; cb(null); }
      };
      await assert.rejects(uploadPipeline(sftp, path, "/remote", { signal: controller.signal }), cancel ? /cancelled/ : /write failed/);
      assert.equal(closed, true);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
