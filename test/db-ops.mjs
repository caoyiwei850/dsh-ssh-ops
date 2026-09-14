import assert from "node:assert/strict";
import { buildMysqlSsl, buildPgSsl, buildRedisSocket, buildMongoOptions } from "../src/db-ops.js";

// mysql2: undefined = 不传 ssl；preferred/verify = { rejectUnauthorized }
assert.equal(buildMysqlSsl("disabled"), undefined);
assert.equal(buildMysqlSsl(undefined), undefined);
assert.deepEqual(buildMysqlSsl("preferred"), { rejectUnauthorized: false });
assert.deepEqual(buildMysqlSsl("verify"), { rejectUnauthorized: true });

// pg: false = 不加密；对象 = 加密
assert.equal(buildPgSsl("disabled"), false);
assert.equal(buildPgSsl(undefined), false);
assert.deepEqual(buildPgSsl("preferred"), { rejectUnauthorized: false });
assert.deepEqual(buildPgSsl("verify"), { rejectUnauthorized: true });

// redis: socket 对象，tls 标志
assert.deepEqual(buildRedisSocket("disabled", "h", 6379), { host: "h", port: 6379 });
assert.deepEqual(buildRedisSocket("verify", "h", 6379), { host: "h", port: 6379, tls: true, rejectUnauthorized: true });
assert.deepEqual(buildRedisSocket("preferred", "h", 6379), { host: "h", port: 6379, tls: true, rejectUnauthorized: false });

// mongodb: tls 标志
assert.deepEqual(buildMongoOptions("disabled"), {});
assert.deepEqual(buildMongoOptions("preferred"), { tls: true, tlsAllowInvalidCertificates: true });
assert.deepEqual(buildMongoOptions("verify"), { tls: true, tlsAllowInvalidCertificates: false });

console.log("db-ops ssl mappers: all cases passed");

// ── ssh tunnel routing for db_connect (pure, unit-tested) ───────────────────

import { isLoopbackHost, pickSshConnectionId } from "../src/db-ops.js";

// 回环地址判定
assert.equal(isLoopbackHost("127.0.0.1"), true);
assert.equal(isLoopbackHost("127.8.9.10"), true);
assert.equal(isLoopbackHost("localhost"), true);
assert.equal(isLoopbackHost("::1"), true);
assert.equal(isLoopbackHost("db.example.com"), false);
assert.equal(isLoopbackHost("10.0.0.5"), false);
assert.equal(isLoopbackHost(undefined), false);

const active = { ok: true, connectionId: "conn-1", connection: {} };
const none = { ok: false, error: { code: "no-connection", message: "no active SSH connection" } };

// 显式 ssh_connection_id 永远优先
assert.deepEqual(pickSshConnectionId({ sshConnectionId: "conn-x", viaSsh: "no", host: "127.0.0.1", resolveActive: () => active }), { sshConnectionId: "conn-x" });

// via_ssh=no：强制直连，忽略活动连接
assert.deepEqual(pickSshConnectionId({ viaSsh: "no", host: "127.0.0.1", resolveActive: () => active }), { sshConnectionId: undefined });

// via_ssh=auto + 回环地址 + 有活动连接 → 自动走隧道
assert.deepEqual(pickSshConnectionId({ viaSsh: "auto", host: "127.0.0.1", resolveActive: () => active }), { sshConnectionId: "conn-1" });
assert.deepEqual(pickSshConnectionId({ viaSsh: "auto", host: "localhost", resolveActive: () => active }), { sshConnectionId: "conn-1" });

// via_ssh=auto + 非回环地址 → 直连（不劫持公网/内网 IP 的直连语义）
assert.deepEqual(pickSshConnectionId({ viaSsh: "auto", host: "db.example.com", resolveActive: () => active }), { sshConnectionId: undefined });

// via_ssh=auto + 无活动连接 → 直连（不报错，保持原行为）
assert.deepEqual(pickSshConnectionId({ viaSsh: "auto", host: "127.0.0.1", resolveActive: () => none }), { sshConnectionId: undefined });

// via_ssh=yes：强制走当前活动连接，无连接时报错
assert.deepEqual(pickSshConnectionId({ viaSsh: "yes", host: "db.example.com", resolveActive: () => active }), { sshConnectionId: "conn-1" });
assert.deepEqual(pickSshConnectionId({ viaSsh: "yes", host: "127.0.0.1", resolveActive: () => none }), { error: none.error });

// 默认 viaSsh 视为 auto
assert.deepEqual(pickSshConnectionId({ host: "127.0.0.1", resolveActive: () => active }), { sshConnectionId: "conn-1" });

console.log("db-ops ssh tunnel routing: all cases passed");

// ── DB transport-loss handling (tunneled idle connections must not crash) ────

import { EventEmitter } from "node:events";
import { DbOpsManager } from "../src/db-ops.js";

{
  const manager = Object.create(DbOpsManager.prototype);
  manager.dbConnections = new Map();
  const warns = [];
  manager.sshOpsService = { ctx: { logger: { warn: (...a) => warns.push(a) } } };

  const makeRedis = () => {
    const client = new EventEmitter();
    client.disconnectCalls = 0;
    client.disconnect = () => { client.disconnectCalls += 1; };
    return client;
  };
  const baseRecord = (over = {}) => ({
    id: "db-test", type: "redis", name: "test",
    config: { host: "127.0.0.1", port: 6379 },
    createdAt: "x", ...over
  });

  // error → record removed, tunnel closed, redis client disconnected, warn logged
  const closedServers = [];
  const redis = makeRedis();
  manager.dbConnections.set("db-test", baseRecord({ client: redis, tunnel: { server: { close: () => closedServers.push(1) } } }));
  manager.attachDbTransportHandlers(manager.dbConnections.get("db-test"));
  redis.emit("error", Object.assign(new Error("Socket closed unexpectedly"), { code: "NR-SPAWN" }));
  assert.equal(manager.dbConnections.has("db-test"), false, "dead record is removed from the map");
  assert.equal(redis.disconnectCalls, 1, "redis retry loop is stopped via disconnect()");
  assert.equal(closedServers.length, 1, "tunnel server is closed exactly once");
  assert.equal(warns.length, 1, "loss is logged");

  // second error after removal → early return, no throw, no double cleanup
  redis.emit("error", new Error("again"));
  assert.equal(closedServers.length, 1);
  assert.equal(redis.disconnectCalls, 1);
  assert.equal(warns.length, 1);

  // non-redis clients are never force-disconnected (pool owns its lifecycle)
  const pgClient = new EventEmitter();
  pgClient.disconnect = () => { throw new Error("must not be called for pg"); };
  manager.dbConnections.set("db-pg", baseRecord({ id: "db-pg", type: "postgresql", client: pgClient }));
  manager.attachDbTransportHandlers(manager.dbConnections.get("db-pg"));
  pgClient.emit("error", new Error("terminating connection"));
  assert.equal(manager.dbConnections.has("db-pg"), false);

  // explicit dbDisconnect deleted the record first → handler is a no-op
  const orphan = makeRedis();
  manager.attachDbTransportHandlers({ id: "db-orphan", client: orphan, type: "redis", config: { host: "h", port: 1 } });
  orphan.emit("error", new Error("late event after explicit disconnect"));
  assert.equal(orphan.disconnectCalls, 0, "explicit disconnect path is not double-cleaned");

  // a record without tunnel and without a client.on-capable object must not throw
  manager.attachDbTransportHandlers({ id: "db-plain", client: {}, type: "mongodb", config: { host: "h", port: 27017 } });
}

console.log("db-ops transport-loss handling: all cases passed");

// ── DB list exposes a non-secret account discriminator for client history ──

{
  const manager = Object.create(DbOpsManager.prototype);
  manager.dbConnections = new Map([[
    "db-list",
    {
      id: "db-list", name: "analytics", type: "postgresql",
      config: { host: "db.example.test", port: 5432, database: "warehouse", username: "reporter", ssl: "verify", sshConnectionId: null },
      createdAt: "2026-08-31T00:00:00.000Z"
    }
  ]]);
  const listed = manager.list();
  assert.equal(listed.value.connections[0].username, "reporter", "history can distinguish different accounts on one endpoint");
}

console.log("db-ops connection list: account discriminator passed");

// ── identifier validation + paginated preview SQL builders ───────────────────

import { validateDbIdentifier, quotePgIdentifier, buildPreviewSql } from "../src/db-ops.js";

assert.equal(validateDbIdentifier("users").ok, true);
assert.equal(validateDbIdentifier("public.users").ok, true);
assert.equal(validateDbIdentifier("_t$1").ok, true);
assert.equal(validateDbIdentifier("users; DROP TABLE x").ok, false);
assert.equal(validateDbIdentifier("users--").ok, false);
assert.equal(validateDbIdentifier("'users'").ok, false);
assert.equal(validateDbIdentifier("users UNION SELECT 1").ok, false);
assert.equal(validateDbIdentifier(123).ok, false);
assert.equal(validateDbIdentifier("a".repeat(129)).ok, false);

assert.equal(quotePgIdentifier("public.users"), '"public"."users"');
assert.equal(quotePgIdentifier('weird"name'), '"weird""name"');

const pm = buildPreviewSql("mysql", "users", 50, 0);
assert.equal(pm.ok, true);
assert.equal(pm.sql, "SELECT * FROM ?? LIMIT ? OFFSET ?");
assert.deepEqual(pm.params, ["users", 50, 0]);
const pp = buildPreviewSql("postgresql", "public.users", 50, 50);
assert.equal(pp.ok, true);
assert.equal(pp.sql, 'SELECT * FROM "public"."users" LIMIT $1 OFFSET $2');
assert.deepEqual(pp.params, [50, 50]);
assert.equal(buildPreviewSql("mysql", "t; DROP TABLE x", 50, 0).ok, false, "identifier injection is rejected before SQL is built");

console.log("db-ops identifier/preview builders: all cases passed");

// ── interactive transaction state machine (mocked mysql pool) ────────────────

{
  const manager = Object.create(DbOpsManager.prototype);
  manager.dbConnections = new Map();
  manager.dbTransactions = new Map();
  manager.sshOpsService = { ctx: { logger: { warn: () => {} } } };

  const queries = [];
  const released = [];
  const destroyed = [];
  const conn = {
    query: async (sql, params) => {
      queries.push([sql, params]);
      if (sql === "BOOM") throw new Error("boom");
      return [{ affectedRows: 2, insertId: 7 }, []];
    },
    release: () => released.push(1),
    destroy: () => destroyed.push(1)
  };
  const endCalls = [];
  manager.dbConnections.set("db-tx", {
    id: "db-tx", type: "mysql",
    client: { getConnection: async () => conn, end: async () => endCalls.push(1) }
  });

  const begun = await manager.dbTxBegin({ dbConnectionId: "db-tx" });
  assert.equal(begun.ok, true);
  assert.ok(begun.value.txId.startsWith("tx-"));
  assert.deepEqual(queries.at(-1), ["START TRANSACTION", undefined]);

  const exec = await manager.dbTxExecute({ txId: begun.value.txId, sql: "UPDATE t SET a = 1" });
  assert.equal(exec.ok, true);
  assert.equal(exec.value.affectedRows, 2);
  assert.equal(exec.value.insertId, 7);
  assert.equal(exec.value.rowCount, 0);

  const blocked = await manager.dbTxExecute({ txId: begun.value.txId, sql: "DROP TABLE t" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, "unsafe-sql", "destructive verbs stay blocked inside transactions");

  const committed = await manager.dbTxCommit({ txId: begun.value.txId });
  assert.equal(committed.value.committed, true);
  assert.deepEqual(queries.at(-1), ["COMMIT", undefined]);
  assert.equal(released.length, 1, "connection is released back to the pool on commit");
  assert.equal(manager.dbTransactions.size, 0);

  const afterCommit = await manager.dbTxExecute({ txId: begun.value.txId, sql: "SELECT 1" });
  assert.equal(afterCommit.error.code, "tx-missing");

  const begun2 = await manager.dbTxBegin({ dbConnectionId: "db-tx" });
  const rolled = await manager.dbTxRollback({ txId: begun2.value.txId });
  assert.equal(rolled.value.rolledBack, true);
  assert.deepEqual(queries.at(-1), ["ROLLBACK", undefined]);

  // Explicit disconnect rolls back open transactions before ending the pool.
  const _begun3 = await manager.dbTxBegin({ dbConnectionId: "db-tx" });
  assert.equal(manager.dbTransactions.size, 1);
  await manager.disconnect({ dbConnectionId: "db-tx" });
  assert.equal(manager.dbTransactions.size, 0, "disconnect disposes open transactions");
  assert.ok(queries.some(([sql]) => sql === "ROLLBACK"), "rollback ran against the live connection");
  assert.equal(endCalls.length, 1, "pool ended after rollback");
}

console.log("db-ops transaction state machine: all cases passed");

// ── describeTable (mysql): structured foreign keys from KEY_COLUMN_USAGE ─────

{
  const manager = Object.create(DbOpsManager.prototype);
  manager.dbConnections = new Map();
  const queries = [];
  manager.dbConnections.set("db-desc", {
    id: "db-desc", type: "mysql",
    client: {
      query: async (sql, params) => {
        queries.push([sql, params]);
        if (sql.startsWith("SHOW COLUMNS")) return [[{ Field: "id", Type: "int", Null: "NO", Key: "PRI", Default: null, Extra: "" }], []];
        if (sql.startsWith("SHOW INDEX")) return [[{ Key_name: "PRIMARY", Non_unique: 0, Column_name: "id" }], []];
        if (sql.startsWith("SHOW CREATE TABLE")) return [[{ "Create Table": "CREATE TABLE `t` (`id` int PRIMARY KEY)" }], []];
        if (sql.includes("KEY_COLUMN_USAGE")) return [[{ CONSTRAINT_NAME: "fk_order", COLUMN_NAME: "order_id", REFERENCED_TABLE_NAME: "orders", REFERENCED_COLUMN_NAME: "id" }], []];
        if (sql.includes("information_schema.TABLES")) return [[{ TABLE_ROWS: 12, DATA_LENGTH: 16384, INDEX_LENGTH: 0 }], []];
        return [[], []];
      }
    }
  });
  const r = await manager.describeTable({ dbConnectionId: "db-desc", table: "t" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.foreignKeys, [
    { name: "fk_order", column: "order_id", foreignTable: "orders", foreignColumn: "id" }
  ]);
  assert.equal(r.value.stats.estimatedRows, 12);
  // The FK lookup binds the table name as a parameter, never interpolates it.
  const fkQuery = queries.find(([sql]) => sql.includes("KEY_COLUMN_USAGE"));
  assert.equal(fkQuery[1][0], "t");
}

console.log("db-ops describe mysql foreign keys: all cases passed");

// ── mysqlQueryPaged: timeout / fatal errors destroy, server errors release ───

function makeTimeoutManager(errorProps, suffix) {
  const conn = {
    released: 0, destroyed: 0,
    release() { this.released += 1; },
    destroy() { this.destroyed += 1; },
    connection: {
      query: () => ({
        stream: () => {
          const s = new EventEmitter();
          s.destroy = () => {};
          s.resume = () => {};
          setImmediate(() => {
            const err = new Error(suffix);
            Object.assign(err, errorProps);
            s.emit("error", err);
          });
          return s;
        }
      })
    }
  };
  const manager = Object.create(DbOpsManager.prototype);
  manager.dbConnections = new Map([["db-x", { id: "db-x", type: "mysql", client: { getConnection: async () => conn } }]]);
  return { manager, conn };
}

{
  // Query timeout (PROTOCOL_SEQUENCE_TIMEOUT): mysql2 abandons the in-flight
  // command, so the pooled connection must be destroyed, never released.
  const { manager, conn } = makeTimeoutManager({ code: "PROTOCOL_SEQUENCE_TIMEOUT" }, "Query inactivity timeout");
  await assert.rejects(() => manager.mysqlQueryPaged(manager.dbConnections.get("db-x"), "SELECT SLEEP(100)", []), /inactivity timeout/);
  assert.equal(conn.destroyed, 1, "timeout path destroys the pooled connection");
  assert.equal(conn.released, 0, "timeout path never releases the poisoned connection");
}
{
  // Protocol-fatal errors (err.fatal) also destroy.
  const { manager, conn } = makeTimeoutManager({ fatal: true }, "Connection lost");
  await assert.rejects(() => manager.mysqlQueryPaged(manager.dbConnections.get("db-x"), "SELECT 1", []), /Connection lost/);
  assert.equal(conn.destroyed, 1);
  assert.equal(conn.released, 0);
}
{
  // Ordinary server errors (bad syntax — err.fatal unset) end the command
  // cleanly, so the connection is reusable and must be released, not destroyed.
  const { manager, conn } = makeTimeoutManager({}, "ER_BAD_FIELD_ERROR");
  await assert.rejects(() => manager.mysqlQueryPaged(manager.dbConnections.get("db-x"), "SELECT nope", []), /ER_BAD_FIELD_ERROR/);
  assert.equal(conn.released, 1, "clean server errors keep the pooled connection");
  assert.equal(conn.destroyed, 0);
}

console.log("db-ops mysql query paged connection lifecycle: all cases passed");
