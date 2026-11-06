import { test } from "node:test";
import assert from "node:assert/strict";
import xterm from "@xterm/xterm";
import { OutputHighlightAddon, groupRunsByRow, MAX_DECORATIONS, COALESCE_MS } from "../src/client/terminal-display/addon.js";
import { createRegexRunner } from "../src/client/terminal-display/regex-runner.js";
import { getDisplaySettings, setDisplaySettings } from "../src/client/terminal-display/settings.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const write = (term, text) => new Promise((resolve) => term.write(text, resolve));
const color = "#ff2200";

/** A cell-line stub exposing exactly the IBufferLine surface the matcher reads. */
function stubLine(text) {
  return {
    isWrapped: false,
    length: text.length,
    getCell(x) {
      const chars = text[x] ?? " ";
      return { getChars: () => chars, getWidth: () => 1, getCode: () => chars.charCodeAt(0), isAttributeDefault: () => true };
    }
  };
}

/** Minimal Terminal stub: only what OutputHighlightAddon touches. */
function stubTerm({ viewportY = 0, lines = ["ERROR 42", "SUCCESS 7"], baseY = 0 } = {}) {
  const buffer = {
    type: "normal", viewportY, baseY, length: lines.length, cursorY: lines.length - 1,
    getLine: (y) => (y >= 0 && y < lines.length ? stubLine(lines[y]) : undefined)
  };
  const renderListeners = [], markers = [];
  const theme = {};
  const term = {
    rows: 4, cols: 20, options: { theme },
    buffer: { active: buffer, onBufferChange: () => ({ dispose() {} }) },
    onWriteParsed: () => ({ dispose() {} }),
    onScroll: () => ({ dispose() {} }),
    onRender: (listener) => { renderListeners.push(listener); return { dispose() {} }; },
    onResize: () => ({ dispose() {} }),
    // Same contract as xterm: an offset relative to the cursor line, and the
    // marker tracks the line (moving/disposing when the scrollback trims).
    registerMarker: (offset) => {
      const marker = { line: buffer.baseY + buffer.cursorY + offset, isDisposed: false, dispose() { this.isDisposed = true; } };
      markers.push(marker); return marker;
    },
    registerDecoration: () => ({ dispose() {} }),
    refresh() {},
    dispose() {}
  };
  return { term, buffer, markers, theme, emitRender: () => renderListeners.forEach((listener) => listener({ start: 0, end: 3 })) };
}

function stubMatcher(result = { lines: [] }) {
  const calls = [];
  return {
    calls,
    match(entries, texts) { calls.push(texts); return Promise.resolve({ lines: texts.map(() => result.lines[0] ?? []) }); },
    release() {},
    clearQuarantine() {}
  };
}

const settingsSnapshot = getDisplaySettings();
setDisplaySettings({ highlightEnabled: true, theme: "dark" });

test.after(() => setDisplaySettings(settingsSnapshot));

test("wheel-style viewport movement (which suppresses term.onScroll) triggers a rescan", async () => {
  const { term, buffer, emitRender } = stubTerm();
  const matcher = stubMatcher();
  const addon = new OutputHighlightAddon({ acquireMatcher: () => matcher, coalesceMs: 5, viewportPollMs: 10_000 });
  addon.activate(term);
  try {
    await wait(20);
    const initial = matcher.calls.length;
    assert.equal(addon.viewportY, 0);
    // xterm 5.5 Viewport.handleWheel -> scrollTop -> scrollLines(suppress) never
    // fires term.onScroll; the render event is the only signal the addon sees.
    buffer.viewportY = 3;
    emitRender();
    assert.equal(addon.viewportY, 3, "viewport position tracked from onRender");
    assert.notEqual(addon.timer, undefined, "a moved viewport arms a scan");
    await wait(20);
    assert.ok(matcher.calls.length > initial, "scrolling scheduled a scan");
    const afterScroll = matcher.calls.length;
    emitRender();
    await wait(10);
    assert.equal(matcher.calls.length, afterScroll, "an unmoved viewport does not rescan on every render");
  } finally { addon.dispose(); }
});

test("the viewport poll recovers when no render/scroll event arrives", async () => {
  const { term, buffer } = stubTerm();
  const matcher = stubMatcher();
  const addon = new OutputHighlightAddon({ acquireMatcher: () => matcher, coalesceMs: 5, viewportPollMs: 15 });
  addon.activate(term);
  try {
    await wait(40);
    const initial = matcher.calls.length;
    assert.ok(initial >= 1, "the initial scan finished before the poll window");
    buffer.viewportY = 5; // no render, no scroll event
    await wait(50);
    assert.ok(matcher.calls.length > initial, "the poll rescanned after a silent viewport change");
  } finally { addon.dispose(); }
});

test("scan results are applied even when write/scroll events arrive mid-flight", async () => {
  const term = new xterm.Terminal({ cols: 40, rows: 4, allowProposedApi: true });
  const pending = [];
  const matcher = { match(entries, texts) { return new Promise((resolve) => pending.push({ resolve, texts })); }, release() {}, clearQuarantine() {} };
  const addon = new OutputHighlightAddon({ acquireMatcher: () => matcher, coalesceMs: 1, viewportPollMs: 10_000 });
  term.loadAddon(addon);
  try {
    await write(term, "ERROR 42 SUCCESS");
    await wait(30);
    assert.ok(pending.length >= 1, "the initial scan reached the worker");
    // Old code bumped the generation on every event, so these three requests
    // would have discarded the results that are about to arrive.
    addon.request(); addon.request(); addon.request();
    for (const job of pending) job.resolve({ lines: job.texts.map(() => [{ start: 0, end: 5, color }]) });
    await wait(20);
    assert.ok(addon.rows.length > 0, "the in-flight result was applied instead of discarded");
    assert.ok(addon.rows.every((row) => row.decorations.length === 1));
  } finally { addon.dispose(); term.dispose(); }
});

test("a scrollback trim during the worker round-trip rescans instead of painting stale lines", async () => {
  const { term, markers } = stubTerm();
  const pending = [];
  const matcher = { match(entries, texts) { return new Promise((resolve) => pending.push({ resolve, texts })); }, release() {}, clearQuarantine() {} };
  const addon = new OutputHighlightAddon({ acquireMatcher: () => matcher, coalesceMs: 1_000, viewportPollMs: 10_000 });
  addon.activate(term);
  try {
    const scan = addon.scan();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(pending.length, 1);
    assert.equal(markers.length, 1, "one anchor marker guards the captured rows");
    markers[0].isDisposed = true; // xterm disposes anchors on trimmed lines
    pending[0].resolve({ lines: pending[0].texts.map(() => [{ start: 0, end: 5, color }]) });
    await scan;
    assert.equal(addon.rows.length, 0, "stale absolute line numbers are not painted");
    assert.equal(markers[0].isDisposed, true, "the anchor marker is released");
    assert.notEqual(addon.timer, undefined, "a fresh scan was requested");
  } finally { addon.dispose(); }
});

test("a trim that only shifts the rows rebases them instead of dropping the scan", async () => {
  const { term, markers } = stubTerm({ viewportY: 2, lines: ["ERROR 42", "SUCCESS 7", "ERROR 9", "SUCCESS 3", "ERROR 1", "SUCCESS 2"] });
  const pending = [];
  const matcher = { match(entries, texts) { return new Promise((resolve) => pending.push({ resolve, texts })); }, release() {}, clearQuarantine() {} };
  const addon = new OutputHighlightAddon({ acquireMatcher: () => matcher, coalesceMs: 1_000, viewportPollMs: 10_000 });
  addon.activate(term);
  try {
    const scan = addon.scan();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(markers.length, 1);
    assert.equal(markers[0].line, 2, "the anchor starts on the first captured line");
    markers[0].line -= 1; // one scrollback row trimmed; xterm shifts surviving markers
    pending[0].resolve({ lines: pending[0].texts.map(() => [{ start: 0, end: 5, color }]) });
    await scan;
    assert.ok(addon.rows.length > 0, "the shifted rows are rebased, not discarded");
    assert.deepEqual(addon.rows.map((row) => row.marker.line).sort((a, b) => a - b), [1, 2, 3, 4], "markers land on the rebased lines");
    assert.equal(addon.timer, undefined, "no rescan is needed");
  } finally { addon.dispose(); }
});

test("a scan applies when the captured rows survived the round-trip", async () => {
  const { term } = stubTerm();
  const pending = [];
  const matcher = { match(entries, texts) { return new Promise((resolve) => pending.push({ resolve, texts })); }, release() {}, clearQuarantine() {} };
  const addon = new OutputHighlightAddon({ acquireMatcher: () => matcher, coalesceMs: 1_000, viewportPollMs: 10_000 });
  addon.activate(term);
  try {
    const scan = addon.scan();
    await Promise.resolve();
    await Promise.resolve();
    pending[0].resolve({ lines: pending[0].texts.map(() => []) });
    await scan;
    assert.equal(addon.rows.length, 0);
    assert.equal(addon.timer, undefined, "no rescan is scheduled when nothing moved");
  } finally { addon.dispose(); }
});

test("decoration budget fills from the bottom so newest output keeps its colours", () => {
  const logical = (text, y) => ({ text, positions: [...text].map((_, i) => ({ x: i, y, width: 1, eligible: true })), next: y + 1 });
  const spans = (xs) => xs.map((x) => ({ start: x, end: x + 1, color }));
  const bottom = logical("abcde", 1), top = logical("ABCDE", 0);
  const capped = groupRunsByRow([top, bottom], [spans([0, 2, 4]), spans([0, 2, 4])], 0, 2, 4);
  assert.deepEqual([...capped.keys()].sort((a, b) => a - b), [0, 1]);
  assert.equal(capped.get(1).length, 3, "the bottom row is complete");
  assert.equal(capped.get(0).length, 1, "the top row only gets the leftover budget");
  assert.deepEqual(capped.get(0).map((run) => run.x), [0]);
  const tight = groupRunsByRow([top, bottom], [spans([0, 2, 4]), spans([0, 2, 4])], 0, 2, 2);
  assert.deepEqual([...tight.keys()], [1]);
  assert.deepEqual(tight.get(1).map((run) => run.x), [0, 2]);
  const roomy = groupRunsByRow([top, bottom], [spans([0, 2, 4]), spans([0, 2, 4])], 0, 2, MAX_DECORATIONS);
  assert.equal(roomy.get(0).length + roomy.get(1).length, 6);
});

test("the decoration cap is a rendering budget kept below xterm's full-refresh cliff", () => {
  assert.ok(MAX_DECORATIONS <= 1536, "cap must stay in the cheap full-refresh range");
  assert.ok(MAX_DECORATIONS >= 512, "cap must fit a normal viewport of highlighted tokens");
  assert.equal(COALESCE_MS, 60);
});

test("releasing one terminal keeps the shared worker warm for the others", async () => {
  const workers = [];
  const createWorker = () => {
    const worker = { posted: [], terminated: 0, onmessage: null, onerror: null,
      postMessage(data) { worker.posted.push(data); }, terminate() { worker.terminated++; } };
    workers.push(worker); return worker;
  };
  const runner = createRegexRunner({ createWorker, timeoutMs: 500, startupMs: 100 });
  const first = runner.acquire(), second = runner.acquire();
  try {
    const abandoned = first.match([{ id: "a" }], ["A"]);
    await wait(0);
    const worker = workers[0];
    worker.onmessage({ data: { ready: true } });
    await wait(0);
    assert.equal(worker.posted.length, 1);
    first.release();
    assert.equal(worker.terminated, 0, "another terminal's lease keeps the worker alive");
    assert.equal((await abandoned).cancelled, true, "the abandoned job is cancelled");
    const next = second.match([{ id: "b" }], ["B"]);
    await wait(0);
    assert.equal(workers.length, 1, "no replacement worker was created");
    assert.equal(worker.posted.length, 2, "the warm worker served the next terminal");
    worker.onmessage({ data: { id: worker.posted[1].id, lines: [[{ start: 0, end: 1, color }]] } });
    assert.equal((await next).lines[0][0].end, 1);
    second.release();
    assert.equal(worker.terminated, 1, "the last lease release retires the worker");
  } finally { first.release(); second.release(); }
});

test("a timed-out scheme is quarantined only temporarily and editing clears it", async () => {
  let clock = 0;
  const workers = [];
  const createWorker = () => {
    const worker = { posted: [], terminated: 0, onmessage: null, onerror: null,
      postMessage(data) { worker.posted.push(data); }, terminate() { worker.terminated++; } };
    workers.push(worker); return worker;
  };
  const runner = createRegexRunner({ createWorker, timeoutMs: 20, startupMs: 100, quarantineMs: 50, now: () => clock });
  const lease = runner.acquire();
  const scheme = [{ id: "custom:bad" }];
  try {
    const bad = lease.match(scheme, ["x"]);
    await wait(0);
    workers[0].onmessage({ data: { ready: true } });
    await wait(0);
    await wait(40);
    assert.equal((await bad).error, "regex-timeout");
    assert.equal((await lease.match(scheme, ["x"])).error, "regex-timeout", "quarantine is immediate while valid");
    clock += 51;
    const retry = lease.match(scheme, ["x"]);
    await wait(0);
    const worker = workers.at(-1);
    worker.onmessage({ data: { ready: true } });
    await wait(0);
    assert.ok(worker.posted.length > 0, "an expired quarantine lets the scheme run again");
    worker.onmessage({ data: { id: worker.posted.at(-1).id, lines: [[{ start: 0, end: 1, color }]] } });
    assert.equal((await retry).lines[0][0].end, 1);
    const fresh = lease.match(scheme, ["x"]);
    await wait(0);
    workers.at(-1).onmessage({ data: { ready: true } });
    await wait(0);
    workers.at(-1).onmessage({ data: { id: workers.at(-1).posted.at(-1).id, lines: [[]] } });
    await fresh;
    lease.clearQuarantine();
    const cleared = lease.match(scheme, ["x"]);
    await wait(0);
    workers.at(-1).onmessage({ data: { ready: true } });
    await wait(0);
    assert.ok(workers.at(-1).posted.length > 0, "clearQuarantine removes the block");
    workers.at(-1).onmessage({ data: { id: workers.at(-1).posted.at(-1).id, lines: [[]] } });
    await cleared;
  } finally { lease.release(); }
});

test("scan failures back off instead of clearing and rescanning every 60 ms", async () => {
  const { term } = stubTerm();
  let clock = 1_000;
  const matcher = { match: async () => ({ error: "regex-timeout" }), release() {}, clearQuarantine() {} };
  const addon = new OutputHighlightAddon({ acquireMatcher: () => matcher, coalesceMs: 1, viewportPollMs: 10_000, now: () => clock });
  const warned = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warned.push(args.join(" "));
  addon.activate(term);
  try {
    await wait(15);
    assert.equal(addon.lastError, "regex-timeout");
    assert.ok(addon.retryAt > clock, "the addon backs off after a failure");
    assert.equal(warned.length, 1, "the cause is reported once, not every cycle");
    addon.request();
    assert.equal(addon.timer, undefined, "no scan is scheduled during the backoff window");
    clock = addon.retryAt + 1;
    addon.request();
    assert.notEqual(addon.timer, undefined, "scanning resumes after the backoff");
  } finally { addon.dispose(); console.warn = originalWarn; }
});

test("a released, wedged job does not strand or mislabel the next terminal's scan", async () => {
  const workers = [];
  const createWorker = () => {
    const worker = { posted: [], terminated: 0, onmessage: null, onerror: null,
      postMessage(data) { worker.posted.push(data); }, terminate() { worker.terminated++; } };
    workers.push(worker); return worker;
  };
  const runner = createRegexRunner({ createWorker, timeoutMs: 30, startupMs: 100 });
  const first = runner.acquire(), second = runner.acquire();
  try {
    const abandoned = first.match([{ id: "a" }], ["A"]);
    await wait(0);
    workers[0].onmessage({ data: { ready: true } });
    await wait(0);
    assert.equal(workers[0].posted.length, 1);
    first.release();
    assert.equal((await abandoned).cancelled, true);
    assert.equal(workers[0].terminated, 0, "release alone keeps the warm worker");
    const innocent = second.match([{ id: "b" }], ["B"]);
    await wait(0);
    await wait(70); // the abandoned scheme never answers: the watchdog recycles the worker
    assert.equal(workers[0].terminated, 1, "a wedged abandoned job retires the worker");
    const replacement = workers.at(-1);
    assert.notEqual(replacement, workers[0]);
    replacement.onmessage({ data: { ready: true } });
    await wait(0);
    assert.ok(replacement.posted.length >= 1, "the innocent job is retried on a fresh worker");
    replacement.onmessage({ data: { id: replacement.posted.at(-1).id, lines: [[{ start: 0, end: 1, color }]] } });
    assert.equal((await innocent).lines[0][0].end, 1, "the innocent scheme is not quarantined");
  } finally { first.release(); second.release(); }
});

test("a released owner's late reply keeps the warm worker shared", async () => {
  const workers = [];
  const createWorker = () => {
    const worker = { posted: [], terminated: 0, onmessage: null, onerror: null,
      postMessage(data) { worker.posted.push(data); }, terminate() { worker.terminated++; } };
    workers.push(worker); return worker;
  };
  const runner = createRegexRunner({ createWorker, timeoutMs: 40, startupMs: 100 });
  const first = runner.acquire(), second = runner.acquire();
  try {
    const abandoned = first.match([{ id: "a" }], ["A"]);
    await wait(0);
    const worker = workers[0];
    worker.onmessage({ data: { ready: true } });
    await wait(0);
    first.release();
    assert.equal((await abandoned).cancelled, true);
    worker.onmessage({ data: { id: worker.posted[0].id, lines: [[{ start: 0, end: 1, color }]] } });
    const next = second.match([{ id: "b" }], ["B"]);
    await wait(0);
    assert.equal(workers.length, 1, "the late reply cancels the watchdog");
    assert.equal(worker.terminated, 0);
    assert.equal(worker.posted.length, 2, "the warm worker serves the next terminal");
    worker.onmessage({ data: { id: worker.posted[1].id, lines: [[{ start: 0, end: 1, color }]] } });
    assert.equal((await next).lines[0][0].end, 1);
    await wait(60);
    assert.equal(worker.terminated, 0, "no spurious retirement after the late reply");
  } finally { first.release(); second.release(); }
});

test("editing the scheme clears a failure backoff immediately", async () => {
  const { term } = stubTerm();
  let clock = 1_000;
  const matcher = { match: async () => ({ error: "regex-timeout" }), release() {}, clearQuarantine() {} };
  const addon = new OutputHighlightAddon({ acquireMatcher: () => matcher, coalesceMs: 1, viewportPollMs: 10_000, now: () => clock });
  addon.activate(term);
  try {
    await wait(15);
    assert.ok(addon.retryAt > clock, "a failed scan backs off");
    addon.syncDisplay();
    assert.equal(addon.retryAt, 0, "an explicit scheme edit resets the backoff");
    assert.equal(addon.retryIndex, 0);
  } finally { addon.dispose(); }
});

test("multiple released wedged jobs blame their own schemes, not the next terminal", async () => {
  const workers = [];
  const createWorker = () => {
    const worker = { posted: [], terminated: 0, onmessage: null, onerror: null,
      postMessage(data) { worker.posted.push(data); }, terminate() { worker.terminated++; } };
    workers.push(worker); return worker;
  };
  const runner = createRegexRunner({ createWorker, timeoutMs: 30, startupMs: 100 });
  const first = runner.acquire(), second = runner.acquire(), third = runner.acquire();
  try {
    const pa = first.match([{ id: "a" }], ["A"]);
    await wait(0);
    workers[0].onmessage({ data: { ready: true } });
    await wait(0);
    first.release();
    assert.equal((await pa).cancelled, true);
    const pb = second.match([{ id: "b" }], ["B"]);
    await wait(0);
    second.release();
    assert.equal((await pb).cancelled, true);
    const innocent = third.match([{ id: "c" }], ["C"]);
    await wait(0);
    await wait(70); // both watchdogs are due; only the wedged schemes are blamed
    const replacement = workers.at(-1);
    assert.notEqual(replacement, workers[0], "the wedged worker is recycled");
    replacement.onmessage({ data: { ready: true } });
    await wait(0);
    replacement.onmessage({ data: { id: replacement.posted.at(-1).id, lines: [[{ start: 0, end: 1, color }]] } });
    assert.equal((await innocent).lines[0][0].end, 1, "the never-run scheme is not quarantined");
    const retry = third.match([{ id: "c" }], ["C"]);
    await wait(0);
    assert.ok(replacement.posted.length >= 2, "the never-run scheme stays usable");
    replacement.onmessage({ data: { id: replacement.posted.at(-1).id, lines: [[]] } });
    await retry;
  } finally { first.release(); second.release(); third.release(); }
});
