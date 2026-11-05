/**
 * 自适应窗口 SFTP 上传器的单元测试。下面这个假 SFTP 句柄是故意刁难的：它延迟
 * 确认、让一次写入失败、还能干脆不回答 —— 真实的引擎必须在这些情况下都不丢字节、
 * 不丢偏移。
 *
 *   node --test test/sftp-push.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_WINDOW_BYTES,
  MIN_PIPELINE_BYTES,
  nextWindow,
  normalizePipelineOptions,
  uploadPipelined
} from "../src/sftp-push.js";

function makeRemote({ failFirstN = 0, delayMs = 1, silent = false } = {}) {
  const state = { data: Buffer.alloc(0), writes: 0, failures: 0, settled: false, closed: false, maxOffset: 0 };
  const sftp = {
    open(path, flags, cb) {
      state.path = path;
      state.flags = flags;
      setImmediate(() => cb(null, { handle: 1 }));
    },
    close(handle, cb) {
      state.closed = true;
      cb?.();
    },
    write(handle, buffer, offset, length, position, cb) {
      state.writes += 1;
      if (silent) return undefined;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      const finish = () => {
        if (state.failures < failFirstN) {
          state.failures += 1;
          cb(new Error("transient write failure"));
          return;
        }
        if (state.data.length < position + length) {
          const grown = Buffer.alloc(position + length);
          state.data.copy(grown, 0, 0, state.data.length);
          state.data = grown;
        }
        payload.copy(state.data, position);
        state.maxOffset = Math.max(state.maxOffset, position + length);
        state.settled = true;
        cb(null);
      };
      delayMs === 0 ? finish() : setTimeout(finish, delayMs);
      return undefined;
    }
  };
  return { sftp, state };
}

function withTempFile(size, fill) {
  const dir = mkdtempSync(join(tmpdir(), "sftp-push-"));
  const path = join(dir, "source.bin");
  const buffer = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) buffer[i] = fill(i);
  writeFileSync(path, buffer);
  return { path, buffer, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("writes every byte at the right offset", async () => {
  const { path, buffer, cleanup } = withTempFile(300 * 1024, (i) => i % 251);
  const { sftp, state } = makeRemote({ delayMs: 0 });
  try {
    const stats = await uploadPipelined({
      sftp,
      localFile: path,
      remotePath: "/dest.bin",
      size: buffer.length,
      options: { chunk: 16 * 1024, concStart: 4, concMax: 8, hardStallMs: 5000 }
    });
    assert.equal(stats.bytes, buffer.length);
    assert.equal(state.data.length, buffer.length);
    assert.deepEqual(state.data, buffer);
    assert.equal(state.flags, "w");
    assert.equal(state.closed, true);
  } finally {
    cleanup();
  }
});

test("resumes at an offset and leaves earlier bytes untouched", async () => {
  const { path, buffer, cleanup } = withTempFile(200 * 1024, (i) => (i * 7) % 256);
  const { sftp, state } = makeRemote({ delayMs: 0 });
  const start = 96 * 1024;
  state.data = Buffer.alloc(start, 0xaa);
  try {
    const stats = await uploadPipelined({
      sftp,
      localFile: path,
      remotePath: "/dest.bin",
      size: buffer.length,
      start,
      options: { chunk: 16 * 1024, concStart: 4, concMax: 8, hardStallMs: 5000 }
    });
    assert.equal(stats.bytes, buffer.length - start);
    assert.equal(stats.start, start);
    assert.equal(state.flags, "r+");
    assert.deepEqual(state.data.subarray(0, start), Buffer.alloc(start, 0xaa));
    assert.deepEqual(state.data.subarray(start), buffer.subarray(start));
  } finally {
    cleanup();
  }
});

test("retries a failed chunk in place instead of aborting", async () => {
  const { path, buffer, cleanup } = withTempFile(128 * 1024, (i) => i % 97);
  const { sftp, state } = makeRemote({ failFirstN: 3, delayMs: 0 });
  try {
    const stats = await uploadPipelined({
      sftp,
      localFile: path,
      remotePath: "/dest.bin",
      size: buffer.length,
      options: { chunk: 16 * 1024, concStart: 2, concMax: 4, retries: 3, hardStallMs: 5000 }
    });
    assert.equal(stats.retries, 3);
    assert.deepEqual(state.data, buffer);
  } finally {
    cleanup();
  }
});

test("a write that keeps failing fails the transfer", async () => {
  const { path, buffer, cleanup } = withTempFile(64 * 1024, () => 1);
  const { sftp } = makeRemote({ failFirstN: 99, delayMs: 0 });
  try {
    await assert.rejects(
      uploadPipelined({
        sftp,
        localFile: path,
        remotePath: "/dest.bin",
        size: buffer.length,
        options: { chunk: 16 * 1024, concStart: 2, concMax: 2, retries: 1, hardStallMs: 5000 }
      }),
      /transient write failure/
    );
  } finally {
    cleanup();
  }
});

test("abort rejects with the caller's reason and stops writing", async () => {
  const { path, buffer, cleanup } = withTempFile(512 * 1024, (i) => i % 13);
  const { sftp, state } = makeRemote({ delayMs: 5 });
  const controller = new AbortController();
  try {
    const running = uploadPipelined({
      sftp,
      localFile: path,
      remotePath: "/dest.bin",
      size: buffer.length,
      options: { chunk: 16 * 1024, concStart: 2, concMax: 2, hardStallMs: 5000 },
      signal: controller.signal,
      onProgress: () => controller.abort(new Error("cancelled by operator"))
    });
    await assert.rejects(running, /cancelled by operator/);
    const writesAtAbort = state.writes;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(state.writes, writesAtAbort);
    assert.equal(state.closed, true);
  } finally {
    cleanup();
  }
});

test("a silent server trips the hard stall instead of hanging", async () => {
  const { path, buffer, cleanup } = withTempFile(MIN_PIPELINE_BYTES, () => 3);
  const { sftp } = makeRemote({ silent: true });
  try {
    await assert.rejects(
      uploadPipelined({
        sftp,
        localFile: path,
        remotePath: "/dest.bin",
        size: buffer.length,
        options: { chunk: 16 * 1024, concStart: 2, concMax: 2, hardStallMs: 600, tickMs: 100 }
      }),
      /stalled/
    );
  } finally {
    cleanup();
  }
});

test("window is capped by bytes in flight, not by the raw request", () => {
  const wide = normalizePipelineOptions({ chunk: 256 * 1024, concMax: 4096 });
  assert.ok(wide.chunk * wide.concMax <= MAX_WINDOW_BYTES, `${wide.chunk} x ${wide.concMax} exceeds the cap`);
  assert.ok(wide.concStart <= wide.concMax);

  const narrow = normalizePipelineOptions({ chunk: 1024, concMax: 8, concStart: 64 });
  assert.equal(narrow.chunk, 4 * 1024);
  assert.equal(narrow.concMax, 8);
  assert.equal(narrow.concStart, 8);
});

test("progress never reports past the file size", async () => {
  const { path, buffer, cleanup } = withTempFile(120 * 1024, (i) => i % 200);
  const { sftp } = makeRemote({ delayMs: 0 });
  const seen = [];
  try {
    await uploadPipelined({
      sftp,
      localFile: path,
      remotePath: "/dest.bin",
      size: buffer.length,
      options: { chunk: 16 * 1024, concStart: 4, concMax: 8, hardStallMs: 5000 },
      onProgress: (acked, total) => seen.push([acked, total])
    });
    assert.ok(seen.length > 0);
    for (const [acked, total] of seen) {
      assert.ok(acked <= total, `acked ${acked} > total ${total}`);
      assert.ok(acked <= buffer.length);
    }
  } finally {
    cleanup();
  }
});

/**
 * 直接驱动窗口控制律。这些用例真实链路测不了 —— 同一条线两次跑出来的答案都不一样。
 */
const law = (over = {}) => ({
  conc: 64,
  concMin: 4,
  concMax: 64,
  ssthresh: 64,
  slowStart: false,
  lastRate: 1000,
  lastShrinkAt: 0,
  growMs: 500,
  shrinkRatio: 0.7,
  growRatio: 1.15,
  ...over
});

test("a sample 30 % worse halves the window and remembers the ceiling", () => {
  const step = nextWindow(law(), 600, 5_000);
  assert.equal(step.conc, 32);
  assert.equal(step.ssthresh, 64);
  assert.equal(step.shrunk, true);
});

test("a sample 30 % better takes that same factor", () => {
  const step = nextWindow(law({ conc: 32, ssthresh: 32 }), 1_500, 5_000);
  assert.equal(step.conc, 48);
  assert.equal(step.shrunk, false);
});

test("recovery doubles straight back towards the ceiling it fell from", () => {
  let state = law({ conc: 32, ssthresh: 64 });
  state = { ...state, ...nextWindow(state, 1_000, 1_000) };
  assert.equal(state.conc, 64);
});

test("recovery waits while the link is still falling", () => {
  const state = law({ conc: 32, ssthresh: 64, lastShrinkAt: 900 });
  const step = nextWindow(state, 500, 1_000);
  assert.equal(step.conc, 32);
  assert.equal(step.shrunk, false);
});

test("one bad sample cannot shrink the window twice in a row", () => {
  const state = law({ conc: 64, lastShrinkAt: 900 });
  const step = nextWindow(state, 100, 1_000);
  assert.equal(step.conc, 64);
  assert.equal(step.shrunk, false);
});

test("the window stays between the floor and the ceiling", () => {
  const floor = nextWindow(law({ conc: 4 }), 10, 5_000);
  assert.equal(floor.conc, 4);
  const ceiling = nextWindow(law({ conc: 64 }), 9_000, 5_000);
  assert.equal(ceiling.conc, 64);
});

test("a drop followed by a healthy link climbs back within a few steps", () => {
  let state = law();
  let now = 5_000;
  state = { ...state, ...nextWindow(state, 300, (now += 500)) };
  assert.equal(state.conc, 32);
  let steps = 0;
  while (state.conc < 64 && steps < 5) {
    state = { ...state, ...nextWindow(state, 900, (now += 500)) };
    steps += 1;
  }
  assert.equal(state.conc, 64);
  assert.ok(steps <= 3, `took ${steps} steps to recover`);
});

test("the window climbs back once the link returns", () => {
  let state = law({ conc: 8, ssthresh: 64, lastRate: 470_000 });
  let now = 5_000;
  let steps = 0;
  while (state.conc < 64 && steps < 6) {
    state = { ...state, ...nextWindow(state, 7_000_000, (now += 500)) };
    steps += 1;
  }
  assert.equal(state.conc, 64);
  assert.ok(steps <= 4, `took ${steps} steps`);
});

test("a steady link keeps its window instead of shrinking itself into a trap", () => {
  // 窗口窄 -> 速率低 -> 判定「还是慢」-> 永不恢复。控制律不能拿绝对速率当缩窗条件。
  let state = law({ conc: 64, lastRate: 300_000, ssthresh: 64 });
  let now = 5_000;
  for (let i = 0; i < 4; i += 1) state = { ...state, ...nextWindow(state, 300_000, (now += 500)) };
  assert.equal(state.conc, 64);
  assert.equal(state.shrunk, false);
});

test("growth stops once a wider window stops buying throughput", () => {
  let state = law({ conc: 16, ssthresh: 16, concMax: 256, bestRate: 0 });
  const seen = [];
  for (let i = 0; i < 8; i += 1) {
    state = { ...state, ...nextWindow(state, 1_000, 1_000 + i * 1_000) };
    seen.push(state.conc);
  }
  // 连续四步没有收益后，平台判定把窗口钉在当前位置。
  assert.ok(state.conc > 16, "it still explores at first");
  assert.ok(state.conc < 256, "it must not walk into the ceiling");
  assert.equal(state.conc, seen[seen.length - 1]);
  assert.equal(state.plateau, true);
});

test("a faster sample keeps the climb alive", () => {
  let state = law({ conc: 16, ssthresh: 16, concMax: 256, bestRate: 0 });
  let rate = 1_000;
  for (let i = 0; i < 6; i += 1) {
    rate *= 1.5;
    state = { ...state, ...nextWindow(state, rate, 1_000 + i * 1_000) };
  }
  assert.equal(state.plateau, false);
  assert.ok(state.conc > 64, "a rising link is allowed past the old 4 MiB ceiling");
});

test("a collapse clears the plateau so recovery can explore again", () => {
  let state = law({ conc: 32, ssthresh: 32, concMax: 256, plateau: true, bestRate: 9_000, staleGrows: 3 });
  const shrunk = nextWindow(state, 100, 5_000);
  assert.equal(shrunk.shrunk, true);
  assert.equal(shrunk.plateau, false);
  assert.equal(shrunk.bestRate, 0);
});

test("the window can grow past 64 chunks when the link keeps improving", () => {
  let state = law({ conc: 64, ssthresh: 64, concMax: 256, bestRate: 0 });
  let rate = 1_000;
  for (let i = 0; i < 5; i += 1) {
    rate *= 2;
    state = { ...state, ...nextWindow(state, rate, 1_000 + i * 1_000) };
  }
  assert.ok(state.conc > 64, `expected growth past 64, got ${state.conc}`);
});

test("the default ceiling is 256 chunks, not the old 64", () => {
  const opts = normalizePipelineOptions({});
  assert.equal(opts.concMax, Math.min(256, Math.floor(MAX_WINDOW_BYTES / opts.chunk)));
  assert.ok(opts.concMax >= 128, `expected a wide ceiling, got ${opts.concMax}`);
});
