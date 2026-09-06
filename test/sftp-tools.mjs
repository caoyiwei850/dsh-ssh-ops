// SFTP host-side tools: directory listing mapping, mkdir, delete (file vs
// directory dispatch), rename, and the error-envelope codes — all against a
// fake SFTP subsystem (callback style, mirroring ssh2's sftp object).
import assert from "node:assert/strict";
import SshOpsService from "../src/index.js";

const DIR_MODE = 0o040755;
const FILE_MODE = 0o100644;

/** Fake ssh2 sftp subsystem driven by an in-memory tree. */
function fakeSftp(tree) {
  return {
    readdir(path, cb) {
      const dir = tree[path];
      if (!dir || !dir.isDirectory) { cb(new Error(`${path}: not a directory`)); return; }
      cb(null, [...dir.children]);
    },
    stat(path, cb) {
      const node = tree[path];
      if (!node) { cb(new Error(`${path}: no such file`)); return; }
      cb(null, { mode: node.mode, size: node.size ?? 0, mtime: 1700000000 });
    },
    mkdir(path, cb) { if (tree[path]) { cb(new Error(`${path}: exists`)); return; } tree[path] = { isDirectory: true, mode: DIR_MODE, children: [] }; cb(null); },
    rmdir(path, cb) { if (!tree[path]) { cb(new Error(`${path}: no such file`)); return; } delete tree[path]; cb(null); },
    unlink(path, cb) { if (!tree[path]) { cb(new Error(`${path}: no such file`)); return; } delete tree[path]; cb(null); },
    rename(from, to, cb) { if (!tree[from]) { cb(new Error(`${from}: no such file`)); return; } tree[to] = tree[from]; delete tree[from]; cb(null); }
  };
}

function makeService(tree) {
  const service = Object.create(SshOpsService.prototype);
  service.config = {};
  service.connections = new Map();
  service.activeConnectionId = "c1";
  const conn = { id: "c1", sessions: new Set(), sftp: fakeSftp(tree), dead: false };
  service.connections.set("c1", conn);
  return service;
}

// ── sftpList: entry projection (type bit, size, mtime in ms) ──
{
  const tree = {
    "/srv": { isDirectory: true, mode: DIR_MODE, children: [
      { filename: "app.log", attrs: { mode: FILE_MODE, size: 1234, mtime: 1700000000 } },
      { filename: "conf.d", attrs: { mode: DIR_MODE, size: 4096, mtime: 1700000001 } }
    ] }
  };
  const service = makeService(tree);
  const result = await service.sftpList({ path: "/srv" });
  assert.equal(result.ok, true);
  assert.equal(result.value.path, "/srv");
  assert.equal(result.value.entries.length, 2);
  const [file, dir] = result.value.entries;
  assert.equal(file.name, "app.log");
  assert.equal(file.isDirectory, false);
  assert.equal(file.size, 1234);
  assert.equal(file.mtime, 1700000000000, "mtime is scaled to milliseconds");
  assert.equal(dir.isDirectory, true);

  const missing = await service.sftpList({ path: "/nope" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "sftp-list-failed");
}

// ── sftpMkdir ──
{
  const tree = { "/srv": { isDirectory: true, mode: DIR_MODE, children: [] } };
  const service = makeService(tree);
  const created = await service.sftpMkdir({ path: "/srv/newdir" });
  assert.equal(created.ok, true);
  assert.equal(created.value.path, "/srv/newdir");
  assert.ok(tree["/srv/newdir"], "directory created in the fake tree");

  const clash = await service.sftpMkdir({ path: "/srv/newdir" });
  assert.equal(clash.ok, false);
  assert.equal(clash.error.code, "sftp-mkdir-failed");
}

// ── sftpDelete: stat-driven dispatch between unlink and rmdir ──
{
  const tree = {
    "/tmp/a.txt": { mode: FILE_MODE, size: 3 },
    "/tmp/dir": { isDirectory: true, mode: DIR_MODE, children: [] }
  };
  const service = makeService(tree);
  const file = await service.sftpDelete({ path: "/tmp/a.txt" });
  assert.equal(file.ok, true);
  assert.equal(file.value.isDirectory, false);
  assert.ok(!tree["/tmp/a.txt"], "file removed via unlink");

  const dir = await service.sftpDelete({ path: "/tmp/dir" });
  assert.equal(dir.ok, true);
  assert.equal(dir.value.isDirectory, true);
  assert.ok(!tree["/tmp/dir"], "directory removed via rmdir");

  const missing = await service.sftpDelete({ path: "/tmp/ghost" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "sftp-delete-failed");
}

// ── sftpRename ──
{
  const tree = { "/tmp/old": { mode: FILE_MODE, size: 3 } };
  const service = makeService(tree);
  const renamed = await service.sftpRename({ from: "/tmp/old", to: "/tmp/new" });
  assert.equal(renamed.ok, true);
  assert.deepEqual(renamed.value, { from: "/tmp/old", to: "/tmp/new" });
  assert.ok(tree["/tmp/new"] && !tree["/tmp/old"]);

  const missing = await service.sftpRename({ from: "/tmp/ghost", to: "/tmp/x" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "sftp-rename-failed");
}

// ── connection resolution errors surface as no-connection ──
{
  const service = makeService({});
  const result = await service.sftpList({ connectionId: "unknown", path: "/" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "no-connection");
}

// ── tool layer: sftp_list registration and execute wiring ──
{
  const tree = {
    "/etc": { isDirectory: true, mode: DIR_MODE, children: [
      { filename: "hostname", attrs: { mode: FILE_MODE, size: 12, mtime: 1700000000 } }
    ] }
  };
  const service = makeService(tree);
  const registered = [];
  service.registerTools({ tools: { register: (def) => registered.push(def) }, effect: () => {} });
  const sftpList = registered.find((def) => def.name === "sftp_list");
  assert.ok(sftpList, "sftp_list tool is registered");
  const value = await sftpList.execute({ path: "/etc" });
  assert.equal(value.entries[0].name, "hostname");
}

console.log("sftp tools: list/mkdir/delete/rename dispatch + error codes: all cases passed");
