/**
 * Quick end-to-end check of the local test sshd: connect, run an exec command,
 * then open a shell and verify that writing a command followed by Enter (CR)
 * actually executes it.
 */
import ssh2 from "ssh2";

const { Client } = ssh2;

const HOST = "127.0.0.1";
const PORT = Number(process.argv[2] ?? 2222);
const IS_WINDOWS = process.platform === "win32";

function connect() {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on("ready", () => resolve(conn));
    conn.on("error", reject);
    conn.connect({ host: HOST, port: PORT, username: "test", password: "test123", readyTimeout: 10000 });
  });
}

function exec(conn, command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let out = "";
      let errOut = "";
      stream.on("data", (d) => (out += d));
      stream.stderr.on("data", (d) => (errOut += d));
      stream.on("close", (code) => resolve({ code, out, errOut }));
    });
  });
}

function shell(conn) {
  return new Promise((resolve, reject) => {
    conn.shell({ term: "xterm-256color", cols: 100, rows: 30 }, (err, stream) => {
      if (err) return reject(err);
      let buf = "";
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      stream.on("data", (d) => (buf += d));
      stream.stderr.on("data", (d) => (buf += d));
      stream.on("close", () => {});
      resolve({ stream, getBuf: () => buf, wait });
    });
  });
}

const conn = await connect();
console.log("[client] connected");

// 1) exec channel
const r1 = await exec(conn, IS_WINDOWS ? "echo EXEC-OK & ver" : "echo EXEC-OK; uname -s");
console.log("[client] exec exit=", r1.code, "out=", JSON.stringify(r1.out.replace(/\r?\n/g, " | ").slice(0, 120)));

// 2) shell channel: write a command + CR, see if it executes
const { stream, getBuf, wait } = await shell(conn);
await wait(800);
stream.write("echo SHELL-OK\r");
await wait(1200);
console.log("[client] shell after CR:", JSON.stringify(getBuf().replace(/\r?\n/g, " | ").slice(-200)));

conn.end();
process.exit(0);
