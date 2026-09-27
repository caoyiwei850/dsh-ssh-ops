// Directory batch transfer: scheduling policy (small files parallel, big
// files exclusive), counters, per-file failure collection — plus the service
// upload/download round trip against an in-memory SFTP server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable, Readable } from "node:stream";
import {
  runTransferTasks,
  joinRemotePath,
  splitRemotePath,
  SFTP_DIR_SMALL_CONCURRENCY
} from "../src/sftp-dir.js";
import SshOpsService from "../src/index.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("joinRemotePath and splitRemotePath handle root and nested paths", () => {
  assert.equal(joinRemotePath("/", "etc"), "/etc");
  assert.equal(joinRemotePath("/var/log", "app"), "/var/log/app");
  assert.equal(joinRemotePath("/var/log/", "app"), "/var/log/app");
  assert.deepEqual(splitRemotePath("/var/log"), { parent: "/var", name: "log" });
  assert.deepEqual(splitRemotePath("/etc"), { parent: "/", name: "etc" });
});

test("runTransferTasks bounds small-file concurrency and keeps big files exclusive", async () => {
  let inFlight = 0;
  let maxSmallInFlight = 0;
  const overlaps = [];
  let bigInFlight = 0;
  const makeTask = (name, size, ms) => ({
    path: name,
    size,
    run: async () => {
      if (size > 512 * 1024) {
        if (bigInFlight > 0) overlaps.push(`big ${name} during big`);
        bigInFlight += 1;
        await sleep(ms);
        bigInFlight -= 1;
        return;
      }
      inFlight += 1;
      maxSmallInFlight = Math.max(maxSmallInFlight, inFlight);
      await sleep(ms);
      inFlight -= 1;
    }
  });
  const tasks = [];
  for (let i = 0; i < 20; i += 1) tasks.push(makeTask(`small-${i}`, 100, 5));
  for (let i = 0; i < 3; i += 1) tasks.push(makeTask(`big-${i}`, 600 * 1024, 5));
  const result = await runTransferTasks(tasks);
  assert.equal(result.files, 23);
  assert.equal(result.bytes, 3 * 600 * 1024 + 20 * 100);
  assert.equal(result.failures.length, 0);
  assert.ok(maxSmallInFlight <= SFTP_DIR_SMALL_CONCURRENCY, `small concurrency ${maxSmallInFlight} exceeds bound`);
  assert.ok(maxSmallInFlight > 1, "small files should overlap each other");
  assert.equal(overlaps.length, 0, "big files must never overlap each other");
});

test("runTransferTasks collects per-task failures without aborting the batch", async () => {
  const result = await runTransferTasks([
    { path: "ok-1", size: 1, run: async () => {} },
    { path: "bad", size: 1, run: async () => { throw new Error("boom"); } },
    { path: "ok-2", size: 2, run: async () => {} }
  ]);
  assert.equal(result.files, 2);
  assert.equal(result.bytes, 3);
  assert.deepEqual(result.failures, [{ path: "bad", error: "boom" }]);
});

// ── in-memory SFTP server for the service round trip ────────────────────────

function makeFakeSftp() {
  const files = new Map();
  const dirs = new Set(["/"]);
  const modeDir = 0o040755;
  const modeFile = 0o100644;
  const sftp = {
    files,
    dirs,
    mkdir(path, cb) {
      if (dirs.has(path)) return cb(new Error("Failure"));
      const { parent } = split(path);
      if (!dirs.has(parent)) return cb(new Error("no such directory"));
      dirs.add(path);
      cb(null);
    },
    stat(path, cb) {
      if (dirs.has(path)) return cb(null, { mode: modeDir, size: 0 });
      if (files.has(path)) return cb(null, { mode: modeFile, size: files.get(path).length });
      cb(new Error("not found"));
    },
    readdir(path, cb) {
      if (!dirs.has(path)) return cb(new Error("not found"));
      const prefix = path === "/" ? "/" : `${path}/`;
      const names = new Map();
      for (const key of dirs) {
        if (key !== "/" && key.startsWith(prefix) && !key.slice(prefix.length).includes("/")) {
          names.set(key.slice(prefix.length), { filename: key.slice(prefix.length), attrs: { mode: modeDir, size: 0 } });
        }
      }
      for (const key of files.keys()) {
        if (key.startsWith(prefix) && !key.slice(prefix.length).includes("/")) {
          names.set(key.slice(prefix.length), { filename: key.slice(prefix.length), attrs: { mode: modeFile, size: files.get(key).length } });
        }
      }
      cb(null, [...names.values()]);
    },
    createWriteStream(path) {
      const chunks = [];
      const ws = new Writable({
        write(chunk, _enc, done) {
          chunks.push(chunk);
          done();
        },
        final(done) {
          files.set(path, Buffer.concat(chunks));
          done();
        }
      });
      return ws;
    },
    createReadStream(path) {
      const data = files.get(path);
      return Readable.from(data === undefined ? [] : [data]);
    }
  };
  return sftp;
}

function split(path) {
  const normalized = path.replace(/\/+$/, "") || "/";
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return { parent: "/", name: normalized.slice(index + 1) };
  return { parent: normalized.slice(0, index), name: normalized.slice(index + 1) };
}

function makeService(fakeSftp) {
  const service = Object.create(SshOpsService.prototype);
  service.activeConnectionId = null;
  service.connections = new Map([["c1", { id: "c1", sftp: fakeSftp, client: null }]]);
  return service;
}

test("sftpUploadDir creates the remote tree and reports per-file failures", async () => {
  const localRoot = await mkdtemp(join(tmpdir(), "dsh-up-"));
  try {
    await mkdir(join(localRoot, "sub"), { recursive: true });
    await writeFile(join(localRoot, "a.txt"), "alpha");
    await writeFile(join(localRoot, "sub", "big.bin"), Buffer.alloc(600 * 1024, 7));
    const fakeSftp = makeFakeSftp();
    const service = makeService(fakeSftp);

    const result = await service.sftpUploadDir({ connectionId: "c1", localPath: localRoot, remotePath: "/opt/app" });
    assert.equal(result.ok, true);
    const value = result.value;
    assert.equal(value.files, 2);
    assert.equal(value.bytes, 600 * 1024 + 5);
    assert.equal(value.failed.length, 0);
    assert.ok(value.directories >= 2, "root and sub are counted");
    assert.deepEqual(fakeSftp.files.get("/opt/app/a.txt").toString(), "alpha");
    assert.equal(fakeSftp.files.get("/opt/app/sub/big.bin").length, 600 * 1024);
  } finally {
    await rm(localRoot, { recursive: true, force: true });
  }
});

test("sftpDownloadDir recreates the tree locally", async () => {
  const localRoot = await mkdtemp(join(tmpdir(), "dsh-down-"));
  try {
    const fakeSftp = makeFakeSftp();
    fakeSftp.dirs.add("/data");
    fakeSftp.dirs.add("/data/nested");
    fakeSftp.files.set("/data/one.txt", Buffer.from("first"));
    fakeSftp.files.set("/data/nested/two.txt", Buffer.from("second"));
    const service = makeService(fakeSftp);

    const result = await service.sftpDownloadDir({ connectionId: "c1", remotePath: "/data", localPath: join(localRoot, "out") });
    assert.equal(result.ok, true);
    assert.equal(result.value.files, 2);
    assert.equal(result.value.bytes, 11);
    assert.equal(result.value.failed.length, 0);
    assert.equal(await readFile(join(localRoot, "out", "one.txt"), "utf8"), "first");
    assert.equal(await readFile(join(localRoot, "out", "nested", "two.txt"), "utf8"), "second");
  } finally {
    await rm(localRoot, { recursive: true, force: true });
  }
});
