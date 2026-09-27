// Idle-liveness checks before pool reuse, and transaction cleanup on
// transport loss.
//
// A pooled connection behind an SSH tunnel can go half-open while idle
// (NAT/firewall drop: no error event, no data). The liveness ping converts
// that state from "next real query stalls for the full op deadline" into a
// fast, bounded failure plus one transparent reconnect attempt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DbOpsManager, DB_DEADLINES } from "../src/db-ops.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const never = () => new Promise(() => {});

function makeManager(deadlines) {
  const manager = Object.create(DbOpsManager.prototype);
  manager.dbConnections = new Map();
  manager.dbTransactions = new Map();
  const warns = [];
  manager.warn = (...a) => warns.push(a);
  if (deadlines) manager.deadlines = deadlines;
  return manager;
}

const pgRecord = (id, client) => ({
  id, type: "postgresql", name: id, client,
  config: { host: "127.0.0.1", port: 5432 }, createdAt: new Date().toISOString()
});

test("DB_DEADLINES exposes a bounded ping deadline", () => {
  assert.ok(DB_DEADLINES.ping > 0 && DB_DEADLINES.ping < DB_DEADLINES.op);
});

test("ensureIdleAlive skips the ping on a recently used connection", async () => {
  const manager = makeManager();
  const record = { createdAt: new Date().toISOString(), lastUsedAt: Date.now() };
  let pinged = false;
  await manager.ensureIdleAlive(record, async () => { pinged = true; }, { label: "test" });
  assert.equal(pinged, false);
});

test("ensureIdleAlive pings a stale connection and marks failures transportDead", async () => {
  const manager = makeManager();
  const stale = { createdAt: new Date(Date.now() - 60000).toISOString() };
  let pinged = false;
  await manager.ensureIdleAlive(stale, async () => { pinged = true; }, { label: "test" });
  assert.equal(pinged, true);

  await assert.rejects(
    manager.ensureIdleAlive(stale, async () => { throw new Error("socket hang up"); }, { label: "test" }),
    (error) => error.transportDead === true && /liveness ping/.test(error.message)
  );
});

test("withAliveRetry retries exactly once after a dead-transport ping", async () => {
  const manager = makeManager();
  let attempts = 0;
  const result = await manager.withAliveRetry({}, {}, async () => {
    attempts += 1;
    if (attempts === 1) {
      const err = new Error("stale");
      err.transportDead = true;
      throw err;
    }
    return "recovered";
  });
  assert.equal(result, "recovered");
  assert.equal(attempts, 2);

  attempts = 0;
  await assert.rejects(
    manager.withAliveRetry({}, {}, async () => { attempts += 1; throw new Error("bad SQL"); }),
    /bad SQL/
  );
  assert.equal(attempts, 1, "ordinary errors never retry");
});

test("pgWithClient recovers transparently when the idle connection is dead", async () => {
  const manager = makeManager();
  const released = [];
  let checkoutCount = 0;
  const makeConn = (alive) => ({
    query: async () => {
      if (!alive) throw new Error("ECONNRESET");
      return { rows: [{ ok: 1 }], rowCount: 1 };
    },
    release: (err) => released.push(err ? "with-error" : "clean")
  });
  const client = {
    connect: async () => {
      checkoutCount += 1;
      return makeConn(checkoutCount >= 2);
    }
  };
  const record = pgRecord("pg-keep", client);
  record.lastUsedAt = Date.now() - 60000; // stale: forces the ping path

  const result = await manager.pgWithClient(record, { label: "t" }, async (run) => (await run("SELECT 42", [])).rows);
  assert.deepEqual(result, [{ ok: 1 }]);
  assert.equal(checkoutCount, 2, "one transparent reconnect attempt");
  assert.deepEqual(released, ["with-error", "clean"], "suspect connection released with error; healthy one cleanly");
});

test("abandonTransactionsFor rolls back best-effort and reclaims the dedicated connection", async () => {
  const manager = makeManager({ end: 50 });
  const destroyed = [];
  const txConn = {
    query: () => never(), // dead wire: ROLLBACK never settles
    destroy: () => destroyed.push("tx-conn"),
    release: () => destroyed.push("tx-conn-release")
  };
  manager.dbTransactions.set("tx-1", {
    txId: "tx-1", dbId: "db-1", kind: "mysql",
    handle: { kind: "mysql", conn: txConn },
    timer: null, createdAt: new Date().toISOString()
  });
  // A transaction of another connection must be left untouched.
  const untouched = { timer: null };
  manager.dbTransactions.set("tx-2", { txId: "tx-2", dbId: "db-other", handle: {}, ...untouched });

  manager.abandonTransactionsFor("db-1");
  assert.equal(manager.dbTransactions.has("tx-1"), false, "bookkeeping drops immediately");
  assert.equal(manager.dbTransactions.has("tx-2"), true, "other connections untouched");
  await sleep(120);
  assert.deepEqual(destroyed, ["tx-conn"], "the rollback race loses and the slot is destroyed");
});

test("abandonTransactionsFor releases cleanly when the rollback still answers", async () => {
  const manager = makeManager({ end: 500 });
  const released = [];
  const txClient = {
    query: async () => ({ rowCount: 0 }),
    release: (err) => released.push(err === undefined ? "clean" : "with-error")
  };
  manager.dbTransactions.set("tx-3", {
    txId: "tx-3", dbId: "db-2", kind: "pg",
    handle: { kind: "pg", client: txClient },
    timer: null, createdAt: new Date().toISOString()
  });
  manager.abandonTransactionsFor("db-2");
  await sleep(50);
  assert.deepEqual(released, ["clean"]);
  assert.equal(manager.dbTransactions.size, 0);
});
