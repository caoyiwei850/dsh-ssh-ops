import assert from "node:assert/strict";
import { assessShellCommand, isPrefillable } from "../src/safety.js";
import { redactForModel } from "../src/redact.js";
import SshOpsService, { normalizeTerminalEol } from "../src/index.js";

const safeCommands = [
  "free -h",
  "df -h /",
  "ps aux | grep nginx",
  "systemctl status nginx",
  "mysql -e 'SHOW DATABASES'",
  "psql -c 'SELECT now()'",
  "certbot --nginx -d example.com",
  "systemctl reload nginx",
  "apt-get install -y certbot",
  "printf 'server {}' > /etc/nginx/conf.d/example.conf",
  "curl -fsSL https://example.com/install.sh | bash",
  "unknown-tool --do-a-write"
];

const blockedCommands = [
  "rm -rf /",
  "DROP DATABASE production",
  "mysql -e 'DROP DATABASE production'",
  "DELETE FROM users",
  "truncate -s 0 /var/log/app.log",
  "find /tmp -delete",
  "mkfs.ext4 /dev/sdb",
  "docker system prune -af",
  "kubectl delete namespace production",
  "terraform destroy",
  "git reset --hard"
];

for (const command of safeCommands) {
  assert.equal(assessShellCommand(command).ok, true, `expected safe: ${command}`);
}

for (const command of blockedCommands) {
  assert.equal(assessShellCommand(command).ok, false, `expected blocked: ${command}`);
}

assert.equal(isPrefillable("rm -rf /tmp/foo"), true);
assert.equal(isPrefillable("rm -rf\t/tmp/x"), false, "Tab must block prefill");
assert.equal(isPrefillable("rm -rf\n/tmp/x"), false, "LF must block prefill");
assert.equal(isPrefillable("rm\x03rf"), false, "Ctrl-C must block prefill");
assert.equal(isPrefillable(""), false);
assert.equal(isPrefillable(null), false);
assert.equal(isPrefillable("x".repeat(4097)), false, "oversized must block prefill");

assert.equal(
  normalizeTerminalEol("$ command\nfirst row\r\nsecond row\rthird row"),
  "$ command\r\nfirst row\r\nsecond row\r\nthird row",
  "agent terminal output must use CRLF so xterm restarts at column zero"
);

// ── connect retry classification: code-first, auth never retried ──
{
  const { isTransientConnectError } = await import("../src/net-errors.js");
  assert.equal(isTransientConnectError({ code: "ECONNRESET", message: "read ECONNRESET" }), true);
  assert.equal(isTransientConnectError({ code: "ETIMEDOUT", message: "connect ETIMEDOUT" }), true);
  assert.equal(isTransientConnectError({ code: "ECONNREFUSED", message: "connect ECONNREFUSED" }), true, "scanner-induced refusals stay retryable");
  assert.equal(isTransientConnectError({ code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND host" }), false, "bad DNS names are permanent");
  assert.equal(isTransientConnectError({ code: "EACCES", message: "permission denied" }), false);
  assert.equal(isTransientConnectError({ message: "All configured authentication methods failed" }), false, "auth failures are never retried");
  assert.equal(isTransientConnectError({ message: "Handshake failed: no matching key exchange method" }), true, "protocol-level message fallback");
  assert.equal(isTransientConnectError({ message: "Keepalive timeout" }), true);
}

const service = Object.create(SshOpsService.prototype);
service.config = { maxBufferBytes: 1024, maxCaptureBytes: 512, maxCommandOutputBytes: 128 };
service.wakeWaiters = () => {};
service.pendingConfirmations = new Map();

const safeSession = { inputLine: "", inputKnown: true, buffer: "" };
const safeInput = service.prepareTerminalInput(safeSession, "free -h\r");
assert.equal(safeInput.forwarded, "free -h\r");
assert.equal(safeInput.blockedReason, null);

const blockedSession = { inputLine: "", inputKnown: true, buffer: "" };
const blockedInput = service.prepareTerminalInput(blockedSession, "rm -rf /\r");
assert.equal(blockedInput.forwarded, "rm -rf /\x15");
assert.match(blockedInput.blockedReason, /安全策略已阻止/);
assert.match(blockedSession.buffer, /DSH SSH 安全策略/);

const captureSession = { buffer: "", captureBuffer: "", lastPrompt: null };
service.appendSessionOutput(captureSession, "root@iZ2vc27mmzgpr2oszj1kplZ:~# ");
assert.equal(captureSession.lastPrompt, "root@iZ2vc27mmzgpr2oszj1kplZ:~# ");
const displayConn = { host: "192.0.2.10", username: "root", sessions: new Set(["capture"]) };
service.connections = new Map([["capture", displayConn]]);
service.sessions = new Map([["capture", { ...captureSession, exited: null }]]);
service.appendSessionOutput(service.sessions.get("capture"), "$ echo old\r\nold output\r\n");
const rememberedPrompt = service.sessions.get("capture").lastPrompt;
service.appendSessionOutput(service.sessions.get("capture"), "root@iZ2vc27mmzgpr2oszj1kplZ:~# ");
assert.equal(rememberedPrompt, "root@iZ2vc27mmzgpr2oszj1kplZ:~# ");
assert.match(service.sessions.get("capture").captureBuffer, /old output/);

const redacted = redactForModel("PASSWORD=top-secret\nAuthorization: Bearer abc.def\n");
assert.equal(redacted.redacted, true);
assert.doesNotMatch(redacted.text, /top-secret|abc\.def/);

// 裸 sk- 开头的 API key（无 KEY= / authorization 前缀）也必须脱敏
const redactedSk = redactForModel("export OPENAI_API_KEY=\"sk-1234567890abcdefghijklmnop\"\ncurl -H 'Authorization: Bearer sk-abcdef1234567890XYZABC' https://api.example.com\nsk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefgh");
assert.equal(redactedSk.redacted, true);
assert.doesNotMatch(redactedSk.text, /sk-[A-Za-z0-9]{12,}/);

// 短 token（sk- 后不足 12 字符）不应被误伤
const shortSk = redactForModel("a short sk-abc word");
assert.doesNotMatch(shortSk.text, /sk-\*\*\*/);

let manualInput;
service.sessions = new Map([["manual", {
  exited: null,
  stream: { write(value) { manualInput = value; } }
}]]);
const manualWrite = await service.write({
  sessionId: "manual",
  data: Buffer.from("rm -rf /\r", "utf8").toString("base64")
});
assert.equal(manualWrite.ok, true);
assert.equal(manualInput, "rm -rf /\r", "manual terminal input must not be treated as an agent command");

service.connections = new Map();
const rejectedExec = await service.execOnConnection("missing", "DROP DATABASE production");
assert.equal(rejectedExec.blocked, true);
assert.equal(rejectedExec.value.command, "DROP DATABASE production");
assert.equal(rejectedExec.value.prefilled, false);
assert.match(rejectedExec.value.reason, /删除数据库/);

// A blocked command is queued for confirmation without being written to the
// terminal input line; the operator can only execute it via the panel's
// Execute button (which sends the command + Enter to the PTY).
const prefillWrites = [];
service.connections = new Map([["live", { host: "192.0.2.10", port: 22, username: "root", sessions: new Set(["live-sess"]) }]]);
service.sessions = new Map([["live-sess", { id: "live-sess", exited: null, stream: { write(v) { prefillWrites.push(v); } }, inputLine: "", inputKnown: true, buffer: "" }]]);
const prefilledExec = await service.execOnConnection("live", "rm -rf /tmp/x");
assert.equal(prefilledExec.blocked, true);
assert.equal(prefilledExec.value.prefilled, false);
assert.equal(prefilledExec.value.queued, true);
assert.equal(prefilledExec.value.command, "rm -rf /tmp/x");
assert.match(prefilledExec.value.reason, /删除文件或目录/);
assert.match(service.sessions.get("live-sess").buffer, /弹出确认卡片/);
assert.equal(service.sessions.get("live-sess").inputLine, "", "the command is not prefilled into the terminal");

// Each dangerous action is queued independently; approvals submit exactly once.
const queuedExec = await service.execOnConnection("live", "rm -rf /tmp/y");
assert.equal(queuedExec.value.queued, true);
assert.equal(queuedExec.value.prefilled, false);
assert.equal(service.pendingConfirmationList().value.confirmations.length, 2);
// Keyboard Enter is normal operator input now — it passes through and does not
// execute or interfere with the queued confirmation.
await service.write({ sessionId: "live-sess", data: Buffer.from("\r").toString("base64") });
assert.equal(prefillWrites.at(-1), "\r", "keyboard Enter passes through as normal input");
const secondPending = service.pendingConfirmationList().value.confirmations.find((item) => item.command === "rm -rf /tmp/y");
assert.equal((await service.pendingConfirmationApprove({ confirmationId: secondPending.confirmationId })).value.executed, true);
assert.equal(prefillWrites.at(-1), "\x15rm -rf /tmp/y\r", "card approval clears the line and submits the command");
const firstPending = service.pendingConfirmationList().value.confirmations.find((item) => item.command === "rm -rf /tmp/x");
assert.equal((await service.pendingConfirmationApprove({ confirmationId: firstPending.confirmationId })).value.executed, true);
assert.equal(prefillWrites.at(-1), "\x15rm -rf /tmp/x\r", "the card clears the line and submits once");
assert.equal(service.pendingConfirmationList().value.confirmations.length, 0);

const cancelExec = await service.execOnConnection("live", "rm -rf /tmp/cancel");
const cancelPending = service.pendingConfirmationList().value.confirmations[0];
assert.equal(cancelExec.value.prefilled, false);
assert.equal((await service.pendingConfirmationCancel({ confirmationId: cancelPending.confirmationId })).value.cancelled, true);

// Typing in the terminal does not revoke a queued confirmation; the operator
// must use the panel's Execute/Undo buttons to handle it.
const editExec = await service.execOnConnection("live", "rm -rf /tmp/edit");
assert.equal(editExec.value.prefilled, false);
await service.write({ sessionId: "live-sess", data: Buffer.from("echo manual").toString("base64") });
assert.equal(service.pendingConfirmationList().value.confirmations.length, 1, "terminal input does not revoke a queued confirmation");
assert.equal(prefillWrites.at(-1), "echo manual", "terminal input passes through normally");
await service.pendingConfirmationCancel({ confirmationId: service.pendingConfirmationList().value.confirmations[0].confirmationId });
assert.equal(service.pendingConfirmationList().value.confirmations.length, 0);

// A command containing control characters (e.g. Tab) is not prefilled into the
// PTY; it falls back to a copyable card so completion/Cancel are not triggered.
service.connections = new Map([["ctrl-conn", { host: "192.0.2.10", port: 22, username: "root", sessions: new Set(["ctrl"]) }]]);
service.sessions = new Map([["ctrl", { id: "ctrl", exited: null, stream: { write() { throw new Error("must not prefill control chars"); } }, inputLine: "", inputKnown: true, buffer: "" }]]);
const ctrlExec = await service.execOnConnection("ctrl-conn", "rm -rf\t/tmp/y");
assert.equal(ctrlExec.blocked, true);
assert.equal(ctrlExec.value.prefilled, false);

const allowedButMissing = await service.execOnConnection("missing", "free -h");
assert.equal(allowedButMissing.ok, false);
assert.equal(allowedButMissing.error.code, "no-connection");

const activeConnection = { host: "192.0.2.10", port: 22, username: "root", sessions: new Set() };
service.connections = new Map([["active", activeConnection]]);
service.activeConnectionId = "active";
let commandInvocation;
service.execOnConnection = async (connectionId, command) => {
  commandInvocation = { connectionId, command };
  return {
    ok: true,
    value: {
      exitCode: 0,
      stdout: "Mem: 1.0G 0.5G\n",
      stderr: "",
      cwd: "/root",
      commandId: "cmd-1",
      startedAt: "2026-08-15T00:00:00.000Z",
      finishedAt: "2026-08-15T00:00:01.000Z",
      durationMs: 1000,
      truncated: false,
      timedOut: false
    }
  };
};
const execution = await service.executeCommand({ command: "free -h" });
assert.deepEqual(commandInvocation, { connectionId: "active", command: "free -h" });
assert.equal(execution.ok, true);
assert.equal(execution.value.host, "192.0.2.10");
assert.equal(execution.value.cwd, "/root", "the interactive cwd travels with the result");
assert.deepEqual(Object.keys(execution.value).sort(), ["commandId", "connectionId", "cwd", "durationMs", "exitCode", "finishedAt", "host", "redacted", "startedAt", "stderr", "stdout", "timedOut", "truncated"]);

const registeredTools = [];
service.registerTools({ tools: { register(tool) { registeredTools.push(tool); } } });
assert.ok(registeredTools.some((tool) => tool.name === "ssh_exec"));
assert.ok(!registeredTools.some((tool) => tool.name === "ssh_check_memory"));
assert.ok(registeredTools.some((tool) => tool.name === "ssh_list"));

const renderFixtures = {
  ssh_list: [{}, { activeConnectionId: "active", connections: [{ connectionId: "active", name: "demo", host: "192.0.2.10", port: 22, username: "root", connected: true, sessions: [] }] }],
  ssh_connect: [{ username: "root", host: "192.0.2.10" }, { connectionId: "active" }],
  ssh_exec: [{}, { connectionId: "active", host: "192.0.2.10", exitCode: 0, stdout: "ok\n", stderr: "", cwd: "/root/KVideo", commandId: "cmd-1", startedAt: "2026-08-15T00:00:00.000Z", finishedAt: "2026-08-15T00:00:01.000Z", durationMs: 1000, truncated: false, timedOut: false, redacted: false }],
  ssh_read: [{}, { connectionId: "active", host: "192.0.2.10", data: "prompt", hasSession: true, truncated: false, redacted: false }],
  ssh_write: [{}, { written: 5 }],
  ssh_disconnect: [{}, { disconnected: true }]
};
for (const [name, [args, value]] of Object.entries(renderFixtures)) {
  const tool = registeredTools.find((candidate) => candidate.name === name);
  const content = tool.output.render(args, value);
  assert.equal(content.length, 1, `${name} should render one content block`);
  assert.equal(content[0].type, "text", `${name} should render a text block`);
  assert.equal(typeof content[0].text, "string", `${name} text should not be split into characters`);
}

// A blocked ssh_exec renders a copyable command card, not a thrown error.
{
  const sshExecTool = registeredTools.find((t) => t.name === "ssh_exec");
  const baseBlocked = { connectionId: "live", host: "192.0.2.10", exitCode: null, stdout: "", stderr: "", cwd: null, commandId: "(blocked)", startedAt: "2026-08-20T00:00:00.000Z", finishedAt: "2026-08-20T00:00:00.000Z", durationMs: 0, truncated: false, timedOut: false, redacted: false };
  const prefilledCard = sshExecTool.output.render({}, { ...baseBlocked, blocked: true, reason: "删除文件或目录", command: "rm -rf /tmp/x", prefilled: false, queued: true });
  assert.equal(prefilledCard.length, 1);
  assert.match(prefilledCard[0].text, /已拦截：删除文件或目录/);
  assert.match(prefilledCard[0].text, /未执行/);
  assert.match(prefilledCard[0].text, /确认卡片/);
  assert.match(prefilledCard[0].text, /```bash\nrm -rf \/tmp\/x\n```/);
  assert.match(prefilledCard[0].text, /请勿重试/);
  assert.match(prefilledCard[0].text, /绕行/);
  const copyCard = sshExecTool.output.render({}, { ...baseBlocked, blocked: true, reason: "删除文件或目录", command: "rm -rf /tmp/x", prefilled: false, queued: false });
  assert.match(copyCard[0].text, /粘贴到右侧终端执行/);
  assert.match(copyCard[0].text, /```bash/);
  assert.match(copyCard[0].text, /请勿重试/);
  // Normal (non-blocked) ssh_exec output renders the cwd note, then output.
  const normalCard = sshExecTool.output.render({}, { connectionId: "live", host: "192.0.2.10", exitCode: 0, stdout: "ok\n", stderr: "", cwd: "/root/KVideo", commandId: "cmd-1", startedAt: "x", finishedAt: "x", durationMs: 1, truncated: false, timedOut: false, redacted: false });
  assert.equal(normalCard[0].text, "[cwd: /root/KVideo]\nok\n");
  // Unknown cwd spells out the home fallback instead of printing "null".
  const fallbackCard = sshExecTool.output.render({}, { connectionId: "live", host: "192.0.2.10", exitCode: 0, stdout: "ok\n", stderr: "", cwd: null, commandId: "cmd-1", startedAt: "x", finishedAt: "x", durationMs: 1, truncated: false, timedOut: false, redacted: false });
  assert.match(fallbackCard[0].text, /^\[cwd: login directory — no interactive shell directory detected\]\nok\n$/);
}

// sftp_delete never deletes via the agent; it queues an equivalent
// `rm -rf <quoted path>` for confirmation (or returns a copyable card).
{
  const sftpTool = registeredTools.find((t) => t.name === "sftp_delete");
  let sftpStream = null;
  service.connections = new Map([["sftp-conn", { host: "192.0.2.10", port: 22, username: "root", sessions: new Set(["sftp-sess"]) }]]);
  service.sessions = new Map([["sftp-sess", { id: "sftp-sess", exited: null, stream: { write(v) { sftpStream = v; } }, inputLine: "", inputKnown: true, buffer: "" }]]);
  const sftpRes = await sftpTool.execute({ path: "/tmp/foo", connection_id: "sftp-conn" });
  assert.equal(sftpRes.blocked, true);
  assert.equal(sftpRes.prefilled, false);
  assert.equal(sftpRes.queued, true);
  assert.equal(sftpRes.path, "/tmp/foo");
  assert.equal(sftpRes.command, "rm -rf '/tmp/foo'");
  assert.equal(sftpStream, null, "the command is not written to the terminal at block time");
  const sftpCard = sftpTool.output.render({}, sftpRes);
  assert.match(sftpCard[0].text, /确认卡片/);
  assert.match(sftpCard[0].text, /```bash\nrm -rf '\/tmp\/foo'\n```/);
  assert.match(sftpCard[0].text, /请勿重试/);
  // Omitted connection_id must resolve to the current right-side connection,
  // otherwise the card would claim a queue entry while none exists.
  await service.pendingConfirmationCancel({ confirmationId: service.pendingConfirmationList().value.confirmations[0].confirmationId });
  service.activeConnectionId = "sftp-conn";
  const activeSftpRes = await sftpTool.execute({ path: "/tmp/current.txt" });
  assert.equal(activeSftpRes.queued, true);
  assert.equal(service.pendingConfirmationList().value.confirmations.length, 1);
  // Paths with spaces / quotes are POSIX single-quoted so they cannot escape.
  const sftpRes2 = await sftpTool.execute({ path: "/tmp/a b'c", connection_id: "sftp-conn" });
  assert.equal(sftpRes2.command, "rm -rf '/tmp/a b'\\''c'");
  // No live session → copyable card fallback.
  service.sessions = new Map();
  const sftpRes3 = await sftpTool.execute({ path: "/tmp/bar", connection_id: "sftp-conn" });
  assert.equal(sftpRes3.prefilled, false);
  assert.match(sftpTool.output.render({}, sftpRes3)[0].text, /粘贴到右侧终端执行/);
}

// db_execute blocked SQL returns a copyable SQL card (not a thrown error); only
// genuine db failures still throw.
{
  const dbTool = registeredTools.find((t) => t.name === "db_execute");
  service.dbExecute = async () => ({ ok: false, error: { code: "unsafe-sql", message: "TRUNCATE 不可恢复或会停库，已拦截" } });
  const dbRes = await dbTool.execute({ db_connection_id: "x", sql: "TRUNCATE TABLE t" });
  assert.equal(dbRes.blocked, true);
  assert.equal(dbRes.affectedRows, 0);
  assert.equal(dbRes.sql, "TRUNCATE TABLE t");
  assert.match(dbRes.reason, /TRUNCATE/);
  const dbCard = dbTool.output.render({}, dbRes);
  assert.match(dbCard[0].text, /已拦截：TRUNCATE/);
  assert.match(dbCard[0].text, /未执行/);
  assert.match(dbCard[0].text, /```sql\nTRUNCATE TABLE t\n```/);
  assert.match(dbCard[0].text, /请勿重试/);
  service.dbExecute = async () => ({ ok: false, error: { code: "db-execute-failed", message: "boom" } });
  await assert.rejects(() => dbTool.execute({ db_connection_id: "x", sql: "INSERT 1" }), /db_execute failed: boom/);
}

// Mirror drift fix: raw operator input (write path) keeps the input-line mirror
// in sync, so a later agent-driven Enter is gated against the human's line.
{
  const enc = (s) => Buffer.from(s, "utf8").toString("base64");
  service.sessions = new Map([["mirror", { exited: null, stream: { write() {} }, inputLine: "", inputKnown: true, buffer: "" }]]);
  await service.write({ sessionId: "mirror", data: enc("rm -rf /tmp/z") });
  assert.equal(service.sessions.get("mirror").inputLine, "rm -rf /tmp/z");
  assert.equal(service.sessions.get("mirror").inputKnown, true);
  // Agent-driven Enter must be cleared (Ctrl-U), not submitted.
  const mirrorSession = service.sessions.get("mirror");
  const guarded = service.prepareTerminalInput(mirrorSession, "\r");
  assert.equal(guarded.forwarded, "\x15");
  assert.match(guarded.blockedReason, /安全策略已阻止/);
  // Operator's own Enter (raw path) still submits and resets the mirror.
  await service.write({ sessionId: "mirror", data: enc("\r") });
  assert.equal(service.sessions.get("mirror").inputLine, "");
}

// Durable SSH resources deliberately split public metadata from secret values.
function memoryTable() {
  const records = new Map();
  return {
    get: (key) => records.get(key),
    entries: () => records.entries(),
    async put(key, value) { records.set(key, value); },
    async delete(key) { return records.delete(key); }
  };
}

const secrets = new Map();
const profileService = Object.create(SshOpsService.prototype);
profileService.profileTable = memoryTable();
profileService.groupTable = memoryTable();
profileService.connections = new Map();
profileService.ctx = {
  credentials: {
    async describe(ref) { return { configured: secrets.has(ref), writable: true }; },
    async resolve(ref) { return secrets.has(ref) ? { value: secrets.get(ref), source: "file" } : undefined; },
    async unset(ref) { secrets.delete(ref); }
  }
};
const newGroup = await profileService.groupSave({ name: "生产环境" });
assert.equal(newGroup.ok, true);
const savedProfile = await profileService.profileSave({
  name: "web-01", host: "192.0.2.10", port: 22, username: "root", authKind: "key", groupId: newGroup.value.group.groupId
});
assert.equal(savedProfile.ok, true);
assert.match(savedProfile.value.credentialRefs.privateKey, /^DSH_SSH_OPS_[A-F0-9]+_PRIVATE_KEY$/);
secrets.set(savedProfile.value.credentialRefs.privateKey, "PRIVATE KEY MUST NOT LEAK");
const listedProfiles = await profileService.profileList();
assert.equal(listedProfiles.ok, true);
assert.equal(listedProfiles.value.profiles[0].credentialConfigured, true);
assert.equal("credentialRefs" in listedProfiles.value.profiles[0], false);
assert.equal(JSON.stringify(listedProfiles.value), JSON.stringify(listedProfiles.value).replace("PRIVATE KEY MUST NOT LEAK", ""));
const deletedGroup = await profileService.groupDelete({ groupId: newGroup.value.group.groupId });
assert.deepEqual(deletedGroup.value, { deleted: true, movedProfiles: 1 });
const ungroupedProfiles = await profileService.profileList();
assert.equal(ungroupedProfiles.value.profiles[0].groupId, null);
const deletedProfile = await profileService.profileDelete({ profileId: savedProfile.value.profile.profileId });
assert.equal(deletedProfile.value.deleted, true);
assert.equal(secrets.size, 0);

console.log(`safety policy: ${safeCommands.length} safe and ${blockedCommands.length} blocked cases passed`);
