// Session log store: append/read/paging, the per-session byte cap, search with
// offsets, listing order, deletion and the total-budget prune — all against a
// real temp directory.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import SshOpsService from "../src/index.js";
import { SESSION_LOG_LIMITS, SessionLogStore } from "../src/session-log.js";

const dir = mkdtempSync(join(tmpdir(), "dsh-ssh-ops-logs-"));
const store = new SessionLogStore({ dir, limits: { maxSessionBytes: 64, maxTotalBytes: 200 } });

try {
  // ── append, read, paging ──────────────────────────────────────────────────
  await store.begin({ sessionId: "s1", connectionId: "c1", name: "web-1", host: "10.0.0.1", port: 22, openedBy: "panel" });
  store.append("s1", "$ uname -a\n");
  store.append("s1", "Linux web-1 6.8.0\n");
  const meta = await store.read("s1", { offset: 0, maxBytes: 1024 });
  assert.equal(meta.ok, true);
  assert.equal(meta.data, "$ uname -a\nLinux web-1 6.8.0\n");
  assert.equal(meta.eof, true);
  assert.equal(meta.nextOffset, meta.size);

  const page = await store.read("s1", { offset: 0, maxBytes: 5 });
  assert.equal(page.data, "$ una");
  assert.equal(page.eof, false);
  const rest = await store.read("s1", { offset: page.nextOffset, maxBytes: 4096 });
  assert.equal(rest.data, "me -a\nLinux web-1 6.8.0\n");

  const missing = await store.read("nope", {});
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "no-such-log");

  // ── per-session cap ───────────────────────────────────────────────────────
  const capped = new SessionLogStore({ dir, limits: { maxSessionBytes: 16 } });
  await capped.begin({ sessionId: "s-cap", host: "h" });
  capped.append("s-cap", "abcdefghij");           // 10 bytes
  capped.append("s-cap", "klmnopqrst");           // +10 → capped at 16
  capped.append("s-cap", "ignored-forever");      // dropped
  const capRead = await capped.read("s-cap", {});
  assert.equal(capRead.data.length, 16, "the log stops exactly at the cap");
  const capMeta = (await capped.list()).find((entry) => entry.sessionId === "s-cap");
  assert.equal(capMeta.bytes, 16);
  assert.equal(capMeta.truncated, true, "truncation is recorded so the panel can say so");
  capped.append("s-cap", "more");
  assert.equal((await capped.read("s-cap", {})).data.length, 16, "nothing is appended after truncation");

  // ── end + list order ──────────────────────────────────────────────────────
  const ended = await store.end("s1", { exitCode: 0 });
  assert.equal(ended.exitCode, 0);
  assert.ok(ended.endedAt !== null);
  await store.begin({ sessionId: "s2", connectionId: "c1", name: "web-2", host: "10.0.0.2", port: 22, openedBy: "agent", startedAt: "2030-01-01T00:00:00.000Z" });
  store.append("s2", "later session\n");
  await store.end("s2", { exitCode: 1 });

  const listed = await store.list();
  const ids = listed.map((entry) => entry.sessionId);
  assert.ok(ids.indexOf("s2") < ids.indexOf("s1"), "the list is newest-first");
  const s1 = listed.find((entry) => entry.sessionId === "s1");
  assert.equal(s1.host, "10.0.0.1");
  assert.equal(s1.exitCode, 0);
  assert.equal(s1.endedAt !== null, true);

  // A half-written sidecar is skipped instead of breaking the listing.
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dir, "broken.json"), "{not json", "utf8");
  assert.equal((await store.list()).length >= 2, true);

  // ── search ────────────────────────────────────────────────────────────────
  await store.begin({ sessionId: "s3", host: "h" });
  store.append("s3", "first line\nERROR: disk almost full\nplain\nanother error here\n");
  await store.end("s3");
  const hits = await store.search("s3", { query: "error" });
  assert.equal(hits.ok, true);
  assert.equal(hits.hits.length, 2, "search is case-insensitive and reports every hit");
  assert.match(hits.hits[0].line, /ERROR: disk almost full/);
  const atSecond = await store.read("s3", { offset: hits.hits[1].offset, maxBytes: 64 });
  assert.match(atSecond.data, /^another error here/, "a hit offset reads back to its line start");

  assert.deepEqual((await store.search("s3", { query: "   " })).hits, []);
  assert.equal((await store.search("s3", { query: "ERROR", maxHits: 1 })).stoppedEarly, true);
  assert.equal((await store.search("nope", { query: "x" })).ok, false);

  // ── delete + prune ────────────────────────────────────────────────────────
  assert.ok(readFileSync(join(dir, "s3.log"), "utf8").includes("disk almost full"), "appends land on disk while recording");
  assert.deepEqual(await store.remove("s3"), { ok: true, deleted: true });
  assert.equal((await store.list()).some((entry) => entry.sessionId === "s3"), false);
  assert.throws(() => readFileSync(join(dir, "s3.log"), "utf8"), /ENOENT/, "removing a session deletes its log file");

  // Budget: the newest recording survives even when it alone exceeds the cap.
  const pruned = await store.prune();
  assert.equal(pruned.ok, true);
  assert.ok(pruned.totalBefore >= pruned.totalAfter);
  assert.ok((await store.list()).length >= 1);
  const all = await store.removeAll();
  assert.equal(all.ok, true);
  assert.deepEqual(await store.list(), []);

  assert.equal(SESSION_LOG_LIMITS.maxSessionBytes, 8 * 1024 * 1024);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ── service layer: the RPCs over the store, plus the wiring contract ───────
{
  const svcDir = mkdtempSync(join(tmpdir(), "dsh-ssh-ops-logs-svc-"));
  try {
    const service = Object.create(SshOpsService.prototype);
    service.config = { sessionLogEnabled: true, sessionLogDir: svcDir };
    service.ctx = {};

    const store = service.sessionLogStore();
    await store.begin({ sessionId: "live-1", connectionId: "c1", name: "web-1", host: "10.0.0.1", port: 22, openedBy: "panel" });
    store.append("live-1", "hello\nERROR nope\n");

    const listed = await service.sessionLogList();
    assert.equal(listed.ok, true);
    assert.equal(listed.value.enabled, true);
    assert.equal(listed.value.logs.length, 1);
    assert.equal(listed.value.logs[0].bytes, 17, "a live session reports its current byte count");
    assert.equal(listed.value.logs[0].endedAt, null);

    const read = await service.sessionLogRead({ sessionId: "live-1", offset: 0, maxBytes: 64 });
    assert.equal(read.ok, true);
    assert.equal(read.value.data, "hello\nERROR nope\n");
    assert.equal(read.value.eof, true);

    const search = await service.sessionLogSearch({ sessionId: "live-1", query: "error" });
    assert.equal(search.ok, true);
    assert.equal(search.value.hits.length, 1);
    assert.match(search.value.hits[0].line, /ERROR nope/);

    const missingRead = await service.sessionLogRead({ sessionId: "nope", offset: 0 });
    assert.equal(missingRead.ok, false);
    assert.equal(missingRead.error.code, "no-session-log");

    const removed = await service.sessionLogDelete({ sessionId: "live-1" });
    assert.deepEqual(removed.value, { deleted: 1, remaining: 0 });

    const disabled = Object.create(SshOpsService.prototype);
    disabled.config = { sessionLogEnabled: false };
    disabled.ctx = {};
    assert.deepEqual(await disabled.sessionLogList(), { ok: true, value: { enabled: false, logs: [] } });
    assert.equal((await disabled.sessionLogRead({ sessionId: "x" })).error.code, "session-log-disabled");
    assert.equal(disabled.sessionLogStore(), null);
  } finally {
    rmSync(svcDir, { recursive: true, force: true });
  }
}

// ── wiring contract: the service and the panel expose exactly these hooks ──
{
  const index = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
  const panel = await readFile(new URL("../src/client/SshPanel.jsx", import.meta.url), "utf8");
  const logs = await readFile(new URL("../src/client/SshLogs.jsx", import.meta.url), "utf8");
  const api = await readFile(new URL("../src/client/api.js", import.meta.url), "utf8");
  const tools = await readFile(new URL("../src/tools/session-log.js", import.meta.url), "utf8");
  const checks = [
    [index, /sessionLogStore\(\)\?\.append\(session\.id, text\)/, "every session chunk is appended to its log"],
    [index, /sessionLogStore\(\)\?\.begin\(\{[\s\S]{0,240}sessionId, connectionId: request\.connectionId/, "opening a shell begins a log"],
    [index, /void this\.sessionLogStore\(\)\?\.end\(session\.id, \{ exitCode: exit\?\.code \?\? null \}\)/, "a natural exit closes the log with its code"],
    [index, /sessionLogEnabled: true/, "recording is on by default"],
    [panel, /setTab\("logs"\)/, "the SSH panel exposes the log tab"],
    [panel, /<SshLogs api=\{api\} \/>/, "the log tab renders the log panel"],
    [logs, /PAGE_BYTES = 48 \* 1024/, "the viewer pages instead of loading a whole log"],
    [logs, /api\.sessionLogSearch\(selected\.sessionId, query\.trim\(\), 200\)/, "search runs through the host"],
    [api, /sessionLogRead\(sessionId, offset, maxBytes\)/, "the api wrapper forwards paging arguments"],
    [tools, /redactForModel\(result\.value\.data\)/, "agent reads are redacted"],
    [tools, /kind: "ask"/, "agent log reads ask the operator first"]
  ];
  for (const [source, pattern, label] of checks) {
    assert.match(source, pattern, `wiring contract: ${label}`);
  }
}

console.log("session log: append/read/paging, caps, search offsets, listing, delete, prune, RPCs and wiring all passed");
