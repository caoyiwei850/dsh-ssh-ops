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
  "unknown-tool --do-a-write",
  "find /tmp -name '*.log' -print",
  "cat list.txt | xargs cat",
  "xargs echo done",
  "python3 --version",
  "node -e \"console.log('ok')\"",
  "perl -e 'print 1'"
];

const blockedCommands = [
  "rm -rf /",
  "DROP DATABASE production",
  "mysql -e 'DROP DATABASE production'",
  "DELETE FROM users",
  "truncate -s 0 /var/log/app.log",
  "find /tmp -delete",
  "find /tmp -exec rm {} \\;",
  "find /var/log -execdir unlink {} ;",
  "ls /tmp | xargs rm -f",
  "python3 -c \"import os; os.remove('/tmp/x')\"",
  "node -e \"require('fs').rmSync('/tmp/x', {recursive: true})\"",
  "perl -e 'unlink \"/tmp/x\"'",
  "npx rimraf dist",
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
assert.match(rejectedExec.value.reason, /删除数据库/);

// Without a valid approval voucher the blocked command is denied outright:
// no queue, no terminal notice — the ask flow suspends the tool call itself,
// so a blocked result here means "the ask did not happen or did not grant".
const prefillWrites = [];
service.connections = new Map([["live", { host: "192.0.2.10", port: 22, username: "root", sessions: new Set(["live-sess"]) }]]);
service.sessions = new Map([["live-sess", { id: "live-sess", exited: null, stream: { write(v) { prefillWrites.push(v); } }, inputLine: "", inputKnown: true, buffer: "" }]]);
const deniedExec = await service.execOnConnection("live", "shred /tmp/x");
assert.equal(deniedExec.blocked, true);
assert.equal(deniedExec.value.command, "shred /tmp/x");
assert.match(deniedExec.value.reason, /删除文件或目录/);
assert.equal(deniedExec.value.queued, undefined, "nothing is queued anymore — the ask replaced the cards");
assert.equal(service.sessions.get("live-sess").buffer, "", "no terminal notice: the gate suspends the call instead of queueing");

// A voucher is bound to the exact command the operator saw: a different one
// grants nothing, and consuming a voucher happens exactly once.
service.recordOperatorApproval("call-1", "live", "shred /tmp/other");
const mismatched = await service.execOnConnection("live", "shred /tmp/x", 30000, false, "call-1");
assert.equal(mismatched.blocked, true, "a voucher for another command grants nothing");
assert.equal(service.operatorApprovals.size, 0, "the mismatched voucher is still consumed once");

// ── an approved simple rm runs the reversible trash move on the exec ────────
// ── channel; the PTY never sees the rm at all ────────────────────────────────
{
  const trashService = Object.create(SshOpsService.prototype);
  trashService.config = { maxBufferBytes: 1024, maxCaptureBytes: 512, maxCommandOutputBytes: 4096 };
  trashService.wakeWaiters = () => {};
  let sent = null;
  trashService.collectExecOutput = async (client, command) => {
    sent = command;
    return {
      exitCode: 0,
      stdout: "__DSH_TRASH_V1__\tmoved\t/tmp/x\t/root/.dsh-trash/1700000000-x\n",
      stderr: "",
      truncated: false,
      timedOut: false
    };
  };
  trashService.ensureAlive = async () => true;
  const trashWrites = [];
  trashService.connections = new Map([["live", { host: "192.0.2.10", port: 22, username: "root", sessions: new Set(["live-sess"]), loginShell: "bash" }]]);
  trashService.sessions = new Map([["live-sess", { id: "live-sess", exited: null, stream: { write(v) { trashWrites.push(v); } }, inputLine: "", inputKnown: true, buffer: "" }]]);

  // No voucher: nothing executes, the structured denial comes back.
  const queued = await trashService.execOnConnection("live", "rm -rf /tmp/x");
  assert.equal(queued.blocked, true, "the rm still waits for the operator");
  assert.equal(sent, null, "no exec happens before approval");
  assert.equal(queued.value.reason, "删除文件或目录", "the reason text is unchanged");

  // The gate's voucher — what the host's allowed-once records — unlocks the
  // call: the trash move runs on the exec channel and the agent sees its
  // output. The PTY never sees the rm.
  trashService.recordOperatorApproval("call-trash", "live", "rm -rf /tmp/x");
  const approved = await trashService.execOnConnection("live", "rm -rf /tmp/x", 30000, false, "call-trash");
  assert.equal(approved.blocked, undefined, "the approved command ran");
  assert.equal(approved.value.exitCode, 0);
  assert.ok(sent.includes(".dsh-trash") && sent.includes("manifest.tsv"), "approval executes the generated script");
  assert.ok(!trashWrites.some((w) => w.includes("rm")), "the real rm never reaches the PTY");
  assert.equal(trashService.operatorApprovals.size, 0, "the voucher is consumed exactly once");
  const mirrored = trashService.sessions.get("live-sess").buffer;
  assert.ok(mirrored.includes("$ rm -rf /tmp/x"), "the terminal mirror echoes the original command");
  assert.ok(!mirrored.includes("__DSH_TRASH_V1__"), "the terminal mirror never shows protocol lines");

  // Compound rm carries no trash script — the operator-approved command runs
  // literally on the exec channel, exactly as approved.
  sent = null;
  trashService.recordOperatorApproval("call-compound", "live", "rm -rf /tmp/x && echo done");
  const compound = await trashService.execOnConnection("live", "rm -rf /tmp/x && echo done", 30000, false, "call-compound");
  assert.equal(compound.blocked, undefined);
  assert.ok(sent.endsWith("rm -rf /tmp/x && echo done"), "compound approval runs the literal command");

  // A dangerous command must not be replayed when the transport dies after
  // dispatch: the first run may already have taken effect.
  const ambiguousService = Object.create(SshOpsService.prototype);
  ambiguousService.config = { maxBufferBytes: 1024, maxCaptureBytes: 512, maxCommandOutputBytes: 4096 };
  ambiguousService.operatorApprovals = new Map();
  ambiguousService.connections = new Map([[
    "live",
    { id: "live", host: "192.0.2.10", sessions: new Set(), client: {}, dead: true }
  ]]);
  ambiguousService.sessions = new Map();
  ambiguousService.resolveExecPolicy = () => ({ mode: "standard", source: "global", allow: [] });
  ambiguousService.resolveLoginShell = async () => null;
  ambiguousService.ensureAlive = async () => true;
  ambiguousService.wakeWaiters = () => {};
  let ambiguousRuns = 0;
  ambiguousService.collectExecOutput = async () => {
    ambiguousRuns += 1;
    throw new Error("transport lost after dispatch");
  };
  ambiguousService.recordOperatorApproval("call-once", "live", "reboot");
  const ambiguous = await ambiguousService.execOnConnection("live", "reboot", 30000, false, "call-once");
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguousRuns, 1, "an approved dangerous command is never transparently replayed");
}

// Approval vouchers expire even when the tool body never consumes them.
{
  const ttlService = Object.create(SshOpsService.prototype);
  ttlService.operatorApprovals = new Map();
  ttlService.operatorApprovalTtlMs = 10;
  ttlService.recordOperatorApproval("stale", "live", "reboot");
  assert.equal(ttlService.operatorApprovals.size, 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(ttlService.operatorApprovals.size, 0, "the unref'd expiry timer removes abandoned grants");
}

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

// A blocked ssh_exec renders the denial (command + reason), not a thrown error.
{
  const sshExecTool = registeredTools.find((t) => t.name === "ssh_exec");
  const baseBlocked = { connectionId: "live", host: "192.0.2.10", exitCode: null, stdout: "", stderr: "", cwd: null, commandId: "(blocked)", startedAt: "2026-08-20T00:00:00.000Z", finishedAt: "2026-08-20T00:00:00.000Z", durationMs: 0, truncated: false, timedOut: false, redacted: false };
  const deniedCard = sshExecTool.output.render({}, { ...baseBlocked, blocked: true, reason: "删除文件或目录", command: "rm -rf /tmp/x" });
  assert.equal(deniedCard.length, 1);
  assert.match(deniedCard[0].text, /已拦截：删除文件或目录/);
  assert.match(deniedCard[0].text, /未执行/);
  assert.match(deniedCard[0].text, /没有获得批准/);
  assert.match(deniedCard[0].text, /```bash\nrm -rf \/tmp\/x\n```/);
  assert.match(deniedCard[0].text, /请勿重试/);
  assert.match(deniedCard[0].text, /绕行/);
// Normal (non-blocked) ssh_exec output renders the cwd note, then output.
  const normalCard = sshExecTool.output.render({}, { connectionId: "live", host: "192.0.2.10", exitCode: 0, stdout: "ok\n", stderr: "", cwd: "/root/KVideo", commandId: "cmd-1", startedAt: "x", finishedAt: "x", durationMs: 1, truncated: false, timedOut: false, redacted: false });
  assert.equal(normalCard[0].text, "[cwd: /root/KVideo]\nok\n");
  // Unknown cwd spells out the home fallback instead of printing "null".
  const fallbackCard = sshExecTool.output.render({}, { connectionId: "live", host: "192.0.2.10", exitCode: 0, stdout: "ok\n", stderr: "", cwd: null, commandId: "cmd-1", startedAt: "x", finishedAt: "x", durationMs: 1, truncated: false, timedOut: false, redacted: false });
  assert.match(fallbackCard[0].text, /^\[cwd: login directory — no interactive shell directory detected\]\nok\n$/);
}

// sftp_delete denies without an operator voucher; with the gate's voucher it
// deletes via the reversible trash move on the exec channel.
{
  const sftpTool = registeredTools.find((t) => t.name === "sftp_delete");
  service.connections = new Map([["sftp-conn", { host: "192.0.2.10", port: 22, username: "root", sessions: new Set(["sftp-sess"]) }]]);
  service.sessions = new Map([["sftp-sess", { id: "sftp-sess", exited: null, stream: { write() {} }, inputLine: "", inputKnown: true, buffer: "" }]]);
  const sftpRes = await sftpTool.execute({ path: "/tmp/foo", connection_id: "sftp-conn" });
  assert.equal(sftpRes.blocked, true);
  assert.equal(sftpRes.queued, undefined, "no queue: the ask replaced the cards");
  assert.equal(sftpRes.path, "/tmp/foo");
  assert.equal(sftpRes.command, "rm -rf '/tmp/foo'");
  assert.equal(sftpRes.reason, "删除文件或目录（SFTP）", "reason text unchanged");
  const sftpCard = sftpTool.output.render({}, sftpRes);
  assert.match(sftpCard[0].text, /未删除任何内容/);
  assert.match(sftpCard[0].text, /```bash\nrm -rf '\/tmp\/foo'\n```/);
  assert.match(sftpCard[0].text, /请勿重试/);

  // With the gate's voucher the reversible trash move runs on the exec
  // channel; the voucher is consumed exactly once.
  let trashSent = null;
  service.runPreparedExec = async (connectionId, prepared, displayCommand) => {
    trashSent = { connectionId, prepared, displayCommand };
    return { ok: true, value: { exitCode: 0, stdout: "moved", stderr: "", cwd: null, commandId: "x", startedAt: "x", finishedAt: "x", durationMs: 0, truncated: false, timedOut: false, redacted: false } };
  };
  service.recordOperatorApproval("sftp-call", "sftp-conn", "rm -rf '/tmp/foo'");
  const deleted = await sftpTool.execute({ path: "/tmp/foo", connection_id: "sftp-conn" }, { callId: "sftp-call" });
  assert.equal(deleted.blocked, undefined);
  assert.equal(deleted.path, "/tmp/foo");
  assert.ok(trashSent.prepared.includes(".dsh-trash") && trashSent.prepared.includes("'/tmp/foo'"), "approval runs the reversible trash move");
  assert.equal(trashSent.displayCommand, "rm -rf '/tmp/foo'");
  assert.equal(service.operatorApprovals.size, 0, "voucher consumed exactly once");

  // Quoting: spaces and quotes survive POSIX single-quoting end to end.
  service.recordOperatorApproval("sftp-call-2", "sftp-conn", "rm -rf '/tmp/a b'\\''c'");
  const deleted2 = await sftpTool.execute({ path: "/tmp/a b'c", connection_id: "sftp-conn" }, { callId: "sftp-call-2" });
  assert.equal(deleted2.path, "/tmp/a b'c");

  service.runPreparedExec = async () => ({
    ok: true,
    value: {
      exitCode: 2,
      stdout: "",
      stderr: "rm: permission denied",
      cwd: null,
      commandId: "x",
      startedAt: "x",
      finishedAt: "x",
      durationMs: 0,
      truncated: false,
      timedOut: false
    }
  });
  service.recordOperatorApproval("sftp-call-fail", "sftp-conn", "rm -rf '/tmp/foo'");
  await assert.rejects(
    () => sftpTool.execute({ path: "/tmp/foo", connection_id: "sftp-conn" }, { callId: "sftp-call-fail" }),
    /outcome is not successful: rm: permission denied/
  );
  delete service.runPreparedExec;
}

// db_execute blocked SQL returns a copyable SQL card (not a thrown error); only
// genuine db failures still throw. Agent calls declare their origin so the
// guard can hold back the operator-only purge step.
{
  const dbTool = registeredTools.find((t) => t.name === "db_execute");
  let seenOrigin;
  service.dbExecute = async (request) => {
    seenOrigin = request.origin;
    return { ok: false, error: { code: "unsafe-sql", message: "TRUNCATE 不可恢复或会停库，已拦截" } };
  };
  const dbRes = await dbTool.execute({ db_connection_id: "x", sql: "TRUNCATE TABLE t" });
  assert.equal(seenOrigin, "agent", "the tool declares the agent origin to the guard");
  assert.equal(dbRes.blocked, true);
  assert.equal(dbRes.affectedRows, 0);
  assert.equal(dbRes.sql, "TRUNCATE TABLE t");
  assert.match(dbRes.reason, /TRUNCATE/);
  const dbCard = dbTool.output.render({}, dbRes);
  assert.match(dbCard[0].text, /已拦截：TRUNCATE/);
  assert.match(dbCard[0].text, /未执行/);
  assert.match(dbCard[0].text, /```sql\nTRUNCATE TABLE t\n```/);
  assert.match(dbCard[0].text, /请勿重试/);

  // A guard envelope with backups surfaces the backup list on the card.
  service.dbExecute = async () => ({ ok: false, error: { code: "unsafe-sql", message: "已拦截", backup: [{ target: "t", path: "/tmp/b.csv", bytes: 12, truncated: false, error: null }] } });
  const backupRes = await dbTool.execute({ db_connection_id: "x", sql: "TRUNCATE TABLE t" });
  assert.deepEqual(backupRes.backup, [{ target: "t", path: "/tmp/b.csv", bytes: 12, truncated: false, error: null }]);
  assert.match(dbTool.output.render({}, backupRes)[0].text, /已自动备份/);
  assert.match(dbTool.output.render({}, backupRes)[0].text, /\/tmp\/b\.csv/);

  // A quarantined DROP renders the rename and the operator-only next step.
  const quarantinedValue = { affectedRows: 0, truncated: false, quarantined: true, renamedTo: "t_to_be_dropped_20260924", notice: "彻底删除请由操作者在数据库面板执行：DROP TABLE t_to_be_dropped_20260924", backup: [{ target: "t", path: "/tmp/b.csv", bytes: 12, truncated: false, error: null }] };
  const quarantineCard = dbTool.output.render({}, quarantinedValue);
  assert.match(quarantineCard[0].text, /♻️ DROP 已转换为隔离改名/);
  assert.match(quarantineCard[0].text, /t_to_be_dropped_20260924/);
  assert.match(quarantineCard[0].text, /已自动备份/);

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
