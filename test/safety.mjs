import assert from "node:assert/strict";
import { assessShellCommand, isPrefillable } from "../src/safety.js";
import { redactForModel } from "../src/redact.js";
import SshOpsService, { normalizeTerminalEol } from "../src/index.js";
import { setLanguage, t } from "../src/i18n/core.js";

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
service.pendingConfirmations = new Map();

const safeSession = { inputLine: "", inputKnown: true, buffer: "" };
const safeInput = service.prepareTerminalInput(safeSession, "free -h\r");
assert.equal(safeInput.forwarded, "free -h\r");
assert.equal(safeInput.blockedReason, null);

const blockedSession = { inputLine: "", inputKnown: true, buffer: "" };
const blockedInput = service.prepareTerminalInput(blockedSession, "rm -rf /\r");
assert.equal(blockedInput.forwarded, "rm -rf /\x15");
// Policy wording is bilingual: assert the English default and then that the
// very same notice is produced in Chinese, so the seam is covered rather than
// just the default.
assert.match(blockedInput.blockedReason, /Blocked by the safety policy/);
assert.match(blockedSession.buffer, /\[DSH SSH safety policy\]/);
{
  setLanguage("zh");
  const zhSession = { inputLine: "", inputKnown: true, buffer: "" };
  const zhInput = service.prepareTerminalInput(zhSession, "rm -rf /\r");
  assert.match(zhInput.blockedReason, /安全策略已阻止/, "the block reason follows the selected language");
  assert.match(zhSession.buffer, /DSH SSH 安全策略/, "the terminal notice follows the selected language");
  setLanguage("en");
}

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
assert.match(rejectedExec.value.reason, /Delete database data or objects/);

// A blocked command is queued for confirmation without being written to the
// terminal input line; the operator can only execute it via the panel's
// Execute button (which sends the command + Enter to the PTY). shred is used
// here because it is blocked but NOT trashable — simple rm commands take the
// reversible trash path instead (tested below).
const prefillWrites = [];
service.connections = new Map([["live", { host: "192.0.2.10", port: 22, username: "root", sessions: new Set(["live-sess"]) }]]);
service.sessions = new Map([["live-sess", { id: "live-sess", exited: null, stream: { write(v) { prefillWrites.push(v); } }, inputLine: "", inputKnown: true, buffer: "" }]]);
const prefilledExec = await service.execOnConnection("live", "shred /tmp/x");
assert.equal(prefilledExec.blocked, true);
assert.equal(prefilledExec.value.prefilled, false);
assert.equal(prefilledExec.value.queued, true);
assert.equal(prefilledExec.value.command, "shred /tmp/x");
assert.match(prefilledExec.value.reason, /Delete files or directories/);
assert.match(service.sessions.get("live-sess").buffer, /confirmation card/);
assert.equal(service.sessions.get("live-sess").inputLine, "", "the command is not prefilled into the terminal");

// Each dangerous action is queued independently; approvals submit exactly once.
const queuedExec = await service.execOnConnection("live", "shred /tmp/y");
assert.equal(queuedExec.value.queued, true);
assert.equal(queuedExec.value.prefilled, false);
assert.equal(service.pendingConfirmationList().value.confirmations.length, 2);
// Keyboard Enter is normal operator input now — it passes through and does not
// execute or interfere with the queued confirmation.
await service.write({ sessionId: "live-sess", data: Buffer.from("\r").toString("base64") });
assert.equal(prefillWrites.at(-1), "\r", "keyboard Enter passes through as normal input");
const secondPending = service.pendingConfirmationList().value.confirmations.find((item) => item.command === "shred /tmp/y");
assert.equal((await service.pendingConfirmationApprove({ confirmationId: secondPending.confirmationId })).value.executed, true);
assert.equal(prefillWrites.at(-1), "\x15shred /tmp/y\r", "card approval clears the line and submits the command");
const firstPending = service.pendingConfirmationList().value.confirmations.find((item) => item.command === "shred /tmp/x");
assert.equal((await service.pendingConfirmationApprove({ confirmationId: firstPending.confirmationId })).value.executed, true);
assert.equal(prefillWrites.at(-1), "\x15shred /tmp/x\r", "the card clears the line and submits once");
assert.equal(service.pendingConfirmationList().value.confirmations.length, 0);

const cancelExec = await service.execOnConnection("live", "shred /tmp/cancel");
const cancelPending = service.pendingConfirmationList().value.confirmations[0];
assert.equal(cancelExec.value.prefilled, false);
assert.equal((await service.pendingConfirmationCancel({ confirmationId: cancelPending.confirmationId })).value.cancelled, true);

// Typing in the terminal does not revoke a queued confirmation; the operator
// must use the panel's Execute/Undo buttons to handle it.
const editExec = await service.execOnConnection("live", "shred /tmp/edit");
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
const ctrlExec = await service.execOnConnection("ctrl-conn", "shred\t/tmp/y");
assert.equal(ctrlExec.blocked, true);
assert.equal(ctrlExec.value.prefilled, false);

// ── simple rm commands still pop the exact same card; approval silently ─────
// ── performs the reversible trash move as a rollback margin ──────────────────
{
  const trashService = Object.create(SshOpsService.prototype);
  trashService.config = { maxBufferBytes: 1024, maxCaptureBytes: 512, maxCommandOutputBytes: 4096 };
  trashService.pendingConfirmations = new Map();
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

  // Issue time: nothing executes; a card queues with the prepared script.
  // Reason and every visible string are exactly the historical ones.
  const queued = await trashService.execOnConnection("live", "rm -rf /tmp/x");
  assert.equal(queued.blocked, true, "the rm still waits for the operator");
  assert.equal(queued.value.queued, true);
  assert.equal(sent, null, "no exec happens before approval");
  assert.equal(queued.value.reason, t("Delete files or directories"), "the reason carries the category, translated for the active language");
  const pending = trashService.pendingConfirmationList().value.confirmations[0];
  assert.ok(pending, "a confirmation card is queued");
  const stored = [...trashService.pendingConfirmations.values()][0];
  assert.ok(stored.trashScript && stored.trashScript.includes(".dsh-trash") && stored.trashScript.includes("'/tmp/x'"), "the card silently carries the prepared trash script");

  // Approval runs the trash script on the exec channel, mirrors the outcome
  // into the terminal, and consumes the card. The PTY never sees the rm.
  const approved = await trashService.pendingConfirmationApprove({ confirmationId: pending.confirmationId });
  assert.equal(approved.ok, true);
  assert.equal(approved.value.executed, true);
  assert.ok(sent.includes(".dsh-trash") && sent.includes("manifest.tsv"), "approval executes the generated script");
  assert.ok(!trashWrites.some((w) => w.includes("rm")), "the real rm never reaches the PTY");
  assert.equal(trashService.pendingConfirmationList().value.confirmations.length, 0, "the card is consumed");
  const mirrored = trashService.sessions.get("live-sess").buffer;
  assert.ok(mirrored.includes("$ rm -rf /tmp/x"), "the terminal mirror echoes the original command");
  assert.ok(!mirrored.includes("回收站") && !mirrored.includes("♻"), "the terminal looks exactly as it always did — no trash advertising");
  assert.ok(!mirrored.includes("__DSH_TRASH_V1__"), "the terminal mirror never shows protocol lines");

  // The operator can cancel instead — nothing runs at all.
  await trashService.execOnConnection("live", "rm -rf /tmp/y");
  const cancelPending = trashService.pendingConfirmationList().value.confirmations[0];
  sent = null;
  const cancelled = await trashService.pendingConfirmationCancel({ confirmationId: cancelPending.confirmationId });
  assert.equal(cancelled.ok, true);
  assert.equal(sent, null, "cancellation never executes");

  // A non-POSIX login shell cannot anchor relative paths, so the silent
  // rollback margin is unavailable there: approval falls back to the
  // historical PTY execution of the literal approved command.
  const fishService = Object.create(SshOpsService.prototype);
  fishService.config = trashService.config;
  fishService.pendingConfirmations = new Map();
  fishService.wakeWaiters = () => {};
  fishService.ensureAlive = async () => true;
  fishService.collectExecOutput = async () => { throw new Error("must not use the exec channel for a non-POSIX shell"); };
  const fishWrites = [];
  fishService.connections = new Map([["fish", { host: "192.0.2.10", port: 22, username: "root", sessions: new Set(["fish-sess"]), loginShell: "fish" }]]);
  fishService.sessions = new Map([["fish-sess", { id: "fish-sess", exited: null, stream: { write(v) { fishWrites.push(v); } }, inputLine: "", inputKnown: true, buffer: "" }]]);
  const fishQueued = await fishService.execOnConnection("fish", "rm -rf relative");
  assert.equal(fishQueued.blocked, true);
  const fishPending = fishService.pendingConfirmationList().value.confirmations[0];
  const fishApproved = await fishService.pendingConfirmationApprove({ confirmationId: fishPending.confirmationId });
  assert.equal(fishApproved.value.executed, true, "non-POSIX shell falls back to the historical execution");
  assert.ok(fishWrites.at(-1).includes("\x15rm -rf relative\r"), "the fallback submits the literal command via the PTY");

  // Compound rm commands carry no trash script — approval runs the real
  // command through the PTY, exactly as before.
  const compound = await trashService.execOnConnection("live", "rm -rf /tmp/x && echo done");
  assert.equal(compound.blocked, true);
  assert.equal(compound.value.queued, true);
  assert.equal(compound.value.command, "rm -rf /tmp/x && echo done");
  const compoundStored = [...trashService.pendingConfirmations.values()][0];
  assert.equal(compoundStored.trashScript, undefined, "compound commands never get a trash script");
  const compoundApproved = await trashService.pendingConfirmationApprove({ confirmationId: compoundStored.confirmationId });
  assert.equal(compoundApproved.value.executed, true);
  assert.ok(trashWrites.at(-1).includes("\x15rm -rf /tmp/x && echo done\r"), "compound approval still submits the literal command via the PTY");
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

// A blocked ssh_exec renders a copyable command card, not a thrown error.
// The card is bilingual: the English wording is asserted here, and the same
// render is checked against the Chinese dictionary further down.
{
  const sshExecTool = registeredTools.find((t) => t.name === "ssh_exec");
  const baseBlocked = { connectionId: "live", host: "192.0.2.10", exitCode: null, stdout: "", stderr: "", cwd: null, commandId: "(blocked)", startedAt: "2026-08-20T00:00:00.000Z", finishedAt: "2026-08-20T00:00:00.000Z", durationMs: 0, truncated: false, timedOut: false, redacted: false };
  const prefilledCard = sshExecTool.output.render({}, { ...baseBlocked, blocked: true, reason: t("Delete files or directories"), command: "rm -rf /tmp/x", prefilled: false, queued: true });
  assert.equal(prefilledCard.length, 1);
  assert.match(prefilledCard[0].text, /Blocked: Delete files or directories/);
  assert.match(prefilledCard[0].text, /not run/);
  assert.match(prefilledCard[0].text, /confirmation card/);
  assert.match(prefilledCard[0].text, /```bash\nrm -rf \/tmp\/x\n```/);
  assert.match(prefilledCard[0].text, /Do not retry/);
  assert.match(prefilledCard[0].text, /work around/);
  const copyCard = sshExecTool.output.render({}, { ...baseBlocked, blocked: true, reason: t("Delete files or directories"), command: "rm -rf /tmp/x", prefilled: false, queued: false });
  assert.match(copyCard[0].text, /paste it into the terminal on the right/i);
  assert.match(copyCard[0].text, /```bash/);
  assert.match(copyCard[0].text, /Do not retry/);
  // Normal (non-blocked) ssh_exec output renders the cwd note, then output.
  const normalCard = sshExecTool.output.render({}, { connectionId: "live", host: "192.0.2.10", exitCode: 0, stdout: "ok\n", stderr: "", cwd: "/root/KVideo", commandId: "cmd-1", startedAt: "x", finishedAt: "x", durationMs: 1, truncated: false, timedOut: false, redacted: false });
  assert.equal(normalCard[0].text, "[cwd: /root/KVideo]\nok\n");
  // Unknown cwd spells out the home fallback instead of printing "null".
  const fallbackCard = sshExecTool.output.render({}, { connectionId: "live", host: "192.0.2.10", exitCode: 0, stdout: "ok\n", stderr: "", cwd: null, commandId: "cmd-1", startedAt: "x", finishedAt: "x", durationMs: 1, truncated: false, timedOut: false, redacted: false });
  assert.match(fallbackCard[0].text, /^\[cwd: login directory — no interactive shell directory detected\]\nok\n$/);
}

// sftp_delete still queues a confirmation card; for a simple literal path the
// card carries a prepared trash script, so operator approval performs the
// reversible move instead of a real rm.
{
  const sftpTool = registeredTools.find((t) => t.name === "sftp_delete");
  service.connections = new Map([["sftp-conn", { host: "192.0.2.10", port: 22, username: "root", sessions: new Set(["sftp-sess"]) }]]);
  service.sessions = new Map([["sftp-sess", { id: "sftp-sess", exited: null, stream: { write() {} }, inputLine: "", inputKnown: true, buffer: "" }]]);
  const sftpRes = await sftpTool.execute({ path: "/tmp/foo", connection_id: "sftp-conn" });
  assert.equal(sftpRes.blocked, true);
  assert.equal(sftpRes.queued, true);
  assert.equal(sftpRes.path, "/tmp/foo");
  assert.equal(sftpRes.command, "rm -rf '/tmp/foo'");
  assert.equal(sftpRes.reason, t("Delete files or directories (SFTP)"), "the SFTP reason is translated too");
  const sftpStored = [...service.pendingConfirmations.values()].find((item) => item.command === "rm -rf '/tmp/foo'");
  assert.ok(sftpStored.trashScript && sftpStored.trashScript.includes("'/tmp/foo'"), "the card silently carries the prepared trash script");
  const sftpCard = sftpTool.output.render({}, sftpRes);
  assert.match(sftpCard[0].text, /confirmation card/);
  assert.match(sftpCard[0].text, /```bash\nrm -rf '\/tmp\/foo'\n```/);
  assert.match(sftpCard[0].text, /Do not retry/);
  assert.ok(!/回收站|trash/i.test(sftpCard[0].text), "the card text is unchanged — no trash advertising");
  // Omitted connection_id must resolve to the current right-side connection,
  // otherwise the card would claim a queue entry while none exists.
  service.activeConnectionId = "sftp-conn";
  const activeSftpRes = await sftpTool.execute({ path: "/tmp/current.txt" });
  assert.equal(activeSftpRes.queued, true);
  // Paths with spaces / quotes are POSIX single-quoted so they cannot escape.
  const sftpRes2 = await sftpTool.execute({ path: "/tmp/a b'c", connection_id: "sftp-conn" });
  assert.equal(sftpRes2.command, "rm -rf '/tmp/a b'\\''c'");
  // A path containing a control character cannot ride the trash script, and
  // the tab also makes the command unprefillable → copyable card fallback.
  const tabRes = await sftpTool.execute({ path: "/tmp/a\tb", connection_id: "sftp-conn" });
  assert.equal(tabRes.blocked, true);
  assert.equal(tabRes.queued, false);
  assert.match(sftpTool.output.render({}, tabRes)[0].text, /paste it into the terminal on the right/i);
}

// db_execute blocked SQL returns a copyable SQL card (not a thrown error); only
// genuine db failures still throw. Agent calls declare their origin so the
// guard can hold back the operator-only purge step.
{
  const dbTool = registeredTools.find((t) => t.name === "db_execute");
  let seenOrigin;
  // The guard's message is a plain string produced by the db layer; this stub
  // plays the role of that message, so it is written in the source language.
  service.dbExecute = async (request) => {
    seenOrigin = request.origin;
    return { ok: false, error: { code: "unsafe-sql", message: "TRUNCATE is irreversible and stops the database; blocked" } };
  };
  const dbRes = await dbTool.execute({ db_connection_id: "x", sql: "TRUNCATE TABLE t" });
  assert.equal(seenOrigin, "agent", "the tool declares the agent origin to the guard");
  assert.equal(dbRes.blocked, true);
  assert.equal(dbRes.affectedRows, 0);
  assert.equal(dbRes.sql, "TRUNCATE TABLE t");
  assert.match(dbRes.reason, /TRUNCATE/);
  const dbCard = dbTool.output.render({}, dbRes);
  assert.match(dbCard[0].text, /Blocked: TRUNCATE/);
  assert.match(dbCard[0].text, /did not run/);
  assert.match(dbCard[0].text, /```sql\nTRUNCATE TABLE t\n```/);
  assert.match(dbCard[0].text, /Do not retry/);

  // A guard envelope with backups surfaces the backup list on the card.
  service.dbExecute = async () => ({ ok: false, error: { code: "unsafe-sql", message: "Blocked", backup: [{ target: "t", path: "/tmp/b.csv", bytes: 12, truncated: false, error: null }] } });
  const backupRes = await dbTool.execute({ db_connection_id: "x", sql: "TRUNCATE TABLE t" });
  assert.deepEqual(backupRes.backup, [{ target: "t", path: "/tmp/b.csv", bytes: 12, truncated: false, error: null }]);
  assert.match(dbTool.output.render({}, backupRes)[0].text, /Automatically backed up/);
  assert.match(dbTool.output.render({}, backupRes)[0].text, /\/tmp\/b\.csv/);

  // A quarantined DROP renders the rename and the operator-only next step.
  const quarantinedValue = { affectedRows: 0, truncated: false, quarantined: true, renamedTo: "t_to_be_dropped_20260924", notice: "Run the final drop yourself in the database panel: DROP TABLE t_to_be_dropped_20260924", backup: [{ target: "t", path: "/tmp/b.csv", bytes: 12, truncated: false, error: null }] };
  const quarantineCard = dbTool.output.render({}, quarantinedValue);
  assert.match(quarantineCard[0].text, /♻️ DROP was converted to a quarantine rename/);
  assert.match(quarantineCard[0].text, /t_to_be_dropped_20260924/);
  assert.match(quarantineCard[0].text, /Automatically backed up/);

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
  assert.match(guarded.blockedReason, /Blocked by the safety policy/);
  assert.equal(guarded.blockedReason, t("Blocked by the safety policy: Delete files or directories. Do not retry or work around it; the operator must confirm execution in the terminal on the right."), "the agent-driven Enter is refused with the same category message the policy layer builds");
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
