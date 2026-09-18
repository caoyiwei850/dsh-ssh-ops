// PR22 regression guard: database drivers must stay out of the process until
// a connection actually needs one, and every first-use dynamic import path
// must exist for all four drivers plus the pg query cursor.
//
// Two layers:
//  1. Structural: the source and the committed built artifact carry exactly the
//     five `await import(...)` driver sites and no static driver import. The
//     npm artifact is what ships, so lib/index.js is asserted directly.
//  2. Cold start / first load, in a fresh child process: importing the plugin's
//     DB module loads no driver at all; each connect attempt loads exactly its
//     own driver; the PostgreSQL cursor path (pgQueryPaged) loads pg-cursor.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SRC = new URL("../src/db-ops.js", import.meta.url);
const LIB = new URL("../lib/index.js", import.meta.url);

const DYNAMIC_IMPORTS = [
  'await import("mysql2/promise.js")',
  'await import("pg")',
  'await import("redis")',
  'await import("mongodb")',
  'await import("pg-cursor")'
];
// Static driver imports — a regression here means the driver loads at boot.
const STATIC_IMPORT = /(?:from|require\()\s*["'](?:mysql2(?:\/promise\.js)?|pg|pg-cursor|redis|mongodb)["']/;

// ── 1. structural lock ──────────────────────────────────────────────────────
for (const [label, url] of [["src/db-ops.js", SRC], ["lib/index.js", LIB]]) {
  const text = readFileSync(url, "utf8");
  for (const spec of DYNAMIC_IMPORTS) {
    assert.ok(text.includes(spec), `${label}: missing first-use import ${spec}`);
  }
  const staticHit = text.match(STATIC_IMPORT);
  assert.equal(staticHit, null, `${label}: static driver import crept back in: ${staticHit?.[0]}`);
}

// ── 2. cold start and first-load paths, fresh process ───────────────────────
const CHILD = `
import net from "node:net";
import { createRequire } from "node:module";
import { DbOpsManager } from "./src/db-ops.js";

const require = createRequire(import.meta.url);
const DRIVERS = ["mysql2", "pg", "pg-cursor", "redis", "mongodb"];
const loaded = () => [...new Set(Object.keys(require.cache)
  .map((path) => path.split("node_modules/")[1]?.split("/")[0]).filter(Boolean))]
  .filter((name) => DRIVERS.includes(name));

function makeManager() {
  const manager = Object.create(DbOpsManager.prototype);
  manager.dbConnections = new Map();
  manager.dbTransactions = new Map();
  manager.warn = () => {};
  manager.sshOpsService = { ctx: { logger: { warn: () => {} } } };
  manager.maxDbRows = 100;
  manager.deadlines = { connect: 1500, poolConnection: 800, checkout: 1500, op: 1200, reset: 400, end: 400 };
  return manager;
}

const closedPort = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

// Minimal PostgreSQL wire-protocol server. Completes the startup handshake
// and serves just enough of both query protocols to let the plugin's own code
// run: simple queries answer with one row, extended queries get
// Parse/Bind/Describe/Execute/Sync answers, and the first cursor fetch
// suspends its portal before completing on the next fetch. That is all the
// cursor path (pgQueryPaged -> import("pg-cursor") -> cursor.read) needs.
function pgFrame(type, payload) {
  const head = Buffer.alloc(5);
  head.write(type, 0, 1, "ascii");
  head.writeUInt32BE(4 + payload.length, 1);
  return Buffer.concat([head, payload]);
}
function pgRowDescription() {
  const count = Buffer.alloc(2);
  count.writeInt16BE(1, 0);
  const name = Buffer.from("x\\0", "utf8");
  const rest = Buffer.alloc(18);
  rest.writeInt32BE(0, 0);       // table oid
  rest.writeInt16BE(0, 4);       // column index
  rest.writeInt32BE(25, 6);      // type oid: text
  rest.writeInt16BE(-1, 10);     // type size
  rest.writeInt32BE(-1, 14);     // type modifier
  rest.writeInt16BE(0, 16);      // text format
  return pgFrame("T", Buffer.concat([count, name, rest]));
}
function pgDataRow() {
  const count = Buffer.alloc(2);
  count.writeInt16BE(1, 0);
  const value = Buffer.from("1", "utf8");
  const len = Buffer.alloc(4);
  len.writeInt32BE(value.length, 0);
  return pgFrame("D", Buffer.concat([count, len, value]));
}
const pgComplete = () => pgFrame("C", Buffer.from("SELECT 1\\0"));
const pgReady = () => pgFrame("Z", Buffer.from("I"));

const pgServer = net.createServer((socket) => {
  socket.on("error", () => {});
  let buf = Buffer.alloc(0);
  let handshaken = false;
  let executes = 0;
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      let frame;
      if (!handshaken) {
        // Startup packet: no type byte, length is the first Int32.
        if (buf.length < 4) return;
        const len = buf.readUInt32BE(0);
        if (len < 8 || buf.length < len) return;
        frame = buf.subarray(0, len);
        buf = buf.subarray(len);
        handshaken = true;
        const keyData = Buffer.alloc(8);
        keyData.writeInt32BE(4242, 0);
        keyData.writeInt32BE(777, 4);
        socket.write(Buffer.concat([
          pgFrame("R", Buffer.from([0, 0, 0, 0])),
          pgFrame("S", Buffer.from("server_version\\0" + "16.0\\0")),
          pgFrame("K", keyData),
          pgReady()
        ]));
      } else {
        // Typed frontend frame: 1 type byte, then the Int32 length (excl. type).
        if (buf.length < 5) return;
        const len = buf.readUInt32BE(1);
        if (len < 4 || buf.length < 1 + len) return;
        const type = String.fromCharCode(buf[0]);
        frame = buf.subarray(0, 1 + len);
        buf = buf.subarray(1 + len);
        if (type === "X") { socket.end(); return; }
        if (type === "P") { socket.write(pgFrame("1", Buffer.alloc(0))); continue; }
        if (type === "B") { socket.write(pgFrame("2", Buffer.alloc(0))); continue; }
        if (type === "D") { socket.write(pgRowDescription()); continue; }
        if (type === "S") { socket.write(pgReady()); continue; }
        if (type === "Q") { socket.write(Buffer.concat([pgRowDescription(), pgDataRow(), pgComplete(), pgReady()])); continue; }
        if (type === "E") {
          executes += 1;
          if (executes === 1) {
            socket.write(Buffer.concat([pgDataRow(), pgComplete()]));
          } else if (executes === 2) {
            socket.write(Buffer.concat([pgDataRow(), pgFrame("s", Buffer.alloc(0))]));
          } else {
            socket.write(pgComplete());
          }
          continue;
        }
      }
      void frame;
    }
  });
});
await new Promise((resolve) => pgServer.listen(0, "127.0.0.1", resolve));
const pgPort = pgServer.address().port;

const report = { cold: loaded(), steps: [] };
const manager = makeManager();

for (const type of ["mysql", "postgresql", "redis", "mongodb"]) {
  const port = type === "postgresql" ? pgPort : closedPort;
  const result = await manager.connect({ type, host: "127.0.0.1", port, database: "smoke", username: "u", password: "p" });
  report.steps.push({
    type,
    // postgresql talks to the fake server and succeeds; the other three must
    // fail at the refused port — but only AFTER their driver was imported.
    ok: result.ok === true,
    error: result.ok === true ? null : String(result.error?.message ?? result.error).slice(0, 160),
    loaded: loaded()
  });
}

// Reach the cursor path through the live (fake-server) PostgreSQL connection.
const pgRecord = [...manager.dbConnections.values()].find((record) => record.type === "postgresql");
let cursorOutcome = "no-postgresql-connection";
if (pgRecord !== undefined) {
  // The fake server answers just enough of the protocol; any client-level
  // error event must not take the whole child process down before the report.
  try { pgRecord.client?.on?.("error", () => {}); } catch {}
  try {
    const result = await manager.pgQueryPaged(pgRecord, "select 1", [], { label: "smoke" });
    cursorOutcome = result.rows.length === 0 ? "ok-empty" : "ok-rows";
  } catch (error) {
    cursorOutcome = "threw:" + String(error.message).slice(0, 120);
  }
}
report.cursor = { outcome: cursorOutcome, loaded: loaded() };

try { pgServer.close(); } catch {}
process.stdout.write(JSON.stringify(report));
process.exit(0);
`;

const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", CHILD], {
  cwd: new URL("..", import.meta.url),
  encoding: "utf8",
  timeout: 60000,
  stdio: ["ignore", "pipe", "pipe"]
});
const report = JSON.parse(stdout);

assert.deepEqual(report.cold, [], "importing the DB module must not load any driver (cold start)");

const expected = { mysql: "mysql2", postgresql: "pg", redis: "redis", mongodb: "mongodb" };
const seen = new Set();
for (const step of report.steps) {
  const driver = expected[step.type];
  assert.equal(step.type === "postgresql" ? step.ok : step.ok, step.type === "postgresql",
    `${step.type}: expected ${step.type === "postgresql" ? "a successful handshake against the fake server" : "a refused-port failure"}, got ${JSON.stringify(step)}`);
  seen.add(driver);
  for (const name of seen) {
    assert.ok(step.loaded.includes(name), `${step.type}: expected ${name} to be imported by first use`);
  }
}
assert.deepEqual([...seen].sort(), ["mongodb", "mysql2", "pg", "redis"], "all four drivers exercised");

assert.ok(report.cursor.loaded.includes("pg-cursor"), `pg cursor path must import pg-cursor (outcome: ${report.cursor.outcome})`);
assert.ok(!report.cursor.outcome.startsWith("threw:") || !/Cannot find|not a function|is not defined/.test(report.cursor.outcome),
  `pg cursor path must fail only on protocol/transport grounds, got: ${report.cursor.outcome}`);

console.log("db lazy load: cold start is driver-free; all four drivers and pg-cursor load on first use");
