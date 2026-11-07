import { test } from "node:test";
import assert from "node:assert/strict";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import SshOpsService from "../src/index.js";
import { registerSessionLogTools } from "../src/tools/session-log.js";
import { registerSftpTools } from "../src/tools/sftp.js";

function registered(register, service) {
  const tools = []; let gate;
  register({ tools: { register: (tool) => tools.push(tool) }, on: (_event, handler) => { gate = handler; }, get: () => ({ request: async () => "allowed-once" }) }, service);
  return { tools, gate };
}

test("session log read and search return redacted strings matching their schemas", async () => {
  const service = {
    sessionLogSnapshot: async () => ({ ok: true, value: Buffer.from("PASSWORD=secret") }),
    sessionLogSearch: async () => ({ ok: true, value: { hits: [{ offset: 0, line: "PASSWORD=secret" }], scannedBytes: 15, stoppedEarly: false } })
  };
  const { tools } = registered(registerSessionLogTools, service);
  for (const name of ["ssh_session_log_read", "ssh_session_log_search"]) {
    const tool = tools.find((item) => item.name === name);
    const value = await tool.execute({ session_id: "s", query: "password" });
    assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, "value"), []);
    const text = tool.output.render({}, value)[0].text;
    assert.match(text, /PASSWORD=\*\*\*/);
    assert.doesNotMatch(text, /secret|\[object Object\]/);
  }
});

test("approved SFTP delete binds the active connection when id is omitted", async () => {
  const service = Object.create(SshOpsService.prototype);
  service.connections = new Map([["c1", { id: "c1", host: "example" }]]);
  service.activeConnectionId = "c1";
  service.sessionDirectoryOf = () => "";
  service.remoteBindingFor = () => undefined;
  service.resolveLoginShell = async () => "bash";
  let used;
  service.runPreparedExec = async (id) => { used = id; return { ok: true, value: { exitCode: 0, stderr: "", timedOut: false } }; };
  const { tools, gate } = registered(registerSftpTools, service);
  const exec = { name: "sftp_delete", arguments: { path: "/tmp/a" }, agent: {}, callId: "a" };
  await gate(exec, () => "next");
  await tools.find((item) => item.name === "sftp_delete").execute(exec.arguments, exec);
  assert.equal(used, "c1");
});

test("bound workspace resolves the record id rather than a missing connectionId", async () => {
  const service = Object.create(SshOpsService.prototype);
  service.sessionDirectoryOf = () => "/work";
  service.remoteBindingFor = () => ({ record: { workspacePath: "/work", remotePath: "/srv", profileId: "p" }, relative: "" });
  service.requireRemoteWorkspaceConnection = async () => ({ id: "bound" });
  service.assertRemoteWorkspaceTarget = async () => {};
  const result = await service.resolveRemoteToolPath({ path: "a" }, {});
  assert.equal(result.connectionId, "bound");
});

test("approved Windows deletion uses reversible SFTP move, never POSIX shell", async () => {
  const service = Object.create(SshOpsService.prototype);
  const connection = { id: "c1", host: "example", loginShell: "cmd" };
  service.connections = new Map([["c1", connection]]);
  service.activeConnectionId = "c1";
  service.sessionDirectoryOf = () => ""; service.remoteBindingFor = () => undefined;
  service.resolveLoginShell = async () => "cmd";
  service.runPreparedExec = async () => { throw new Error("POSIX command must not run on Windows"); };
  service.moveSftpToTrash = async (id, path) => { assert.equal(id, "c1"); assert.equal(path, "/file"); return { ok: true, value: { trashPath: "/.dsh-trash/example" } }; };
  const { tools, gate } = registered(registerSftpTools, service);
  const exec = { name: "sftp_delete", arguments: { path: "/file" }, agent: {}, callId: "w" };
  await gate(exec, () => "next");
  const result = await tools.find((item) => item.name === "sftp_delete").execute(exec.arguments, exec);
  assert.equal(result.trashPath, "/.dsh-trash/example");
});

test("SFTP trash move supports Windows-style SFTP home paths and refuses unsafe targets", async () => {
  const service = Object.create(SshOpsService.prototype);
  const conn = { id: "c1" }; service.connections = new Map([["c1", conn]]); service.activeConnectionId = "c1";
  let rename;
  const sftp = {
    realpath(_path, cb) { cb(null, "C:/Users/operator"); },
    mkdir(_path, cb) { cb(null); },
    rename(from, to, cb) { rename = { from, to }; cb(null); }
  };
  service.requireSftp = async () => ({ ok: true, sftp });
  const result = await service.moveSftpToTrash("c1", "C:/work/report.txt");
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(rename.from, "C:/work/report.txt");
  assert.match(rename.to, /^C:\/Users\/operator\/\.dsh-trash\/report\.txt-/);
  assert.equal(result.value.trashPath, rename.to);
  for (const path of ["C:/", "C:/Users/operator", "C:/Users/operator/.dsh-trash", "C:/Users/operator/.dsh-trash/old", "C:\\Users\\operator\\file"]) {
    rename = null;
    const refused = await service.moveSftpToTrash("c1", path);
    assert.equal(refused.ok, false, path);
    assert.equal(rename, null, path);
  }
  sftp.rename = (_from, _to, cb) => cb(new Error("cross-device rename unsupported"));
  const failure = await service.moveSftpToTrash("c1", "C:/work/file");
  assert.equal(failure.ok, false);
  assert.match(failure.error.message, /cross-device/);
  assert.match(failure.error.message, /outcome may be unknown/);
  assert.match(failure.error.message, /before retrying/);
});

test("approval cannot be reused if the active server changes before execution", async () => {
  const service = Object.create(SshOpsService.prototype);
  service.connections = new Map([["one", { id: "one", host: "one" }], ["two", { id: "two", host: "two" }]]);
  service.activeConnectionId = "one"; service.sessionDirectoryOf = () => ""; service.remoteBindingFor = () => undefined;
  let ran = false; service.runPreparedExec = async () => { ran = true; throw new Error("must not run"); };
  const { tools, gate } = registered(registerSftpTools, service);
  const execution = { name: "sftp_delete", arguments: { path: "/tmp/a" }, agent: {}, callId: "switch" };
  await gate(execution, () => "next"); service.activeConnectionId = "two";
  const result = await tools.find((item) => item.name === "sftp_delete").execute(execution.arguments, execution);
  assert.equal(result.blocked, true); assert.equal(ran, false);
});


test("unresponsive SFTP requests time out without reporting an uncertain rename as failed", async () => {
  const service = Object.create(SshOpsService.prototype);
  service.config = { sftpOperationTimeoutMs: 20 };
  service.connections = new Map([["c", { id: "c" }]]); service.activeConnectionId = "c";
  const sftp = { realpath(_path, _cb) {} };
  service.requireSftp = async () => ({ ok: true, sftp });
  const first = await service.moveSftpToTrash("c", "/tmp/file");
  assert.equal(first.ok, false); assert.match(first.error.message, /timed out/);
  sftp.realpath = (_path, cb) => cb(null, "/home/user");
  sftp.mkdir = (_path, cb) => cb(null);
  sftp.rename = (_from, _to, _cb) => {};
  const second = await service.moveSftpToTrash("c", "/tmp/file");
  assert.equal(second.ok, false); assert.match(second.error.message, /outcome may be unknown/);
});
