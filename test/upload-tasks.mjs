import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import SshOpsService from "../src/index.js";
import { TransferTasks } from "../src/transfer-tasks.js";
import { registerSftpTools } from "../src/tools/sftp.js";
import { sftpTransferListResultSchema, sftpTransferCancelResultSchema } from "../src/schemas.js";

function fakeSftp() {
  const files = new Map([["/dest", Buffer.from("original")]]);
  let fail = true;
  return {
    files,
    open(path, flags, cb) { if (flags === "w") files.set(path, Buffer.alloc(0)); if (!files.has(path)) return cb(new Error("missing")); cb(null, path); },
    write(path, buf, _off, length, pos, cb) {
      if (fail && pos === 32768) { fail = false; setTimeout(() => cb(new Error("interrupted")), 20); return; }
      const data = files.get(path);
      const out = Buffer.alloc(Math.max(data.length, pos + length)); data.copy(out); buf.copy(out, pos, 0, length); files.set(path, out);
      setTimeout(() => cb(null), pos === 0 ? 1 : 2);
    },
    close(_handle, cb) { cb(null); },
    stat(path, cb) { const data = files.get(path); if (!data) return cb(new Error("missing")); cb(null, { size: data.length }); },
    createReadStream(path, options) { return Readable.from([options ? files.get(path).subarray(options.start, options.end + 1) : files.get(path)]); },
    rename(from, to, cb) { files.set(to, files.get(from)); files.delete(from); cb(null); }
  };
}

function setup(sftp) {
  const service = Object.create(SshOpsService.prototype);
  service.transferTasks = new TransferTasks();
  const connection = { id: "c1", dead: false };
  service.resolveConnection = () => ({ ok: true, connection });
  service.requireSftp = async () => ({ ok: true, sftp });
  return service;
}

test("failed upload preserves target and verified resume completes it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-transfer-"));
  const source = join(dir, "file");
  const bytes = Buffer.alloc(256 * 1024); for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;
  const sftp = fakeSftp(); const service = setup(sftp);
  try {
    await writeFile(source, bytes);
    const failed = await service.sftpUploadLocalFile({ localPath: source, remotePath: "/dest" });
    assert.equal(failed.ok, false);
    assert.equal(sftp.files.get("/dest").toString(), "original");
    const [task] = service.sftpTransferList({ connectionId: "c1" }).value.transfers;
    assert.equal(task.status, "failed"); assert.ok(task.sent > 0);
    const resumed = await service.sftpUploadLocalFile({ localPath: source, remotePath: "/dest", resumeId: task.id });
    assert.equal(resumed.ok, true, resumed.error?.message);
    assert.equal(resumed.value.resumed, true);
    assert.deepEqual(sftp.files.get("/dest"), bytes);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("resume refuses a modified source or remote prefix", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-transfer-")); const source = join(dir, "file");
  const bytes = Buffer.alloc(256 * 1024, 7); const sftp = fakeSftp(); const service = setup(sftp);
  try {
    await writeFile(source, bytes);
    await service.sftpUploadLocalFile({ localPath: source, remotePath: "/dest" });
    const task = [...service.transferTasks.entries.values()][0];
    await writeFile(source, Buffer.alloc(bytes.length, 8));
    assert.match((await service.sftpUploadLocalFile({ localPath: source, remotePath: "/dest", resumeId: task.id })).error.message, /changed/);
    await writeFile(source, bytes);
    sftp.files.get(task.partial)[0] ^= 1;
    assert.match((await service.sftpUploadLocalFile({ localPath: source, remotePath: "/dest", resumeId: task.id })).error.message, /does not match/);
    assert.equal(sftp.files.get("/dest").toString(), "original");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("task cancellation is scoped to the connection and remains idempotent", () => {
  const tasks = new TransferTasks(); const task = tasks.start({ connectionId: "one", source: "a", target: "b", total: 1 });
  assert.equal(tasks.cancel(task.id, "other"), false);
  assert.equal(task.controller.signal.aborted, false);
  assert.equal(tasks.cancel(task.id, "one"), true);
  assert.equal(task.controller.signal.aborted, true);
});


test("a dropped connection reconnects through the existing connection and verifies the checkpoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-transfer-")); const source = join(dir, "file");
  const bytes = Buffer.alloc(256 * 1024, 42); const sftp = fakeSftp(); const service = setup(sftp);
  const conn = service.resolveConnection().connection;
  const write = sftp.write;
  sftp.write = (...args) => {
    const cb = args.pop();
    write(...args, (error) => { if (error) conn.dead = true; cb(error); });
  };
  let reconnects = 0;
  service.ensureAlive = async () => { reconnects += 1; conn.dead = false; return true; };
  try {
    await writeFile(source, bytes);
    const result = await service.sftpUploadLocalFile({ localPath: source, remotePath: "/dest" });
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(result.value.resumed, true);
    assert.equal(reconnects, 1);
    assert.deepEqual(sftp.files.get("/dest"), bytes);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("space check and final digest reject unsafe commits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-transfer-")); const source = join(dir, "file");
  const bytes = Buffer.alloc(8192, 3); const sftp = fakeSftp(); const service = setup(sftp);
  try {
    await writeFile(source, bytes);
    sftp.ext_openssh_statvfs = (_path, cb) => cb(null, { f_bavail: 1, f_frsize: 1024 });
    const noSpace = await service.sftpUploadLocalFile({ localPath: source, remotePath: "/dest" });
    assert.equal(noSpace.ok, false); assert.match(noSpace.error.message, /available/);
    delete sftp.ext_openssh_statvfs;
    const write = sftp.write;
    sftp.write = (handle, buffer, off, length, pos, cb) => {
      write(handle, buffer, off, length, pos, (error) => { if (!error) sftp.files.get(handle)[0] ^= 1; cb(error); });
    };
    const corrupt = await service.sftpUploadLocalFile({ localPath: source, remotePath: "/dest" });
    assert.equal(corrupt.ok, false); assert.match(corrupt.error.message, /verification failed/);
    assert.equal(sftp.files.get("/dest").toString(), "original");
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test("operator cancellation keeps the original destination and allows resume", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-transfer-")); const source = join(dir, "file");
  const bytes = Buffer.alloc(256 * 1024, 11); const sftp = fakeSftp(); const service = setup(sftp);
  const controller = new AbortController();
  const write = sftp.write;
  let aborted = false;
  sftp.write = (...args) => { const cb = args.pop(); write(...args, (error) => { cb(error); if (!aborted && !error) { aborted = true; controller.abort(new Error("operator cancelled")); } }); };
  try {
    await writeFile(source, bytes);
    const result = await service.sftpUploadLocalFile({ localPath: source, remotePath: "/dest", signal: controller.signal });
    assert.equal(result.ok, false); assert.equal(result.error.code, "sftp-upload-cancelled");
    assert.equal(sftp.files.get("/dest").toString(), "original");
    sftp.write = write;
    const task = [...service.transferTasks.entries.values()][0];
    // The fake server's one simulated write failure may still be outstanding;
    // a retry can fail once, and a subsequent verified retry must succeed.
    let retry = await service.sftpUploadLocalFile({ localPath: source, remotePath: "/dest", resumeId: task.id });
    if (!retry.ok) retry = await service.sftpUploadLocalFile({ localPath: source, remotePath: "/dest", resumeId: task.id });
    assert.equal(retry.ok, true, retry.error?.message);
    assert.deepEqual(sftp.files.get("/dest"), bytes);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test("agent upload preserves workspace binding and cancellation signal", async () => {
  const tools = []; let received;
  const service = {
    resolveRemoteToolPath: async () => ({ connectionId: "bound", path: "/srv/work/file", bound: true, workspaceRoot: "/srv/work" }),
    sftpUploadLocalFile: async (request) => { received = request; return { ok: true, value: { taskId: "t", source: request.localPath, target: request.remotePath, bytes: 5, resumed: false, startOffset: 0 } }; }
  };
  registerSftpTools({ tools: { register: (tool) => tools.push(tool) } }, service);
  const upload = tools.find((tool) => tool.name === "sftp_upload_file");
  assert.ok(upload);
  const signal = new AbortController().signal;
  const value = await upload.execute({ local_path: "/tmp/file", remote_path: "file", resume_id: "t" }, { signal });
  assert.equal(value.taskId, "t"); assert.equal(received.remoteWorkspaceRoot, "/srv/work");
  assert.equal(received.connectionId, "bound"); assert.equal(received.signal, signal); assert.equal(received.resumeId, "t");
  assert.equal(upload.output.render({}, value)[0].type, "text");
});

test("task RPC envelopes satisfy the host wire schemas", () => {
  const tasks = new TransferTasks(); tasks.start({ connectionId: "c1", source: "a", target: "b", total: 1 });
  assert.equal(sftpTransferListResultSchema.safeParse({ ok: true, value: { transfers: tasks.list("c1") } }).success, true);
  assert.equal(sftpTransferCancelResultSchema.safeParse({ ok: true, value: { cancelled: false } }).success, true);
});
