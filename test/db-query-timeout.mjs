// Per-connection statement-deadline override (queryTimeoutMs): a connection
// created with an override must outlive the class-default op ceiling, 0 must
// remove the ceiling entirely, and connections without an override must keep
// exactly the old behaviour. Server/driver-side statement timeouts (pg
// set_config, mysql2 query timeout) must track the override too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DbOpsManager, normalizeQueryTimeoutMs } from "../src/db-ops.js";
import { DB_QUERY_TIMEOUT_MAX_MS } from "../src/schemas.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Partially-constructed manager, mirroring test/db-hang.mjs style. */
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

const pgRecord = (id, client, extra = {}) => ({
  id, type: "postgresql", name: id, client,
  config: { host: "127.0.0.1", port: 5432 }, createdAt: "x", ...extra
});

/** pg client double: checkout hands out an object with query() + release(). */
function pgPoolDouble(behavior) {
  const releasedWith = [];
  return {
    releasedWith,
    connect: () => Promise.resolve({
      query: (sql, params) => behavior(sql, params),
      release: (error) => releasedWith.push(error ?? null)
    })
  };
}

test("normalizeQueryTimeoutMs accepts only 0 and 1000..max", () => {
  assert.equal(normalizeQueryTimeoutMs(0), 0);
  assert.equal(normalizeQueryTimeoutMs(1000), 1000);
  assert.equal(normalizeQueryTimeoutMs(DB_QUERY_TIMEOUT_MAX_MS), DB_QUERY_TIMEOUT_MAX_MS);
  assert.equal(normalizeQueryTimeoutMs(undefined), undefined);
  assert.equal(normalizeQueryTimeoutMs(500), undefined, "below the 1s floor");
  assert.equal(normalizeQueryTimeoutMs(DB_QUERY_TIMEOUT_MAX_MS + 1), undefined, "above the ceiling");
  assert.equal(normalizeQueryTimeoutMs(1500.5), undefined, "non-integer");
  assert.equal(normalizeQueryTimeoutMs("30000"), undefined, "non-number");
});

test("opDeadlineFor: override beats the class default; 0 means no ceiling", () => {
  const manager = makeManager({ op: 50 });
  assert.equal(manager.opDeadlineFor(pgRecord("a", null)), 50, "no override → class default");
  assert.equal(manager.opDeadlineFor(pgRecord("a", null, { queryTimeoutMs: 5000 })), 5000);
  assert.equal(manager.opDeadlineFor(pgRecord("a", null, { queryTimeoutMs: 0 })), Infinity);
});

test("statementTimeoutFor keeps the 5s grace and disables on unlimited", () => {
  const manager = makeManager(); // class default op = 35000
  assert.equal(manager.statementTimeoutFor(pgRecord("a", null)), 30000, "default pair stays 30s/35s");
  assert.equal(manager.statementTimeoutFor(pgRecord("a", null, { queryTimeoutMs: 300000 })), 295000);
  assert.equal(manager.statementTimeoutFor(pgRecord("a", null, { queryTimeoutMs: 0 })), 0, "unlimited client ceiling disables the server guard");
  const tiny = makeManager({ op: 50 });
  assert.equal(tiny.statementTimeoutFor(pgRecord("a", null)), 0, "a sub-grace ceiling leaves nothing server-side");
});

test("a query slower than the class default survives under a connection override", async () => {
  // Default op ceiling tightened to 50ms; the statement takes 300ms.
  const manager = makeManager({ op: 50 });
  const client = pgPoolDouble(() => sleep(300).then(() => ({ rows: [], rowCount: 0 })));
  const record = pgRecord("slow-db", client, { queryTimeoutMs: 2000 });

  const started = Date.now();
  const result = await manager.pgWithClientOnce(record, { label: "db_query" }, (run) => run("SELECT pg_sleep(1)", []));
  assert.equal(Date.now() - started >= 250, true, "the statement actually ran to completion");
  assert.deepEqual(result, { rows: [], rowCount: 0 });
});

test("the same slow query still dies at the class default without an override", async () => {
  const manager = makeManager({ op: 50 });
  const client = pgPoolDouble(() => sleep(300).then(() => ({ rows: [] })));
  const record = pgRecord("default-db", client);

  await assert.rejects(
    manager.pgWithClientOnce(record, { label: "db_query" }, (run) => run("SELECT pg_sleep(1)", [])),
    /timed out after 50ms/
  );
  // The raced connection is released WITH an error so pg-pool destroys it.
  assert.equal(client.releasedWith.length, 1);
  assert.ok(client.releasedWith[0] instanceof Error);
});

test("queryTimeoutMs 0 runs a statement with no client-side ceiling", async () => {
  const manager = makeManager({ op: 50 });
  const client = pgPoolDouble(() => sleep(200).then(() => ({ rows: [], rowCount: 0 })));
  const record = pgRecord("unlimited", client, { queryTimeoutMs: 0 });

  const result = await manager.pgWithClientOnce(record, { label: "db_query" }, (run) => run("SELECT 1", []));
  assert.deepEqual(result, { rows: [], rowCount: 0 });
  assert.deepEqual(client.releasedWith, [null], "released cleanly, without an error");
});

test("list() surfaces the override so the agent can see it", () => {
  const manager = makeManager();
  manager.dbConnections.set("db-1", pgRecord("db-1", null, { queryTimeoutMs: 0 }));
  manager.dbConnections.set("db-2", pgRecord("db-2", null));
  const { value } = manager.list();
  const withOverride = value.connections.find((c) => c.dbConnectionId === "db-1");
  const without = value.connections.find((c) => c.dbConnectionId === "db-2");
  assert.equal(withOverride.queryTimeoutMs, 0);
  assert.equal("queryTimeoutMs" in without, false);
});
