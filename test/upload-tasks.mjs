import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import SshOpsService from "../src/index.js";
import { TransferTasks, transferConnectionIdentity } from "../src/transfer-tasks.js";
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
    unlink(path, cb) { if (!files.has(path)) { const error = new Error("missing"); error.code = "ENOENT"; return cb(error); } files.delete(path); cb(null); },
    stat(path, cb) { const data = files.get(path); if (!data) return cb(new Error("missing")); cb(null, { size: data.length }); },
    createReadStream(path, options) { return Readable.from([options ? files.get(path).subarray(options.start, options.end + 1) : files.get(path)]); },
    rename(from, to, cb) { files.set(to, files.get(from)); files.delete(from); cb(null); }
  };
}

function setup(sftp, { journalPath = null, id = "c1", host = "example" } = {}) {
  const service = Object.create(SshOpsService.prototype);
  service.transferTasks = new TransferTasks({ journalPath });
  const connection = { id, host, port: 22, username: "operator", dead: false };
  service.connections = new Map([[id, connection]]);
  service.resolveConnection = () => ({ ok: true, connectionId: id, connection });
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
    const [task] = (await service.sftpTransferList({ connectionId: "c1" })).value.transfers;
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


test("unfinished upload survives process restart and resumes on the same server", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-transfer-journal-"));
  const source = join(dir, "file"); const journalPath = join(dir, "journal.json");
  const bytes = Buffer.alloc(256 * 1024, 19); const sftp = fakeSftp();
  try {
    await writeFile(source, bytes);
    const first = setup(sftp, { journalPath });
    assert.equal((await first.sftpUploadLocalFile({ localPath: source, remotePath: "/dest" })).ok, false);
    const old = [...first.transferTasks.entries.values()][0];
    assert.ok(old.checkpoint > 0); assert.ok(sftp.files.has(old.partial));
    const journal = await readFile(journalPath, "utf8");
    assert.ok(journal.includes(old.id)); assert.doesNotMatch(journal, /password|privateKey/i);
    if (process.platform !== "win32") assert.equal((await stat(journalPath)).mode & 0o077, 0);
    const second = setup(sftp, { journalPath, id: "new-connection" });
    const listed = await second.sftpTransferList({ connectionId: "new-connection" });
    assert.equal(listed.value.transfers[0].id, old.id);
    const result = await second.sftpUploadLocalFile({ localPath: source, remotePath: "/dest", resumeId: old.id });
    assert.equal(result.ok, true, result.error?.message); assert.equal(result.value.resumed, true);
    assert.deepEqual(sftp.files.get("/dest"), bytes);
    assert.deepEqual(JSON.parse(await readFile(journalPath, "utf8")), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("discard removes only the recorded partial on the matching server", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-transfer-discard-"));
  const source = join(dir, "file"); const journalPath = join(dir, "journal.json");
  const sftp = fakeSftp();
  try {
    await writeFile(source, Buffer.alloc(256 * 1024, 9));
    const first = setup(sftp, { journalPath });
    await first.sftpUploadLocalFile({ localPath: source, remotePath: "/dest" });
    const original = [...first.transferTasks.entries.values()][0];
    const other = setup(sftp, { journalPath, id: "other", host: "other-server" });
    const refused = await other.sftpTransferDiscard({ connectionId: "other", id: original.id });
    assert.equal(refused.ok, false); assert.ok(sftp.files.has(original.partial));
    const restarted = setup(sftp, { journalPath, id: "new-connection" });
    const discarded = await restarted.sftpTransferDiscard({ connectionId: "new-connection", id: original.id });
    assert.equal(discarded.ok, true, discarded.error?.message);
    assert.equal(sftp.files.has(original.partial), false);
    assert.equal(sftp.files.get("/dest").toString(), "original");
    assert.deepEqual(JSON.parse(await readFile(journalPath, "utf8")), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test("durable task identity distinguishes jump chains and saved profiles without storing credentials", () => {
  const base = { host: "target", port: 22, username: "u", profileId: "profile-a", proxyJump: [{ host: "jump-a", username: "j", auth: { password: "do-not-store" } }] };
  const identity = transferConnectionIdentity(base);
  assert.ok(identity); assert.doesNotMatch(identity, /do-not-store|password/);
  assert.notEqual(identity, transferConnectionIdentity({ ...base, profileId: "profile-b" }));
  assert.notEqual(identity, transferConnectionIdentity({ ...base, proxyJump: [{ host: "jump-b", username: "j" }] }));
});


test("concurrent journals merge independent records without exposing active work", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-transfer-concurrent-"));
  const journalPath = join(dir, "journal.json");
  const first = new TransferTasks({ journalPath }); const second = new TransferTasks({ journalPath });
  try {
    await Promise.all([first.load(), second.load()]);
    const props = { identity: "server", connectionId: "c", source: "a", target: "/a", partial: "/a.partial", total: 3, digest: "x", checkpoint: 0 };
    const a = first.start(props); const b = second.start({ ...props, target: "/b", partial: "/b.partial" });
    await Promise.all([first.persist(), second.persist()]);
    const records = JSON.parse(await readFile(journalPath, "utf8"));
    assert.deepEqual(new Set(records.map((record) => record.id)), new Set([a.id, b.id]));
    const third = new TransferTasks({ journalPath });
    await third.load();
    assert.equal(third.entries.size, 0, "active transfers owned by other runtimes are not exposed for discard");
    a.status = "failed"; await first.persist();
    const fourth = new TransferTasks({ journalPath }); await fourth.load();
    assert.equal(fourth.entries.has(a.id), true); assert.equal(fourth.entries.has(b.id), false);
    third.close(); fourth.close();
  } finally { first.close(); second.close(); await rm(dir, { recursive: true, force: true }); }
});

test("cleanup cannot claim a task another runtime has resumed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-transfer-race-"));
  const journalPath = join(dir, "journal.json"); const source = join(dir, "file"); const sftp = fakeSftp();
  try {
    await writeFile(source, Buffer.alloc(256 * 1024, 1));
    const first = setup(sftp, { journalPath });
    await first.sftpUploadLocalFile({ localPath: source, remotePath: "/dest" });
    const task = [...first.transferTasks.entries.values()][0];
    const second = setup(sftp, { journalPath, id: "second" });
    await second.transferTasks.load();
    task.status = "running"; first.transferTasks.ownedIds.add(task.id); await first.transferTasks.persist();
    const result = await second.sftpTransferDiscard({ connectionId: "second", id: task.id });
    assert.equal(result.ok, false);
    assert.match(result.error.message, /active in another DSH process/);
    assert.equal(sftp.files.has(task.partial), true);
    task.status = "failed"; await first.transferTasks.persist();
    first.transferTasks.close(); second.transferTasks.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("failed task records are not evicted at the completed-history limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-transfer-retain-"));
  const tasks = new TransferTasks({ journalPath: join(dir, "journal.json") });
  try {
    await tasks.load();
    for (let i = 0; i < 60; i += 1) {
      const task = tasks.start({ identity: "server", connectionId: "c", source: "local", target: `/t${i}`, partial: `/p${i}`, total: 1, checkpoint: 0, digest: "" });
      task.status = "failed"; tasks.prune();
    }
    await tasks.persist();
    assert.equal(tasks.entries.size, 60);
    assert.equal(JSON.parse(await readFile(tasks.journalPath, "utf8")).length, 60);
  } finally { tasks.close(); await rm(dir, { recursive: true, force: true }); }
});


test("persisting unrelated work does not overwrite a task resumed by another runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-transfer-owner-")); const journalPath = join(dir, "journal.json");
  const first = new TransferTasks({ journalPath }); const second = new TransferTasks({ journalPath });
  try {
    await first.load();
    const props = { identity: "server", connectionId: "c", source: "a", target: "/a", partial: "/a.partial", total: 3, digest: "x", checkpoint: 0 };
    const task = first.start(props); task.status = "failed"; await first.persist();
    await second.load(); const resumed = second.entries.get(task.id); resumed.status = "running"; second.ownedIds.add(task.id); await second.persist();
    const next = first.start({ ...props, target: "/b", partial: "/b.partial" }); await first.persist();
    const records = JSON.parse(await readFile(journalPath, "utf8"));
    assert.equal(records.find((entry) => entry.id === task.id).ownerToken, second.ownerToken);
    assert.ok(records.some((entry) => entry.id === next.id));
  } finally { first.close(); second.close(); await rm(dir, { recursive: true, force: true }); }
});
