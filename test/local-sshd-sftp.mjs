// Integration test for the offline SFTP server in test-sshd.mjs: boot the
// server, drive it with the same ssh2 client the plugin uses, and prove the
// sandbox both serves files and refuses to escape its root.
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "ssh2";

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
  new URL("../test-sshd.mjs", import.meta.url).pathname,
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

  // ── listing: the seeds plus the sandbox shape ─────────────────────────────
  const names = (await call(sftp, "readdir", "/")).map((entry) => entry.filename).sort();
  assert.deepEqual(names, ["binary.bin", "config", "empty.txt", "seed.txt", "welcome.txt"],
    "the root holds our seed plus the server's samples (mounted over the given root)");
  await call(sftp, "mkdir", "/work");
  await call(sftp, "writeFile", "/work/app.conf", "listen 8080\n");
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
