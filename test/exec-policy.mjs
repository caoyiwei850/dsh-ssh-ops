/**
 * Execution policy tiers (0.3.22): standard / custom / allowAll.
 *
 * Layer A exercises the safety module directly: the tier decision must be a
 * pure function of (command, policy) with the historical no-policy call
 * behavior byte-for-byte unchanged. Layer B exercises the service surface:
 * the three-layer resolution (session override > resource field > global
 * setting), the fail-safe default when storage is not ready, the session-only
 * RPC, and the two invariants the design promised — the batch gate stays
 * standard-only regardless of tiers, and no agent tool may write policy.
 */
import assert from "node:assert/strict";
import { assessShellCommand, normalizePolicy, ALL_CATEGORY_KEYS } from "../src/safety.js";
import SshOpsService, { loadSettingsRecord } from "../src/index.js";
import { registerSshSessionTools } from "../src/tools/ssh-session.js";
import { registerBatchTools } from "../src/tools/batch.js";

// ── A. safety layer ─────────────────────────────────────────────────────────

// The legacy one-argument call is the standard policy and must not drift.
assert.equal(assessShellCommand("rm -rf /tmp/x").ok, false);
assert.equal(assessShellCommand("free -h").ok, true);
assert.equal(assessShellCommand("rm -rf /tmp/x", undefined).ok, false, "undefined policy = standard");

// Every deny-list pattern carries a stable machine-readable key.
const keyOf = {
  "rm -rf /tmp/x": "delete-files",
  "find /tmp -delete": "bulk-delete",
  // The rm pattern precedes the xargs one, so the first hit wins the key
  // (historical display behavior); the scanning-continues rule below proves
  // the xargs pattern still gates this line in the custom tier.
  "ls /tmp | xargs rm -f": "delete-files",
  "python3 -c \"import os; os.remove('/tmp/x')\"": "bulk-delete",
  "DROP DATABASE production": "db-destroy",
  "DELETE FROM users": "db-destroy",
  "truncate -s 0 /var/log/app.log": "db-destroy",
  "mkfs.ext4 /dev/sdb": "disk-format",
  "dd if=/dev/zero of=/dev/sda": "disk-format",
  "docker system prune -af": "docker-destroy",
  // Same first-hit rule: the bare rm pattern precedes the docker one; the
  // docker-destroy pattern still gates this line via scanning-continues.
  "docker rm -f web": "delete-files",
  "kubectl delete namespace production": "deploy-destroy",
  "terraform destroy": "deploy-destroy",
  "git reset --hard": "git-destructive",
  "git clean -fd": "git-destructive",
  "reboot": "reboot-shutdown",
  "shutdown -h now": "reboot-shutdown"
};
for (const [command, key] of Object.entries(keyOf)) {
  const decision = assessShellCommand(command);
  assert.equal(decision.ok, false, `expected blocked: ${command}`);
  assert.equal(decision.categoryKey, key, `categoryKey mismatch for: ${command}`);
}
assert.deepEqual([...ALL_CATEGORY_KEYS].sort(), [
  "bulk-delete", "db-destroy", "delete-files", "deploy-destroy",
  "disk-format", "docker-destroy", "git-destructive", "reboot-shutdown"
]);

// allowAll clears every pattern.
for (const command of Object.keys(keyOf)) {
  assert.equal(assessShellCommand(command, { mode: "allowAll", allow: [] }).ok, true, `allowAll must pass: ${command}`);
}

// custom: empty allow set behaves exactly like standard.
assert.equal(assessShellCommand("rm -rf /tmp/x", { mode: "custom", allow: [] }).ok, false);
assert.equal(assessShellCommand("shutdown -h now", { mode: "custom", allow: [] }).ok, false);

// custom: allowing one category passes only that category's patterns.
const rebootOnly = { mode: "custom", allow: ["reboot-shutdown"] };
assert.equal(assessShellCommand("reboot", rebootOnly).ok, true);
assert.equal(assessShellCommand("shutdown -h now", rebootOnly).ok, true);
assert.equal(assessShellCommand("rm -rf /tmp/x", rebootOnly).ok, false, "other categories stay blocked");
assert.equal(assessShellCommand("docker system prune -af", rebootOnly).ok, false);

// custom: a released category must not stop later patterns in the same line
// from matching an unreleased one.
const deleteOnly = { mode: "custom", allow: ["delete-files"] };
assert.equal(assessShellCommand("rm -rf /tmp/build; docker system prune -af", deleteOnly).ok, false, "compound line hits an unreleased category after a released one");
assert.equal(assessShellCommand("ls /tmp | xargs rm -f", deleteOnly).ok, false, "batch deletion stays gated by bulk-delete even when plain rm is released");

// custom: allowing everything equals allowAll for the sample set.
assert.equal(
  assessShellCommand("mkfs.ext4 /dev/sdb", { mode: "custom", allow: [...ALL_CATEGORY_KEYS] }).ok,
  true
);

// normalizePolicy hardens untrusted input into a safe policy.
assert.deepEqual(normalizePolicy(null), { mode: "standard", allow: [] });
assert.deepEqual(normalizePolicy(undefined), { mode: "standard", allow: [] });
assert.deepEqual(normalizePolicy("nonsense"), { mode: "standard", allow: [] });
assert.deepEqual(normalizePolicy({ mode: "nonsense", allow: [] }), { mode: "standard", allow: [] });
assert.deepEqual(normalizePolicy({ mode: "custom", allow: ["nope", "reboot-shutdown"] }), { mode: "custom", allow: ["reboot-shutdown"] }, "unknown keys are dropped");
assert.deepEqual(normalizePolicy({ mode: "custom", allow: "not-an-array" }), { mode: "custom", allow: [] });
assert.deepEqual(normalizePolicy({ mode: "allowAll", allow: ["reboot-shutdown"] }), { mode: "allowAll", allow: [] }, "allowAll ignores the allow set");

// ── B. service layer ────────────────────────────────────────────────────────

const service = Object.create(SshOpsService.prototype);
service.config = { maxCommandOutputBytes: 128 };
service.batchTasks = new Map();
service.connections = new Map();
service.profileTable = null; // storage not ready: resolution must fail safe
service.execPolicy = "standard";
service.execPolicyAllow = [];

// loadSettingsRecord: new fields parse, old records keep loading.
{
  const fresh = loadSettingsRecord({});
  assert.equal(fresh.execPolicy, "standard", "absent tier = standard");
  assert.deepEqual(fresh.execPolicyAllow, [], "absent allow set = empty");

  const stored = loadSettingsRecord({ execPolicy: "custom", execPolicyAllow: ["reboot-shutdown"] });
  assert.equal(stored.execPolicy, "custom");
  assert.deepEqual(stored.execPolicyAllow, ["reboot-shutdown"]);

  const broken = loadSettingsRecord({ execPolicy: "yolo", execPolicyAllow: "oops" });
  assert.equal(broken.execPolicy, "standard", "invalid tier falls back to standard");
  assert.deepEqual(broken.execPolicyAllow, [], "invalid allow set falls back to empty");

  // The tier never erases the checklist: an operator on "standard" (or
  // "allowAll") who once ticked categories gets them back when they switch to
  // the custom tier, and a restart must not silently empty the list.
  const standardWithChecklist = loadSettingsRecord({ execPolicy: "standard", execPolicyAllow: ["reboot-shutdown"] });
  assert.equal(standardWithChecklist.execPolicy, "standard");
  assert.deepEqual(standardWithChecklist.execPolicyAllow, ["reboot-shutdown"], "the tier does not clear the checklist");
  const allowAllWithChecklist = loadSettingsRecord({ execPolicy: "allowAll", execPolicyAllow: ["reboot-shutdown", "nope"] });
  assert.equal(allowAllWithChecklist.execPolicy, "allowAll");
  assert.deepEqual(allowAllWithChecklist.execPolicyAllow, ["reboot-shutdown"], "unknown keys are still dropped");
}

// resolveExecPolicy: default chain with no storage.
{
  assert.deepEqual(service.resolveExecPolicy("conn-a"), { mode: "standard", source: "default", allow: [] });
}

// resolveExecPolicy: global setting is picked up when no profile exists.
{
  service.execPolicy = "allowAll";
  assert.deepEqual(service.resolveExecPolicy("conn-a"), { mode: "allowAll", source: "global", allow: [] });
}

// resolveExecPolicy: profile override beats global.
const conn = { profileId: "profile-1" };
{
  service.profileTable = {
    get: (id) => (id === "profile-1" ? { execPolicy: "standard" } : undefined)
  };
  service.connections.set("conn-b", conn);
  assert.deepEqual(service.resolveExecPolicy("conn-b"), { mode: "standard", source: "profile", allow: [] });
}

// resolveExecPolicy: session override beats profile and global; unknown id and
// missing connection fall back to the global/default chain.
{
  conn.execPolicyOverride = "allowAll";
  assert.deepEqual(service.resolveExecPolicy("conn-b"), { mode: "allowAll", source: "session", allow: [] });
  conn.execPolicyOverride = undefined;
  assert.deepEqual(service.resolveExecPolicy("unknown-conn"), { mode: "allowAll", source: "global", allow: [] });
}

// The seam this feature first shipped without: the RESOLVED policy object is
// what the decision function receives, so the released-category list must ride
// along on every branch. Testing assessShellCommand with a hand-built
// {mode, allow} object and resolveExecPolicy's shape separately left the wire
// between them unasserted, and the custom tier silently became a no-op: the
// panel announced "released" while the gate kept blocking.
{
  const savedPolicy = service.execPolicy;
  const savedAllow = service.execPolicyAllow;
  service.execPolicy = "custom";
  service.execPolicyAllow = ["reboot-shutdown"];

  // Unknown connection id → the global layer, checklist included.
  const resolved = service.resolveExecPolicy("conn-a");
  assert.deepEqual(resolved, { mode: "custom", source: "global", allow: ["reboot-shutdown"] });
  assert.equal(assessShellCommand("reboot", resolved).ok, true, "the released category is actually released");
  assert.equal(assessShellCommand("rm -rf /tmp/x", resolved).ok, false, "an unreleased category stays blocked");

  // Same wire, session layer: the tier comes from the pill, the list still must
  // arrive intact.
  service.connections.set("conn-c", { profileId: null, execPolicyOverride: "custom" });
  const sessionResolved = service.resolveExecPolicy("conn-c");
  assert.equal(sessionResolved.source, "session");
  assert.deepEqual(sessionResolved.allow, ["reboot-shutdown"]);
  assert.equal(assessShellCommand("reboot", sessionResolved).ok, true, "session layer keeps the checklist too");

  // The tier can be switched per session while the GLOBAL tier sits on
  // standard: the checklist is one operator-maintained list, so a session
  // switched to custom must release exactly what the operator ticked instead
  // of an empty set produced by the global tier.
  service.execPolicy = "standard";
  service.connections.set("conn-s", { profileId: null, execPolicyOverride: "custom" });
  const sessionOnly = service.resolveExecPolicy("conn-s");
  assert.deepEqual(sessionOnly, { mode: "custom", source: "session", allow: ["reboot-shutdown"] });
  assert.equal(assessShellCommand("reboot", sessionOnly).ok, true, "a session custom switch releases the stored checklist");
  assert.equal(assessShellCommand("rm -rf /tmp/x", sessionOnly).ok, false, "and nothing else");
  service.connections.delete("conn-s");
  service.connections.delete("conn-c");

  service.execPolicy = savedPolicy;
  service.execPolicyAllow = savedAllow;
}

// execPolicyGet mirrors the resolution plus the raw settings for the UI.
{
  service.execPolicy = "custom";
  service.execPolicyAllow = ["reboot-shutdown"];
  const got = service.execPolicyGet({ connectionId: "conn-b" });
  assert.equal(got.ok, true);
  assert.equal(got.value.effective, "standard");
  assert.equal(got.value.source, "profile");
  assert.deepEqual(got.value.allow, ["reboot-shutdown"]);
  assert.deepEqual(got.value.global, { policy: "custom", allow: ["reboot-shutdown"] });
  assert.equal(got.value.profileOverride, "standard");
}

// execPolicySet: session-scoped, in-memory only, validated.
{
  const saved = service.execPolicySet({ connectionId: "conn-b", policy: "allowAll" });
  assert.equal(saved.ok, true);
  assert.equal(saved.value.effective, "allowAll");
  assert.equal(saved.value.source, "session");
  assert.equal(conn.execPolicyOverride, "allowAll");
  assert.equal(service.execPolicy, "custom", "the global setting is untouched");

  const invalid = service.execPolicySet({ connectionId: "conn-b", policy: "yolo" });
  assert.equal(invalid.ok, false, "invalid tier rejected");
  const missing = service.execPolicySet({ connectionId: "no-such", policy: "allowAll" });
  assert.equal(missing.ok, false, "unknown connection rejected");

  // Standard is a valid session target: it overrides too, so a deliberately
  // tightened session cannot be widened by a looser profile/global layer.
  const back = service.execPolicySet({ connectionId: "conn-b", policy: "standard" });
  assert.equal(back.ok, true);
  assert.equal(back.value.effective, "standard");
  assert.equal(back.value.source, "session", "the session choice sticks until reconnect");
}

// The batch gate is tier-independent: even under allowAll a destructive
// command is still flagged dangerous for operator confirmation.
{
  service.execPolicy = "allowAll";
  service.connections.get("conn-b").execPolicyOverride = "allowAll";
  const danger = service.batchPlan({ command: "rm -rf /data" });
  assert.equal(danger.ok, true);
  assert.equal(danger.value.task.dangerous, true, "batch marking never relaxes with tiers");
  const safe = service.batchPlan({ command: "free -h" });
  assert.equal(safe.value.task.dangerous, false);
}

// execOnConnection carries the effective tier on a structured rejection, and
// under allowAll the command runs (runPreparedExec mocked out).
{
  service.execPolicy = "standard";
  service.connections.get("conn-b").execPolicyOverride = "standard";
  service.profileTable = {
    get: (id) => (id === "profile-1" ? { execPolicy: "custom", /* no allow set on profiles by design */ } : undefined)
  };
  const blocked = await service.execOnConnection("conn-b", "rm -rf /tmp/x");
  assert.equal(blocked.value.blocked, true);
  assert.equal(blocked.value.policy, "standard", "rejection reports the effective tier");
  assert.equal(blocked.value.policySource, "session");

  service.connections.get("conn-b").execPolicyOverride = "allowAll";
  let executed = null;
  service.runPreparedExec = async (connectionId, prepared, original) => {
    executed = { connectionId, prepared, original };
    return { ok: true, value: { exitCode: 0, stdout: "ran", stderr: "", cwd: null, commandId: "x", startedAt: "t", finishedAt: "t", durationMs: 1, truncated: false, timedOut: false, redacted: false } };
  };
  const allowed = await service.execOnConnection("conn-b", "rm -rf /tmp/x");
  assert.equal(allowed.value.blocked, undefined, "allowAll runs the command");
  assert.equal(executed.prepared, "rm -rf /tmp/x", "released commands run as written — no silent trash rewrite");
}

// The custom tier end to end: a released category runs, an unreleased one is
// still held for the operator. This is the behaviour the panel promises when
// it says a category is released, and the one that was silently missing.
{
  const savedPolicy = service.execPolicy;
  const savedAllow = service.execPolicyAllow;
  const savedTable = service.profileTable;
  service.execPolicy = "custom";
  service.execPolicyAllow = ["reboot-shutdown"];
  service.profileTable = null;
  service.connections.set("conn-d", { profileId: null, sessions: new Set(), tunnels: new Map() });
  let ran = null;
  service.runPreparedExec = async (connectionId, prepared) => {
    ran = prepared;
    return { ok: true, value: { exitCode: 0, stdout: "ran", stderr: "", cwd: null, commandId: "x", startedAt: "t", finishedAt: "t", durationMs: 1, truncated: false, timedOut: false, redacted: false } };
  };
  const released = await service.execOnConnection("conn-d", "reboot");
  assert.equal(released.value.blocked, undefined, "a released category runs through exec");
  assert.equal(ran, "reboot", "and it runs as written");
  ran = null;
  const held = await service.execOnConnection("conn-d", "rm -rf /tmp/x");
  assert.equal(held.value.blocked, true, "an unreleased category is still held for the operator");
  assert.equal(ran, null, "the held command never reached the exec channel");
  service.connections.delete("conn-d");
  service.profileTable = savedTable;
  service.execPolicy = savedPolicy;
  service.execPolicyAllow = savedAllow;
}

// The same checklist must reach the agent line gate (writeToConnection), or a
// released category would work through ssh_exec but stay blocked through
// ssh_write.
{
  const written = [];
  const session = { id: "sess-2", exited: null, stream: { write: (data) => written.push(data) }, waiters: [], inputRevision: 0, inputKnown: true, inputLine: "" };
  service.sessions ??= new Map();
  service.sessions.set("sess-2", session);
  service.connections.set("conn-e", { profileId: null, sessions: new Set(["sess-2"]), tunnels: new Map() });
  service.execPolicy = "custom";
  service.execPolicyAllow = ["reboot-shutdown"];
  const releasedLine = service.writeToConnection("conn-e", "reboot\r");
  assert.equal(releasedLine.ok, true, "the released category passes the line gate");
  assert.ok(written.join("").includes("reboot"), "the line was forwarded");
  const heldLine = service.writeToConnection("conn-e", "rm -rf /tmp/x\r");
  assert.equal(heldLine.ok, false, "an unreleased category stays held on the line gate");
  assert.equal(heldLine.error.code, "unsafe-command");
  service.connections.delete("conn-e");
  service.sessions.delete("sess-2");
}

// writeToConnection forwards guarded lines under allowAll; the tier comes
// from the connection resolution inside writeToConnection, not the caller.
{
  const written = [];
  const session = { id: "sess-1", exited: null, stream: { write: (data) => written.push(data) }, waiters: [], inputRevision: 0, inputKnown: true, inputLine: "" };
  service.sessions = new Map([["sess-1", session]]);
  service.connections.get("conn-b").sessions = new Set(["sess-1"]);
  service.connections.get("conn-b").execPolicyOverride = "allowAll";
  const passed = service.writeToConnection("conn-b", "rm -rf /tmp/x\r");
  assert.equal(passed.ok, true, "allowAll lets agent-written lines through");
  assert.ok(written.join("").includes("rm -rf /tmp/x"), "the line was forwarded");
  service.connections.get("conn-b").execPolicyOverride = "standard";
  const guarded = service.writeToConnection("conn-b", "rm -rf /tmp/x\r");
  assert.equal(guarded.ok, false, "standard keeps guarding agent-written lines");
  assert.equal(guarded.error.code, "unsafe-command");
}

// No agent tool may write the policy: the registered tool surface must not
// contain any policy-setting tool. (Reading the tier arrives via structured
// rejection fields, so there is no read tool either.)
{
  const registered = [];
  const ctx = {
    tools: {
      register: (tool) => registered.push(tool.name),
      on: () => {}
    }
  };
  registerSshSessionTools(ctx, service);
  registerBatchTools(ctx, service);
  const policyWriters = registered.filter((name) => /policy|execPolicy/i.test(name));
  assert.deepEqual(policyWriters, [], "policy switching stays operator-only");
}

// The checklist survives a tier round-trip. Ticking categories, flipping to
// another tier and flipping back used to come back empty — and the next save
// then overwrote the stored list with that empty one.
{
  const roundTrip = Object.create(SshOpsService.prototype);
  const rows = new Map();
  roundTrip.settingsTable = { get: (id) => rows.get(id), put: (id, value) => { rows.set(id, value); } };
  roundTrip.execPolicy = "standard";
  roundTrip.execPolicyAllow = [];

  const ticked = await roundTrip.agentSettingsSave({
    agentAutoConnect: false,
    execPolicy: "custom",
    execPolicyAllow: ["reboot-shutdown", "docker-destroy", "not-a-category"]
  });
  assert.deepEqual(ticked.value.execPolicyAllow, ["reboot-shutdown", "docker-destroy"], "unknown keys are dropped");

  await roundTrip.agentSettingsSave({ agentAutoConnect: false, execPolicy: "allowAll" });
  assert.deepEqual(roundTrip.execPolicyAllow, ["reboot-shutdown", "docker-destroy"], "the list is kept while another tier is active");

  const back = await roundTrip.agentSettingsSave({ agentAutoConnect: false, execPolicy: "custom" });
  assert.deepEqual(back.value.execPolicyAllow, ["reboot-shutdown", "docker-destroy"], "the checklist is back where the operator left it");
  assert.deepEqual(loadSettingsRecord(rows.get("main")).execPolicyAllow, ["reboot-shutdown", "docker-destroy"], "and it is what got persisted");

  // The panel's own protocol: it loads the checklist from agentSettingsGet and
  // sends it back when the operator switches tiers. A get that reported [] for
  // a non-custom tier would make the switch itself erase the ticks.
  roundTrip.execPolicy = "standard";
  roundTrip.execPolicyAllow = ["reboot-shutdown", "docker-destroy"];
  const panelLoad = await roundTrip.agentSettingsGet();
  assert.equal(panelLoad.value.execPolicy, "standard");
  assert.deepEqual(panelLoad.value.execPolicyAllow, ["reboot-shutdown", "docker-destroy"], "the checklist loads even while another tier is active");
  const switched = await roundTrip.agentSettingsSave({
    agentAutoConnect: false,
    execPolicy: "custom",
    execPolicyAllow: panelLoad.value.execPolicyAllow
  });
  assert.deepEqual(switched.value.execPolicyAllow, ["reboot-shutdown", "docker-destroy"], "switching tiers through the panel keeps the checklist");
}

// A session-scoped switch must not survive the transport: the panel tells the
// operator "断开或重连后恢复资源/全局设置", and the self-healing reconnect below
// reuses the same connection record, so the reset has to happen on transport
// loss or the promise is false while the gate stays open.
{
  const service2 = Object.create(SshOpsService.prototype);
  service2.connections = new Map();
  service2.sessions = new Map();
  service2.exitedSessions = new Map();
  service2.profileTable = null;
  service2.dbOps = null;
  service2.scheduleReconnect = () => {};
  service2.closeConnectionTunnels = () => {};
  const client = { end: () => {} };
  const record = {
    id: "c1", client, sessions: new Set(), tunnels: new Map(),
    dead: false, closing: false, reconnectTimer: null, reconnectAttempts: 0, reconnectWaiters: [], hops: []
  };
  service2.connections.set("c1", record);

  const switched = service2.execPolicySet({ connectionId: "c1", policy: "allowAll" });
  assert.equal(switched.value.source, "session");
  assert.equal(service2.resolveExecPolicy("c1").mode, "allowAll");

  service2.handleTransportLoss(record, client, new Error("read ECONNRESET"));
  assert.equal(service2.connections.has("c1"), true, "the record is kept for the auto-reconnect");
  assert.equal(service2.resolveExecPolicy("c1").source, "global", "the session switch is gone after a reconnect");
  assert.equal(service2.resolveExecPolicy("c1").mode, "standard");
}

console.log("exec-policy: all assertions passed");
