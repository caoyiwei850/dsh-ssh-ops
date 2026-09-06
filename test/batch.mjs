import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import SshOpsService from "../src/index.js";

const service = Object.create(SshOpsService.prototype);
service.config = { maxCommandOutputBytes: 128 };
service.batchTasks = new Map();

// ── batchPlan: safe vs dangerous, trimming, storage ──
{
  const safe = service.batchPlan({ command: "free -h" });
  assert.equal(safe.ok, true);
  assert.equal(safe.value.task.dangerous, false);
  assert.equal(safe.value.task.reason, null);
  assert.equal(safe.value.task.command, "free -h");
  assert.equal(service.batchTasks.size, 1);

  const danger = service.batchPlan({ command: "rm -rf /" });
  assert.equal(danger.ok, true);
  assert.equal(danger.value.task.dangerous, true);
  assert.ok(danger.value.task.reason, "dangerous task carries a reason");
  assert.equal(service.batchTasks.size, 2);

  const trimmed = service.batchPlan({ command: "  df -h  " });
  assert.equal(trimmed.value.task.command, "df -h", "command is trimmed");
  assert.equal(service.batchTasks.size, 3);

  const clampedLow = service.batchPlan({ command: "whoami", timeoutMs: 5 });
  assert.equal(clampedLow.value.task.timeoutMs, 1000, "timeout is clamped to the 1s floor");
  const clampedHigh = service.batchPlan({ command: "whoami", timeoutMs: 999999 });
  assert.equal(clampedHigh.value.task.timeoutMs, 120000, "timeout is clamped to the 120s ceiling");
  assert.equal(service.batchTasks.size, 5);
}

// ── batchTaskList ──
{
  const { tasks } = service.batchTaskList().value;
  assert.equal(tasks.length, 5);
}

// ── batchCancel: deletes once, then reports false ──
{
  const [first] = service.batchTaskList().value.tasks;
  assert.equal(service.batchCancel({ batchId: first.batchId }).value.cancelled, true);
  assert.equal(service.batchTasks.size, 4);
  assert.equal(service.batchCancel({ batchId: first.batchId }).value.cancelled, false);
}

// ── batchRun validation: missing task / no targets (does not consume the task) ──
{
  const missing = await service.batchRun({ batchId: "nope", profileIds: ["p1"] });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "batch-missing");

  const task = service.batchPlan({ command: "free -h" }).value.task;
  const noTargets = await service.batchRun({ batchId: task.batchId, profileIds: [] });
  assert.equal(noTargets.ok, false);
  assert.equal(noTargets.error.code, "batch-no-targets");
  assert.equal(service.batchTasks.has(task.batchId), true, "validation failure must not consume the task");
}

// ── batchRun: concurrent execution over selected profiles, task consumed ──
{
  const calls = [];
  service.runCommandOnProfile = async (profileId, command, timeoutMs) => {
    calls.push({ profileId, command, timeoutMs });
    return { ok: true, value: { profileId, name: `svr-${profileId}`, host: `10.0.0.${profileId}`, exitCode: 0, stdout: "ok", stderr: "", truncated: false, timedOut: false } };
  };
  const task = service.batchPlan({ command: "df -h", timeoutMs: 15000 }).value.task;
  const r = await service.batchRun({ batchId: task.batchId, profileIds: ["1", "2"] });
  assert.equal(r.ok, true);
  assert.equal(r.value.results.length, 2);
  assert.equal(calls.length, 2, "one exec per selected profile");
  assert.equal(calls[0].command, "df -h");
  assert.equal(calls[0].timeoutMs, 15000, "task timeout is forwarded");
  assert.equal(r.value.results[0].name, "svr-1");
  assert.equal(r.value.results[0].ok, true);
  assert.equal(service.batchTasks.has(task.batchId), false, "task is consumed on run");
}

// ── batchRun: per-server failure is surfaced in results, not thrown ──
{
  service.runCommandOnProfile = async (profileId) => {
    if (profileId === "bad") return { ok: false, error: { message: "connection refused" } };
    return { ok: true, value: { profileId, name: "good", host: "h", exitCode: 0, stdout: "", stderr: "", truncated: false, timedOut: false } };
  };
  const task = service.batchPlan({ command: "date" }).value.task;
  const r = await service.batchRun({ batchId: task.batchId, profileIds: ["good", "bad"] });
  const bad = r.value.results.find((x) => x.profileId === "bad");
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "connection refused");
  const good = r.value.results.find((x) => x.profileId === "good");
  assert.equal(good.ok, true);
}

// ── batchRun: concurrency is capped so N targets never open N simultaneous SSH sessions ──
{
  let inFlight = 0;
  let maxInFlight = 0;
  service.runCommandOnProfile = async (profileId) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return { ok: true, value: { profileId, name: profileId, host: "h", exitCode: 0, stdout: "", stderr: "", truncated: false, timedOut: false } };
  };
  const task = service.batchPlan({ command: "uptime" }).value.task;
  const targets = Array.from({ length: 12 }, (_, i) => `p${i}`);
  const r = await service.batchRun({ batchId: task.batchId, profileIds: targets });
  assert.equal(r.ok, true);
  assert.equal(r.value.results.length, 12);
  assert.deepEqual(r.value.results.map((x) => x.profileId), targets, "results keep the requested target order");
  assert.ok(maxInFlight <= 4, `at most 4 concurrent execs (saw ${maxInFlight})`);
}

// ── runCommandOnProfile: connect → exec → disconnect lifecycle ──
{
  delete service.runCommandOnProfile; // restore the prototype method (mocked by batchRun tests above)
  service.requireProfileTable = () => new Map([
    ["p1", { name: "web-1", host: "10.0.0.1", username: "root" }],
    ["offline", { name: "off-box", host: "10.0.0.9", username: "root" }]
  ]);
  const disconnected = [];
  const ran = [];
  service.profileConnect = async ({ profileId }) => {
    if (profileId === "offline") return { ok: false, error: { message: "unreachable" } };
    return { ok: true, value: { connectionId: `conn-${profileId}` } };
  };
  service.connections = new Map([["conn-p1", { client: {} }]]);
  service.execRawOnClient = async (client, command, timeoutMs) => {
    ran.push({ command, timeoutMs });
    return { ok: true, value: { exitCode: 0, stdout: "hello", stderr: "", truncated: false, timedOut: false } };
  };
  service.disconnect = async ({ connectionId }) => { disconnected.push(connectionId); return { ok: true, value: { disconnected: true } }; };

  const noProfile = await service.runCommandOnProfile("missing", "echo hi");
  assert.equal(noProfile.ok, false);
  assert.equal(noProfile.error.code, "no-profile");
  assert.equal(disconnected.length, 0, "missing profile never connects or disconnects");

  const offline = await service.runCommandOnProfile("offline", "echo hi");
  assert.equal(offline.ok, false);
  assert.equal(offline.error.message, "unreachable", "connect failure is returned as-is");

  const ok = await service.runCommandOnProfile("p1", "echo hi", 5000);
  assert.equal(ok.ok, true);
  assert.equal(ok.value.profileId, "p1");
  assert.equal(ok.value.name, "web-1");
  assert.equal(ok.value.host, "10.0.0.1");
  assert.equal(ok.value.stdout, "hello");
  assert.deepEqual(ran, [{ command: "echo hi", timeoutMs: 5000 }]);
  assert.deepEqual(disconnected, ["conn-p1"], "profile is disconnected after exec");

  service.execRawOnClient = async () => { throw new Error("boom"); };
  const failed = await service.runCommandOnProfile("p1", "echo hi");
  assert.equal(failed.ok, false);
  assert.equal(failed.error.message, "boom");
  assert.deepEqual(disconnected, ["conn-p1", "conn-p1"], "finally block still disconnects on exec failure");
}

// ── execRawOnClient: stream collection, exit code, timeout, exec error ──
{
  delete service.execRawOnClient; // restore the prototype method (mocked above)
  const makeClient = () => {
    const stream = new EventEmitter();
    stream.stderr = new EventEmitter();
    stream.close = () => stream.emit("close", null);
    return { stream, client: { exec(command, opts, cb) { cb(null, stream); } } };
  };

  // normal: stdout + stderr collected, close code captured
  {
    const { stream, client } = makeClient();
    const p = service.execRawOnClient(client, "echo hi", 30000);
    // execRawOnClient is async: its listeners attach in a microtask after the
    // first await, so yield once before emitting or the events are dropped.
    await new Promise((r) => setImmediate(r));
    stream.emit("data", Buffer.from("hello"));
    stream.stderr.emit("data", Buffer.from("warn"));
    stream.emit("close", 0);
    const r = await p;
    assert.equal(r.ok, true);
    assert.equal(r.value.exitCode, 0);
    assert.equal(r.value.stdout, "hello");
    assert.equal(r.value.stderr, "warn");
    assert.equal(r.value.timedOut, false);
  }

  // timeout: closes the stream and reports timedOut
  {
    const { client } = makeClient();
    const p = service.execRawOnClient(client, "sleep", 10);
    const r = await p;
    assert.equal(r.ok, true);
    assert.equal(r.value.timedOut, true);
    assert.equal(r.value.exitCode, null, "close(null) is not a numeric exit code");
  }

  // exec callback error → exec-failed
  {
    const badClient = { exec(command, opts, cb) { cb(new Error("exec failed")); } };
    const rb = await service.execRawOnClient(badClient, "x", 30000);
    assert.equal(rb.ok, false);
    assert.equal(rb.error.code, "exec-failed");
  }
}

// ── ssh_batch tool: plans only, never executes directly ──
{
  const registeredTools = [];
  service.registerTools({ tools: { register(tool) { registeredTools.push(tool); } } });
  const batchTool = registeredTools.find((t) => t.name === "ssh_batch");
  assert.ok(batchTool, "ssh_batch tool is registered");
  assert.ok(registeredTools.some((t) => t.name === "ssh_batch"), "ssh_batch tool is registered");
  assert.ok(!registeredTools.some((t) => t.name === "ssh_cluster"), "old ssh_cluster name is gone");
  assert.ok(!registeredTools.some((t) => t.name === "ssh_cluster_deprecated"), "unconfirmed cluster exec is removed entirely");

  let executed = false;
  service.execOnConnection = async () => { executed = true; return { ok: true }; };
  const before = service.batchTasks.size;
  const out = await batchTool.execute({ command: "df -h" });
  assert.equal(out.dangerous, false);
  assert.ok(out.batchId);
  assert.equal(service.batchTasks.size, before + 1, "ssh_batch only plans, never executes");
  assert.equal(executed, false, "ssh_batch must not run the command directly");

  const danger = await batchTool.execute({ command: "rm -rf /tmp/x" });
  assert.equal(danger.dangerous, true);
  assert.ok(danger.reason);

  const card = batchTool.output.render({}, { batchId: "b1", command: "df -h", dangerous: false, reason: null });
  assert.match(card[0].text, /已创建批量任务/);
  assert.match(card[0].text, /勾选服务器/);
  const dangerCard = batchTool.output.render({}, { batchId: "b2", command: "rm -rf /", dangerous: true, reason: "删除文件或目录" });
  assert.match(dangerCard[0].text, /危险命令/);
  assert.match(dangerCard[0].text, /等待操作者在面板确认/);
}

console.log("batch: all tests passed");
