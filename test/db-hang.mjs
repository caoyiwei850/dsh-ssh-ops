// Half-open transport hang regressions (SSH tunnel silently dead: no error,
// no data). Every driver await in the db layer must settle under cancellation
// (exec.signal) and under its own client-side deadline, and a killed
// connection must give its pool slot back instead of draining the pool.
//
// Loop command: node --test --test-force-exit test/db-hang.mjs
// (force-exit only matters while RED: a pre-fix hang keeps real sockets open;
// once fixed, the suite must also exit cleanly WITHOUT the flag — that clean
// exit is itself part of the quiescence assertion.)
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { DbOpsManager } from "../src/db-ops.js";
import { registerDbTools } from "../src/tools/db.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reject with HUNG if `promise` does not settle within ms — the red signal. */
function settleWithin(promise, ms, label) {
  let timer;
  const watchdog = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`HUNG: ${label} did not settle within ${ms}ms`)), ms);
  });
  return Promise.race([promise, watchdog]).finally(() => clearTimeout(timer));
}

/** Partially-constructed manager, mirroring test/db-ops.mjs style. */
function makeManager(deadlines) {
  const manager = Object.create(DbOpsManager.prototype);
  manager.dbConnections = new Map();
  manager.dbTransactions = new Map();
  const warns = [];
  manager.sshOpsService = { ctx: { logger: { warn: (...a) => warns.push(a) } } };
  manager.warn = (...a) => warns.push(a);
  manager.warns = warns;
  if (deadlines) manager.deadlines = deadlines;
  return manager;
}

const never = () => new Promise(() => {});

const pgRecord = (id, client) => ({
  id, type: "postgresql", name: id, client,
  config: { host: "127.0.0.1", port: 5432 }, createdAt: "x"
});
const mysqlRecord = (id, client) => ({
  id, type: "mysql", name: id, client,
  config: { host: "127.0.0.1", port: 3306 }, createdAt: "x"
});

// ── minimal PostgreSQL wire-protocol server ─────────────────────────────────
// "silent": completes the startup handshake, then swallows every message —
// exactly the half-open-tunnel state (TCP alive at the local end, no replies).
// "blackhole": accepts TCP and never speaks at all (connect itself hangs).

function pgFrame(type, payload) {
  const head = Buffer.alloc(5);
  head.write(type, 0, 1, "ascii");
  head.writeUInt32BE(4 + payload.length, 1);
  return Buffer.concat([head, payload]);
}

function startPgServer(mode) {
  return new Promise((resolve, reject) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
      socket.on("end", () => socket.destroy());
      if (mode === "blackhole") return;
      let buf = Buffer.alloc(0);
      let handshaken = false;
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 4) return;
          const len = buf.readUInt32BE(0);
          if (len < 8 || buf.length < len) return;
          const frame = buf.subarray(0, len);
          buf = buf.subarray(len);
          if (handshaken) continue; // swallow queries forever
          handshaken = true;
          const keyData = Buffer.alloc(8);
          keyData.writeInt32BE(4242, 0);
          keyData.writeInt32BE(777, 4);
          socket.write(Buffer.concat([
            pgFrame("R", Buffer.from([0, 0, 0, 0])), // AuthenticationOk
            pgFrame("S", Buffer.from("server_version\0" + "16.0\0")), // ParameterStatus
            pgFrame("K", keyData), // BackendKeyData
            pgFrame("Z", Buffer.from("I")) // ReadyForQuery (idle)
          ]));
          void frame;
        }
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, sockets }));
  });
}

function stopPgServer({ server, sockets }) {
  for (const s of sockets) { try { s.destroy(); } catch {} }
  return new Promise((resolve) => { server.close(() => resolve()); });
}

// ── 1. tool layer: timeoutMs declared + exec.signal forwarded ───────────────

test("db tools declare timeoutMs and forward exec.signal to the service", async () => {
  const defs = [];
  const ctx = { tools: { register: (d) => defs.push(d) } };
  const seen = [];
  const service = new Proxy({}, {
    get: (_t, prop) => async (req) => { seen.push([String(prop), req]); return { ok: true, value: {} }; }
  });
  registerDbTools(ctx, service);
  assert.ok(defs.length >= 14, "all db tools are registered");

  const calls = [
    ["db_connect", { type: "postgresql", host: "db.example.com", port: 5432 }, "dbConnect"],
    ["db_list_connections", {}, "dbListConnections"],
    ["db_query", { db_connection_id: "db-1", sql: "SELECT 1" }, "dbQuery"],
    ["db_execute", { db_connection_id: "db-1", sql: "INSERT INTO t VALUES (1)" }, "dbExecute"],
    ["db_list_tables", { db_connection_id: "db-1" }, "dbListTables"],
    ["db_describe_table", { db_connection_id: "db-1", table: "t" }, "dbDescribeTable"],
    ["db_preview", { db_connection_id: "db-1", table: "t" }, "dbPreview"],
    ["db_explain", { db_connection_id: "db-1", sql: "SELECT 1" }, "dbExplain"],
    ["db_tx_begin", { db_connection_id: "db-1" }, "dbTxBegin"],
    ["db_tx_execute", { tx_id: "tx-1", sql: "SELECT 1" }, "dbTxExecute"],
    ["db_tx_commit", { tx_id: "tx-1" }, "dbTxCommit"],
    ["db_tx_rollback", { tx_id: "tx-1" }, "dbTxRollback"],
    ["db_run", { db_connection_id: "db-1", command: "GET", args: ["k"] }, "dbRun"],
    ["db_disconnect", { db_connection_id: "db-1" }, "dbDisconnect"]
  ];

  for (const [name, args, expectedMethod] of calls) {
    const def = defs.find((d) => d.name === name);
    assert.ok(def, `${name} is registered`);
    // The dsh timeout-policy guardian only enforces a budget when the tool
    // declares one; without it a hung db call spins forever and GUI "stop"
    // can only wait for the tool to settle on its own.
    assert.ok(Number.isFinite(def.timeoutMs) && def.timeoutMs > 0, `${name} must declare timeoutMs`);
    seen.length = 0;
    const ac = new AbortController();
    await def.execute(args, { signal: ac.signal });
    const hit = seen.find(([m]) => m === expectedMethod);
    assert.ok(hit, `${name} calls ${expectedMethod}`);
    assert.equal(hit[1].signal, ac.signal, `${name} must forward exec.signal`);
  }
});

// ── 2. pg checkout hang: cancel must settle the call ────────────────────────

test("pg query settles when pool.connect() hangs and the call is cancelled", async () => {
  const manager = makeManager();
  manager.dbConnections.set("db-pg", pgRecord("db-pg", { connect: never }));
  const ac = new AbortController();
  const op = manager.query({ dbConnectionId: "db-pg", sql: "SELECT 1", signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  const r = await settleWithin(op, 1500, "pg checkout under cancel");
  assert.equal(r.ok, false);
  assert.match(r.error.message, /cancel/i);
});

// ── 3. pgQueryPaged finally: RESET hang must not block release (pool drain) ─

test("pgQueryPaged bounds the finally RESET and destroys the dead client", async () => {
  const manager = makeManager({ reset: 100, op: 1000 });
  const released = [];
  const fakeClient = {
    query(arg) {
      if (typeof arg === "string" && arg.startsWith("SELECT set_config")) return Promise.resolve({});
      if (typeof arg === "string" && arg.startsWith("RESET")) return never(); // half-open: RESET hangs forever
      return { read: (_n, cb) => cb(null, []), close: () => Promise.resolve(), rowDescription: null }; // cursor
    },
    release: (err) => released.push(err ?? null)
  };
  manager.dbConnections.set("db-pg", pgRecord("db-pg", { connect: async () => fakeClient }));
  const r = await settleWithin(manager.query({ dbConnectionId: "db-pg", sql: "SELECT 1" }), 2500, "RESET in finally");
  assert.equal(r.ok, true, "the query itself succeeded; only cleanup hit the dead socket");
  assert.equal(released.length, 1, "client is handed back exactly once — the slot is not lost");
  assert.ok(released[0], "released WITH an error so pg-pool destroys it instead of reusing the corpse");
});

// ── 4. mysql checkout hang: cancel settles, late arrival is destroyed ───────

test("mysql query settles on cancel and destroys the late-arriving connection", async () => {
  const manager = makeManager();
  let destroyed = 0;
  let released = 0;
  const lateConn = { destroy: () => { destroyed += 1; }, release: () => { released += 1; } };
  manager.dbConnections.set("db-my", mysqlRecord("db-my", {
    getConnection: () => new Promise((resolve) => setTimeout(() => resolve(lateConn), 120))
  }));
  const ac = new AbortController();
  const op = manager.query({ dbConnectionId: "db-my", sql: "SELECT 1", signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  const r = await settleWithin(op, 1500, "mysql checkout under cancel");
  assert.equal(r.ok, false);
  assert.match(r.error.message, /cancel/i);
  await sleep(250); // the abandoned checkout still resolves later…
  assert.equal(destroyed, 1, "…and its connection must be destroyed, not leaked out of the pool");
  assert.equal(released, 0, "a connection nobody owns must never go back to the pool");
});

// ── 5. integration: real pg driver vs a silent (half-open) server ───────────

test("real pg: query against a silent server settles by deadline and by cancel, pool survives", async (t) => {
  const srv = await startPgServer("silent");
  t.after(() => stopPgServer(srv));
  const manager = makeManager({ op: 300, checkout: 400, reset: 150, poolConnection: 500, connect: 1500, end: 300 });
  const connected = await settleWithin(
    manager.connect({ type: "postgresql", host: "127.0.0.1", port: srv.port, database: "d", username: "u", password: "p" }),
    3000, "connect to silent pg server"
  );
  assert.equal(connected.ok, true, "handshake completes; the silence starts at the first query");
  const id = connected.value.dbConnectionId;

  // (a) no signal at all: the client-side deadline alone must settle the call
  const r1 = await settleWithin(manager.query({ dbConnectionId: id, sql: "SELECT 1" }), 2000, "query vs silent server");
  assert.equal(r1.ok, false);
  assert.match(r1.error.message, /timed out|timeout/i);

  // (b) cancel path + slot recovery: 6 sequential cancelled queries against a
  // max:4 pool. If killed clients were leaked instead of destroyed/reclaimed,
  // checkout would starve and the failure text would change (or it would hang).
  for (let i = 0; i < 6; i++) {
    const ac = new AbortController();
    const op = manager.query({ dbConnectionId: id, sql: "SELECT 1", signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    const r = await settleWithin(op, 2000, `cancelled query #${i + 1}`);
    assert.equal(r.ok, false);
    assert.match(r.error.message, /cancel/i, `query #${i + 1} dies by cancellation, not pool starvation`);
  }

  await settleWithin(manager.disconnect({ dbConnectionId: id }), 2000, "disconnect after kills");
});

// ── 6. integration: real pg connect vs a blackhole (handshake never lands) ──

test("real pg: db_connect to a blackhole settles by deadline and by cancel", async (t) => {
  const srv = await startPgServer("blackhole");
  t.after(() => stopPgServer(srv));
  const manager = makeManager({ connect: 400, poolConnection: 600, checkout: 400, op: 300, reset: 150, end: 300 });

  const r = await settleWithin(
    manager.connect({ type: "postgresql", host: "127.0.0.1", port: srv.port, database: "d", username: "u", password: "p" }),
    2500, "connect to blackhole"
  );
  assert.equal(r.ok, false);
  assert.match(r.error.message, /timed out|timeout|terminated/i);

  const ac = new AbortController();
  const op = manager.connect({ type: "postgresql", host: "127.0.0.1", port: srv.port, database: "d", username: "u", password: "p", signal: ac.signal });
  setTimeout(() => ac.abort(), 30);
  const r2 = await settleWithin(op, 2500, "connect to blackhole under cancel");
  assert.equal(r2.ok, false);
  assert.match(r2.error.message, /cancel/i);
});

// ── 7. db_disconnect must settle even when pool.end() hangs ─────────────────

test("disconnect settles when the pool cannot end on a dead transport", async () => {
  const manager = makeManager({ end: 100 });
  manager.dbConnections.set("db-pg", pgRecord("db-pg", { end: never }));
  const r = await settleWithin(manager.disconnect({ dbConnectionId: "db-pg" }), 1500, "disconnect with hanging end()");
  assert.equal(r.ok, true, "the record is gone from the manager even if the socket never dies");
  assert.equal(manager.dbConnections.has("db-pg"), false);
});

// ── 8. redis db_run: a hung command settles and kills the suspect transport ─

test("redis run settles on deadline and drops the suspect connection", async () => {
  const manager = makeManager({ op: 100 });
  let disconnected = 0;
  const client = { sendCommand: never, disconnect: () => { disconnected += 1; }, on: () => {} };
  manager.dbConnections.set("db-r", {
    id: "db-r", type: "redis", name: "db-r", client,
    config: { host: "127.0.0.1", port: 6379 }, createdAt: "x"
  });
  const r = await settleWithin(manager.run({ dbConnectionId: "db-r", command: "GET", args: ["k"] }), 1500, "redis GET on half-open socket");
  assert.equal(r.ok, false);
  assert.equal(disconnected, 1, "node-redis would retry forever on a dead tunnel — stop it");
  assert.equal(manager.dbConnections.has("db-r"), false, "dead record is dropped so the agent reconnects loudly");
});

// ── 9. mysql generic pool.query paths are bounded too ───────────────────────

test("mysql db_execute settles by deadline when the pool hangs", async () => {
  const manager = makeManager({ op: 150, checkout: 150 });
  manager.dbConnections.set("db-my", mysqlRecord("db-my", { query: never, getConnection: never }));
  const r = await settleWithin(manager.execute({ dbConnectionId: "db-my", sql: "INSERT INTO t VALUES (1)" }), 1500, "mysql execute on half-open socket");
  assert.equal(r.ok, false);
  assert.match(r.error.message, /timed out|cancel/i);
});

// ── 10. pg generic pool.query paths are bounded too ─────────────────────────

test("pg db_list_tables settles by deadline when the pool hangs", async () => {
  const manager = makeManager({ op: 150, checkout: 150 });
  manager.dbConnections.set("db-pg", pgRecord("db-pg", { query: never, connect: never }));
  const r = await settleWithin(manager.listTables({ dbConnectionId: "db-pg" }), 1500, "pg list_tables on half-open socket");
  assert.equal(r.ok, false);
  assert.match(r.error.message, /timed out|cancel/i);
});

// ── 11. db_preview: the (formerly swallowed) estimate query cannot hang ─────

test("pg db_preview settles when the estimate query hangs", async () => {
  const manager = makeManager({ op: 150, checkout: 150 });
  manager.dbConnections.set("db-pg", pgRecord("db-pg", { query: never, connect: never }));
  const r = await settleWithin(manager.preview({ dbConnectionId: "db-pg", table: "t" }), 1500, "pg preview on half-open socket");
  assert.equal(r.ok, false);
  assert.match(r.error.message, /timed out|cancel/i);
});

// ── 12. transactions: cancel mid-statement kills the dedicated connection ───

test("mysql db_tx_execute settles on cancel, destroys the tx connection and drops the tx", async () => {
  const manager = makeManager({ op: 1000, checkout: 500 });
  let destroyed = 0;
  let released = 0;
  const conn = {
    query: async (sql) => {
      if (sql === "START TRANSACTION") return [{}, []];
      return never(); // the write itself hangs on the half-open tunnel
    },
    release: () => { released += 1; },
    destroy: () => { destroyed += 1; }
  };
  manager.dbConnections.set("db-tx", mysqlRecord("db-tx", { getConnection: async () => conn }));
  const begun = await settleWithin(manager.dbTxBegin({ dbConnectionId: "db-tx" }), 1000, "tx begin");
  assert.equal(begun.ok, true);

  const ac = new AbortController();
  const op = manager.dbTxExecute({ txId: begun.value.txId, sql: "UPDATE t SET a = 1", signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  const r = await settleWithin(op, 1500, "tx execute under cancel");
  assert.equal(r.ok, false);
  assert.match(r.error.message, /cancel/i);
  assert.equal(destroyed, 1, "the dedicated tx connection is mid-protocol — destroy it");
  assert.equal(released, 0);
  assert.equal(manager.dbTransactions.size, 0, "the tx is dropped so later calls fail loudly with tx-missing");
  const after = await manager.dbTxExecute({ txId: begun.value.txId, sql: "SELECT 1" });
  assert.equal(after.error.code, "tx-missing");
});

test("mysql db_tx_commit settles on cancel and destroys the tx connection", async () => {
  const manager = makeManager({ op: 1000, checkout: 500 });
  let destroyed = 0;
  const conn = {
    query: async (sql) => sql === "START TRANSACTION" ? [{}, []] : never(),
    release: () => assert.fail("a cancelled commit must not return its connection to the pool"),
    destroy: () => { destroyed += 1; }
  };
  manager.dbConnections.set("db-tx", mysqlRecord("db-tx", { getConnection: async () => conn }));
  const begun = await manager.dbTxBegin({ dbConnectionId: "db-tx" });
  assert.equal(begun.ok, true);

  const ac = new AbortController();
  const op = manager.dbTxCommit({ txId: begun.value.txId, signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  const result = await settleWithin(op, 1500, "tx commit under cancel");
  assert.equal(result.ok, false);
  assert.match(result.error.message, /cancel/i);
  assert.equal(destroyed, 1);
  assert.equal(manager.dbTransactions.size, 0);
});
