import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegexRunner } from "../src/client/terminal-display/regex-runner.js";
import { createNodeHighlightWorker } from "./helpers/highlight-worker.mjs";
const scheme = (text) => [{ id: "custom:test", text, mode: "regex", color: "#123456", enabled: true, caseSensitive: false }];

test("real regex worker supports groups, Unicode and zero-length matches with bounded results", async () => {
  const lease = createRegexRunner({ createWorker: createNodeHighlightWorker, startupMs: 5000 }).acquire();
  try {
    const result = await lease.match(scheme('ERROR\\s+\\d+|\\p{Script=Han}+'), ['ERROR 42 中文', 'plain']);
    assert.deepEqual(result.lines, [[{ start: 0, end: 8, color: '#123456' }, { start: 9, end: 11, color: '#123456' }], []]);
    assert.deepEqual((await lease.match(scheme('(?=a)'), ['aaa'])).lines, [[]]);
    assert.equal((await lease.match(scheme('a'), ['a'.repeat(10000)])).lines[0].length, 4096);
    assert.deepEqual((await lease.match(scheme('['), ['ERROR'])).lines, [[]]);
  } finally { lease.release(); }
});

test("dense output reserves the match budget for the newest rows", async () => {
  const lease = createRegexRunner({ createWorker: createNodeHighlightWorker, startupMs: 5000, timeoutMs: 5000 }).acquire();
  try {
    const result = await lease.match(scheme("ERROR"), Array.from({ length: 200 }, () => "ERROR ".repeat(40)));
    assert.equal(result.lines[199].length, 40);
    assert.equal(result.lines[0].length, 0);
    assert.equal(result.lines.reduce((sum, row) => sum + row.length, 0), 4096);
  } finally { lease.release(); }
});

test("catastrophic regex times out off-thread, is quarantined, and valid edits recover", async () => {
  const lease = createRegexRunner({ createWorker: createNodeHighlightWorker, timeoutMs: 75, startupMs: 5000 }).acquire();
  let ticks = 0;
  const heartbeat = setInterval(() => ticks++, 10);
  try {
    const bad = scheme('(a+)+$');
    assert.equal((await lease.match(bad, ['a'.repeat(16000) + '!'])).error, 'regex-timeout');
    assert.ok(ticks > 0, 'main thread remains responsive');
    assert.equal((await lease.match(bad, ['a'])).error, 'regex-timeout');
    assert.deepEqual((await lease.match(scheme('ERROR'), ['ERROR'])).lines, [[{ start: 0, end: 5, color: '#123456' }]]);
  } finally { clearInterval(heartbeat); lease.release(); }
});

test("queued updates coalesce and another terminal recovers after a poisoned scheme", async () => {
  const runner = createRegexRunner({ createWorker: createNodeHighlightWorker, timeoutMs: 75, startupMs: 5000 });
  const first = runner.acquire(), second = runner.acquire();
  try {
    const slow = first.match(scheme('(a+)+$'), ['a'.repeat(16000) + '!']);
    const stale = second.match(scheme('OLD'), ['OLD']);
    const latest = second.match(scheme('NEW'), ['NEW']);
    assert.equal((await stale).cancelled, true);
    assert.equal((await slow).error, 'regex-timeout');
    assert.equal((await latest).lines[0][0].end, 3);
  } finally { first.release(); second.release(); }
});

test("unavailable or silent workers settle requests without a synchronous regex fallback", async () => {
  for (const createWorker of [() => { throw Error('CSP'); }, () => ({ postMessage() {}, terminate() {} })]) {
    const lease = createRegexRunner({ createWorker, startupMs: 25 }).acquire();
    try { assert.equal((await lease.match(scheme('ERROR'), ['ERROR'])).error, 'worker-unavailable'); }
    finally { lease.release(); }
  }
});
