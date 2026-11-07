// Integration test for the offline SFTP server in test-sshd.mjs: boot the
// server, drive it with the same ssh2 client the plugin uses, and prove the
// sandbox both serves files and refuses to escape its root.
import assert from "node:assert/strict";
import net from "node:net";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "ssh2";
import { uploadPipeline } from "../src/sftp-pipeline.js";
import { saveEditorFile } from "../src/sftp-editor-save.js";
const { default: SshOpsService } = await import(process.env.DSH_TEST_BUILT_HOST ? "../lib/index.js" : "../src/index.js");
import { TransferTasks } from "../src/transfer-tasks.js";

const freePort = () => new Promise((resolve) => {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const port = await freePort();
const root = mkdtempSync(join(tmpdir(), "dsh-sshd-sftp-test-"));
writeFileSync(join(root, "seed.txt"), "seeded\n");

const child = spawn(process.execPath, [
  // fileURLToPath: `new URL(...).pathname` on Windows is "/D:/…" and the
  // child exits instantly with code 1 (same URL-pathname class as PR #28).
  fileURLToPath(new URL("../test-sshd.mjs", import.meta.url)),
  String(port), "--sftp-root", root
], { stdio: ["ignore", "pipe", "pipe"] });

const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("test-sshd did not start in time")), 10000);
  child.stdout.on("data", (chunk) => {
    if (String(chunk).includes("listening on")) { clearTimeout(timer); resolve(); }
  });
  child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`test-sshd exited early (${code})`)); });
});

const call = (target, method, ...args) => new Promise((resolve, reject) => {
  target[method](...args, (error, value) => (error ? reject(error) : resolve(value)));
});

let client;
try {
  await ready;
  client = new Client();
  await new Promise((resolve, reject) => {
    client.on("ready", resolve);
    client.on("error", reject);
    client.connect({ host: "127.0.0.1", port, username: "test", password: "test123", readyTimeout: 8000 });
  });
  const sftp = await call(client, "sftp");

  const payload = Buffer.alloc(512 * 1024);
  for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;
  const input = join(root, "pipeline-source.bin");
  writeFileSync(input, payload);
  await uploadPipeline(sftp, input, "/pipeline-upload.bin");
  assert.deepEqual(await call(sftp, "readFile", "/pipeline-upload.bin"), payload);
  await call(sftp, "unlink", "/pipeline-upload.bin");
  const service = Object.create(SshOpsService.prototype);
  service.transferTasks = new TransferTasks();
  const connection = { id: "local-ssh", dead: false };
  service.resolveConnection = () => ({ ok: true, connection });
  service.requireSftp = async () => ({ ok: true, sftp });
  service.ctx = { logger: { warn() {} } };
  const web = createServer((req, res) => service.handleStreamRoute(req, res, {
    requestRejection: () => req.headers["x-test-auth"] === "yes" ? undefined : 401
  }));
  await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));
  try {
    const endpoint = `http://127.0.0.1:${web.address().port}/ssh-ops/stream/file?connectionId=local-ssh&path=%2Fpipeline-source.bin&verify=sha256`;
    assert.equal((await fetch(endpoint)).status, 401, "download requires host authentication");
    const response = await fetch(endpoint, { headers: { "x-test-auth": "yes" } });
    assert.equal(response.status, 200);
    assert.equal(Number(response.headers.get("content-length")), payload.length);
    const downloaded = Buffer.from(await response.arrayBuffer());
    const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
    assert.equal(digest(downloaded), digest(payload), "HTTP stream and SFTP source have the same SHA-256");
    assert.equal(response.headers.get("x-content-sha256"), digest(payload), "download advertises the verified remote digest");
    const resumed = await fetch(`${endpoint}&offset=12345&expectedSha256=${digest(payload)}`, { headers: { "x-test-auth": "yes" } });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.headers.get("x-download-offset"), "12345");
    assert.deepEqual(Buffer.from(await resumed.arrayBuffer()), payload.subarray(12345));
    const stale = await fetch(`${endpoint}&offset=12345&expectedSha256=${"0".repeat(64)}`, { headers: { "x-test-auth": "yes" } });
    assert.equal(stale.status, 409);
    const finished = await fetch(`${endpoint}&offset=${payload.length}&expectedSha256=${digest(payload)}`, { headers: { "x-test-auth": "yes" } });
    assert.equal(finished.status, 200);
    assert.equal((await finished.arrayBuffer()).byteLength, 0);
  } finally { await new Promise((resolve) => web.close(resolve)); }
  const uploaded = await service.sftpUploadLocalFile({ localPath: input, remotePath: "/agent-upload.bin" });
  assert.equal(uploaded.ok, true, uploaded.error?.message);
  assert.deepEqual(await call(sftp, "readFile", "/agent-upload.bin"), payload);
  assert.equal((await service.sftpTransferList({ connectionId: "local-ssh" })).value.transfers[0].status, "done");
  await call(sftp, "unlink", "/agent-upload.bin");
  const moved = await service.moveSftpToTrash("local-ssh", "/seed.txt");
  assert.equal(moved.ok, true, moved.error?.message);
  assert.equal(String(await call(sftp, "readFile", moved.value.trashPath)), "seeded\n");
  await call(sftp, "rename", moved.value.trashPath, "/seed.txt");
  await call(sftp, "rmdir", "/.dsh-trash");
  rmSync(input);

  // ── listing: the seeds plus the sandbox shape ─────────────────────────────
  const names = (await call(sftp, "readdir", "/")).map((entry) => entry.filename).sort();
  assert.deepEqual(names, ["binary.bin", "config", "empty.txt", "seed.txt", "welcome.txt"],
    "the root holds our seed plus the server's samples (mounted over the given root)");
  await call(sftp, "mkdir", "/work");
  await call(sftp, "writeFile", "/work/app.conf", "listen 8080\n");
  const savedEditor = await saveEditorFile(sftp, "/work/app.conf", Buffer.from("listen 8080\n"), Buffer.from("listen 8081\n"));
  assert.equal(String(await call(sftp, "readFile", savedEditor.backup)), "listen 8080\n");
  assert.equal((await call(sftp, "stat", savedEditor.backup)).mode & 0o077, 0, "backup is not readable by group or others");
  await assert.rejects(saveEditorFile(sftp, "/work/app.conf", Buffer.from("listen 8080\n"), Buffer.from("stale")), /changed/);
  const restoredEditor = await service.sftpEditorSave({ connectionId: "local-ssh", path: "/work/app.conf", expected: Buffer.from("listen 8081\n").toString("base64"), data: Buffer.from("listen 8080\n").toString("base64") });
  assert.equal(restoredEditor.ok, true, restoredEditor.error?.message);
  assert.equal(String(await call(sftp, "readFile", "/work/app.conf")), "listen 8080\n");
  assert.equal(String(await call(sftp, "readFile", restoredEditor.value.backup)), "listen 8081\n");
  await call(sftp, "unlink", restoredEditor.value.backup);
  await call(sftp, "unlink", savedEditor.backup);
  const nested = (await call(sftp, "readdir", "/work")).map((entry) => entry.filename);
  assert.deepEqual(nested, ["app.conf"]);

  // ── read / write / stat round trips ──────────────────────────────────────
  const text = String(await call(sftp, "readFile", "/seed.txt"));
  assert.equal(text, "seeded\n");
  const stat = await call(sftp, "stat", "/work/app.conf");
  assert.equal(stat.size, 12);
  assert.ok(stat.isFile());

  await call(sftp, "writeFile", "/binary-ish.dat", Buffer.from([0x00, 0x01, 0xff, 0xfe]));
  const bytes = await call(sftp, "readFile", "/binary-ish.dat");
  assert.deepEqual([...bytes], [0x00, 0x01, 0xff, 0xfe], "binary payloads survive the round trip");

  // Overwrite through the editor path (truncate + write).
  await call(sftp, "writeFile", "/work/app.conf", "listen 9090\nserver_name x;\n");
  assert.equal(String(await call(sftp, "readFile", "/work/app.conf")), "listen 9090\nserver_name x;\n");

  // The size the client reads back is what the editor's conflict guard
  // compares, so client and server must agree on it exactly.
  assert.equal((await call(sftp, "stat", "/work/app.conf")).size, 27);

  // ── rename / remove / rmdir ──────────────────────────────────────────────
  const listed = async (dir) => (await call(sftp, "readdir", dir)).map((entry) => entry.filename);
  await call(sftp, "rename", "/binary-ish.dat", "/moved.dat");
  assert.equal((await listed("/")).includes("moved.dat"), true);
  await call(sftp, "unlink", "/moved.dat");
  assert.equal((await listed("/")).includes("moved.dat"), false);
  await call(sftp, "unlink", "/work/app.conf");
  await call(sftp, "rmdir", "/work");
  assert.equal((await listed("/")).includes("work"), false);

  // ── the sandbox boundary holds ───────────────────────────────────────────
  await assert.rejects(() => call(sftp, "readFile", "/../../etc/passwd"), /(No such file|Permission denied|Failure)/i);
  await assert.rejects(() => call(sftp, "stat", "/../outside"), /No such file|Permission denied|Failure/i);
  const realpath = await call(sftp, "realpath", "/.");
  assert.equal(realpath, "/");
} finally {
  try { client?.end(); } catch {}
  child.kill("SIGTERM");
  rmSync(root, { recursive: true, force: true });
}

console.log("local sshd sftp: listing, read/write/binary round trips, rename/remove and the sandbox boundary all passed");
