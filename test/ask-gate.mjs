import assert from "node:assert/strict";
import SshOpsService from "../src/index.js";
import { registerSshSessionTools } from "../src/tools/ssh-session.js";
import { registerSftpTools } from "../src/tools/sftp.js";

// ask 替换确认卡片（v0.4.0）：tools/pre-execute 钩子经宿主审批通道就危险命令
// 请示操作者——allowed-once 记一次性凭证放行、rejected/cancelled/unavailable
// 一律 deny（fail-closed），工具体经 exec.callId 消费凭证过内层闸。

function makeHarness({ approval } = {}) {
  const service = Object.create(SshOpsService.prototype);
  service.resolveConnection = (id) => ({ ok: true, connectionId: id ?? "conn1", connection: { host: "192.0.2.10", username: "root" } });
  service.resolveExecPolicy = () => ({ mode: "standard", source: "global", allow: [] });
  service.connections = new Map();
  const gates = [];
  const ctx = {
    tools: { register: () => {} },
    on: (event, handler) => { if (event === "tools/pre-execute") gates.push(handler); },
    get: (name) => (name === "approval" ? approval : undefined)
  };
  registerSshSessionTools(ctx, service);
  const sshGate = gates[0];
  gates.length = 0;
  registerSftpTools(ctx, service);
  const sftpGate = gates[0];
  assert.equal(typeof sshGate, "function", "ssh_exec gate hook is registered");
  assert.equal(typeof sftpGate, "function", "sftp_delete gate hook is registered");
  return { service, sshGate, sftpGate };
}

const NEXT = { kind: "next-called" };
const next = () => NEXT;
const execFor = (overrides = {}) => ({
  name: "ssh_exec",
  arguments: { command: "free -h" },
  agent: { id: "agent-1" },
  callId: "call-1",
  signal: undefined,
  ...overrides
});

// ── ssh_exec gate ────────────────────────────────────────────────────────────
{
  // Safe command: no ask, straight through.
  const { service, sshGate } = makeHarness({ approval: { request: async () => { throw new Error("must not ask for safe commands"); } } });
  assert.equal(await sshGate(execFor({ arguments: { command: "free -h" } }), next), NEXT);

  // Dangerous + operator allows: voucher recorded, inner gate consumes it, and
  // the approved command runs (as the reversible trash move for literal rm).
  const executed = [];
  service.runPreparedExec = async (connectionId, prepared, displayCommand) => {
    executed.push({ connectionId, prepared, displayCommand });
    return { ok: true, value: { exitCode: 0, stdout: "moved", stderr: "", cwd: null, commandId: "x", startedAt: "t", finishedAt: "t", durationMs: 0, truncated: false, timedOut: false, redacted: false } };
  };
  let asked = null;
  const { sshGate: allowGate, service: allowService } = makeHarness({
    approval: { request: async (req) => { asked = req; return "allowed-once"; } }
  });
  allowService.runPreparedExec = service.runPreparedExec;
  const gate = await allowGate(execFor({ callId: "call-ok", arguments: { command: "rm -rf /tmp/x" } }), next);
  assert.equal(gate, NEXT, "an approved dangerous command proceeds");
  assert.equal(asked.toolName, "ssh_exec");
  assert.equal(asked.callId, "call-ok");
  assert.match(asked.reason, /AI 请求在 192\.0\.2\.10 上执行危险命令/);
  assert.match(asked.reason, /移入回收站/);
  const run = await allowService.executeCommand({ command: "rm -rf /tmp/x", approvalToken: "call-ok" });
  assert.equal(run.value.exitCode, 0);
  assert.ok(executed[0].prepared.includes(".dsh-trash"), "the reversible trash move is what runs");
  assert.equal(executed[0].displayCommand, "rm -rf /tmp/x");
  assert.equal(allowService.operatorApprovals.size, 0, "voucher consumed exactly once");

  // Dangerous + operator rejects: deny with guidance, nothing executes.
  const { sshGate: rejectGate } = makeHarness({ approval: { request: async () => "rejected" } });
  const rejected = await rejectGate(execFor({ arguments: { command: "reboot" } }), next);
  assert.equal(rejected.kind, "deny");
  assert.match(rejected.reason, /操作者拒绝/);

  // Cancelled: deny.
  const { sshGate: cancelGate } = makeHarness({ approval: { request: async () => "cancelled" } });
  const cancelled = await cancelGate(execFor({ arguments: { command: "reboot" } }), next);
  assert.equal(cancelled.kind, "deny");
  assert.match(cancelled.reason, /取消/);

  // No approval channel on the host: fail closed, never execute.
  const { sshGate: bareGate } = makeHarness({});
  const unavailable = await bareGate(execFor({ arguments: { command: "reboot" } }), next);
  assert.equal(unavailable.kind, "deny");
  assert.match(unavailable.reason, /没有可用的审批通道/);
}

// ── sftp_delete gate ─────────────────────────────────────────────────────────
{
  const { service, sftpGate } = makeHarness({ approval: { request: async (req) => { askedSftp = req; return "allowed-once"; } } });
  let askedSftp = null;
  service.connections = new Map([["conn1", { host: "192.0.2.10", username: "root" }]]);
  service.resolveRemoteToolPath = ({ connectionId, path }) => ({ connectionId: connectionId ?? "conn1", path });
  let deleted = null;
  service.runPreparedExec = async (connectionId, prepared) => {
    deleted = { connectionId, prepared };
    return { ok: true, value: { exitCode: 0, stdout: "moved", stderr: "", cwd: null, commandId: "x", startedAt: "t", finishedAt: "t", durationMs: 0, truncated: false, timedOut: false, redacted: false } };
  };
  const gate = await sftpGate(
    execFor({ name: "sftp_delete", callId: "call-sftp", arguments: { path: "/tmp/foo" } }),
    next
  );
  assert.equal(gate, NEXT, "an approved deletion proceeds");
  assert.match(askedSftp.reason, /AI 请求删除 192\.0\.2\.10 上的：/);
  assert.match(askedSftp.reason, /\/tmp\/foo/);
  assert.equal(service.operatorApprovals.get("call-sftp").command, "rm -rf '/tmp/foo'", "the voucher binds the exact quoted command");
  void deleted; // the body only deletes after its own consume; covered via safety.mjs
}

console.log("ask-gate ok");
