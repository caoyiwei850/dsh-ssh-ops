// Destructive-SQL guard: DROP TABLE is backed up and quarantined by rename,
// DROP DATABASE / TRUNCATE / SHUTDOWN are backed up then blocked, and the
// final purge of a quarantined table is operator-only (panel origin).
// SQLite runs end to end on a real temp file; mysql/pg assert the dialect SQL
// through stubbed drivers.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DbOpsManager } from "../src/db-ops.js";

const sqliteSupported = await import("node:sqlite").then(() => true, () => false);
if (!sqliteSupported) {
  console.log(`db guard: skipping — this runtime (${process.version}) has no node:sqlite`);
  process.exit(0);
}
const { DatabaseSync } = await import("node:sqlite");

const base = mkdtempSync(join(tmpdir(), "dsh-db-guard-"));
const file = join(base, "ops.db");
const db = new DatabaseSync(file);
db.exec("CREATE TABLE hosts (id INTEGER PRIMARY KEY, name TEXT)");
db.exec("INSERT INTO hosts (id, name) VALUES (1, 'web-1'), (2, 'web-2')");
db.exec("CREATE TABLE extra (id INTEGER PRIMARY KEY)");
db.exec("INSERT INTO extra (id) VALUES (9)");

function makeManager(sshConnectionId = null) {
  const manager = Object.create(DbOpsManager.prototype);
  manager.dbConnections = new Map();
  manager.maxDbRows = 200;
  manager.sshOpsService = { sftpWriteFile: async (request) => ({ ok: true, value: { path: request.path, bytes: 0 } }) };
  manager.dbConnections.set("db-1", {
    id: "db-1", type: "sqlite", name: "sqlite:ops.db",
    config: { host: "", port: 0, database: file, ssl: "disabled", sshConnectionId },
    client: db, tunnel: null, createdAt: new Date().toISOString()
  });
  return manager;
}

const callOrder = [];
function spyInternals(manager) {
  const proto = DbOpsManager.prototype;
  const origExport = proto.exportRows;
  const origDescribe = proto.describeTable;
  const origList = proto.listTables;
  manager.exportRows = async function (request) {
    callOrder.push("export");
    return origExport.call(this, request);
  };
  manager.describeTable = async function (request) {
    callOrder.push("describe");
    return origDescribe.call(this, request);
  };
  manager.listTables = async function (request) {
    callOrder.push("list");
    return origList.call(this, request);
  };
}

// ── DROP TABLE (agent): backup first, then quarantine rename ─────────────────
{
  const manager = makeManager();
  spyInternals(manager);
  callOrder.length = 0;
  const result = await manager.execute({ dbConnectionId: "db-1", sql: "DROP TABLE hosts", origin: "agent" });
  assert.equal(result.ok, true, `quarantine must succeed: ${JSON.stringify(result)}`);
  assert.equal(result.value.quarantined, true);
  assert.match(result.value.renamedTo, /^hosts_to_be_dropped_\d{8}$/);
  assert.equal(result.value.affectedRows, 0);
  assert.match(result.value.notice, /彻底删除请由操作者在数据库面板执行/);

  // Backup happened BEFORE the rename and carries rows + schema.
  assert.ok(callOrder.indexOf("export") !== -1, "an export ran");
  assert.ok(callOrder.indexOf("export") < callOrder.lastIndexOf("list"), "rows are exported before the rename looks up tables");
  const entry = result.value.backup[0];
  assert.equal(entry.error, null, JSON.stringify(entry));
  assert.ok(entry.bytes > 0);
  assert.equal(entry.truncated, false);
  assert.ok(existsSync(entry.path), "row backup landed in the local temp dir");
  assert.match(readFileSync(entry.path, "utf8"), /web-1/);
  assert.ok(entry.schemaPath && existsSync(entry.schemaPath), "sqlite provides DDL");
  assert.match(readFileSync(entry.schemaPath, "utf8"), /CREATE TABLE hosts/);

  // The data survives under the quarantine name.
  const rows = db.prepare(`SELECT name FROM ${result.value.renamedTo}`).all();
  assert.deepEqual(rows.map((r) => r.name).sort(), ["web-1", "web-2"]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'hosts'").get().n, 0, "the original name is gone");
}

// ── the agent can never finalize: dropping the quarantined name is blocked ───
{
  const manager = makeManager();
  const renamed = "hosts_to_be_dropped_20260101";
  db.exec(`CREATE TABLE ${renamed} (id INTEGER)`);
  const result = await manager.execute({ dbConnectionId: "db-1", sql: `DROP TABLE ${renamed}`, origin: "agent" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "unsafe-sql");
  assert.match(result.error.message, /必须由操作者在数据库面板执行/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = ?").get(renamed).n, 1, "the quarantine table survives");
}

// ── the operator finalizes via the panel (no origin): real drop ──────────────
{
  const manager = makeManager();
  const renamed = "hosts_to_be_dropped_20260101";
  const result = await manager.execute({ dbConnectionId: "db-1", sql: `DROP TABLE ${renamed}` });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.affectedRows, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = ?").get(renamed).n, 0, "the operator's purge really drops");
}

// ── collision: re-creating the table and dropping again suffixes the name ────
{
  const manager = makeManager();
  db.exec("CREATE TABLE hosts (id INTEGER PRIMARY KEY)");
  const result = await manager.execute({ dbConnectionId: "db-1", sql: "DROP TABLE hosts", origin: "agent" });
  assert.equal(result.ok, true);
  assert.match(result.value.renamedTo, /^hosts_to_be_dropped_\d{8}_2$/, "the second quarantine must not clobber the first");
}

// ── DROP TABLE IF EXISTS on a missing table is a clean no-op ──────────────────
{
  const manager = makeManager();
  const result = await manager.execute({ dbConnectionId: "db-1", sql: "DROP TABLE IF EXISTS never_existed", origin: "agent" });
  assert.equal(result.ok, true);
  assert.equal(result.value.quarantined, false);
  assert.match(result.value.notice, /表不存在/);
}

// ── TRUNCATE: blocked after backup, rows intact (agent + panel) ───────────────
{
  const manager = makeManager();
  const agentResult = await manager.execute({ dbConnectionId: "db-1", sql: "TRUNCATE TABLE extra", origin: "agent" });
  assert.equal(agentResult.ok, false);
  assert.equal(agentResult.error.code, "unsafe-sql");
  assert.match(agentResult.error.message, /TRUNCATE 无法隔离改名/);
  assert.ok(Array.isArray(agentResult.error.backup) && agentResult.error.backup.length === 1, "the agent envelope carries the backup list");
  assert.equal(db.prepare("SELECT count(*) AS n FROM extra").get().n, 1, "rows intact");

  const panelResult = await manager.execute({ dbConnectionId: "db-1", sql: "TRUNCATE TABLE extra" });
  assert.equal(panelResult.ok, false);
  assert.ok(!("backup" in panelResult.error), "panel errors stay wire-safe");
  assert.equal(db.prepare("SELECT count(*) AS n FROM extra").get().n, 1);
}

// ── DROP DATABASE: per-table backup then blocked (sqlite: current file) ───────
{
  const manager = makeManager();
  const result = await manager.execute({ dbConnectionId: "db-1", sql: "DROP DATABASE ops", origin: "agent" });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /整库删除无法自动隔离/);
  assert.ok(Array.isArray(result.error.backup) && result.error.backup.length >= 2, `both tables backed up: ${JSON.stringify(result.error.backup)}`);
  assert.ok(result.error.backup.every((entry) => entry.error === null));
}

// ── SHUTDOWN / DROP PROCEDURE: plain blocked, no backup machinery ─────────────
{
  const manager = makeManager();
  const shutdown = await manager.execute({ dbConnectionId: "db-1", sql: "SHUTDOWN", origin: "agent" });
  assert.equal(shutdown.ok, false);
  assert.equal(shutdown.error.code, "unsafe-sql");
  assert.equal(shutdown.error.backup, undefined);
  const proc = await manager.execute({ dbConnectionId: "db-1", sql: "DROP PROCEDURE p", origin: "agent" });
  assert.equal(proc.ok, false);
  assert.equal(proc.error.backup, undefined);
}

// ── backup failure does not prevent the (reversible) quarantine ───────────────
{
  const manager = makeManager();
  // Earlier blocks renamed the original hosts away; bring one back.
  db.exec("DROP TABLE IF EXISTS hosts_to_be_dropped_20991231");
  db.exec("CREATE TABLE IF NOT EXISTS hosts (id INTEGER PRIMARY KEY)");
  manager.exportRows = async () => ({ ok: false, error: { code: "db-export-failed", message: "boom" } });
  const result = await manager.execute({ dbConnectionId: "db-1", sql: "DROP TABLE hosts", origin: "agent" });
  assert.equal(result.ok, true, "rename is reversible, so it proceeds without a backup");
  assert.match(result.value.backup[0].error, /boom/);
  assert.match(result.value.renamedTo, /^hosts_to_be_dropped_\d{8}(_\d+)?$/);
}

// ── dialect SQL: mysql RENAME TABLE via ?? escaping, pg via quoted ALTER ──────
{
  const manager = makeManager();
  manager.dbConnections.set("my-1", {
    id: "my-1", type: "mysql", name: "mysql:app",
    config: { host: "10.0.0.5", port: 3306, database: "app", ssl: "disabled", sshConnectionId: null },
    client: {}, tunnel: null, createdAt: new Date().toISOString()
  });
  manager.exportRows = async () => ({ ok: true, value: { format: "csv", bytes: 5, truncated: false, path: null, content: "a,b\r\n1,2\r\n" } });
  manager.describeTable = async () => ({ ok: true, value: { table: "users", ddl: "CREATE TABLE users (id int)" } });
  manager.listTables = async () => ({ ok: true, value: { tables: ["users"] } });
  const mysqlCalls = [];
  manager.mysqlQueryOnce = async (record, sql, params) => { mysqlCalls.push({ sql, params }); return [[]]; };


  const mysqlResult = await manager.execute({ dbConnectionId: "my-1", sql: "DROP TABLE app.users", origin: "agent" });
  assert.equal(mysqlResult.ok, true, JSON.stringify(mysqlResult));
  const renameCall = mysqlCalls.find((c) => c.sql.startsWith("RENAME TABLE"));
  assert.ok(renameCall, "mysql rename uses RENAME TABLE");
  assert.deepEqual(renameCall.params, ["app.users", "app.users_to_be_dropped_" + new Date().toISOString().slice(0, 10).replace(/-/g, "")]);
  // Direct (non-SSH) connection: row backup lands on the DSH host.
  assert.ok(existsSync(mysqlResult.value.backup[0].path), "inline export is written to the local temp dir");
  assert.ok(mysqlResult.value.backup[0].schemaPath, "mysql DDL is stored next to the rows");
}
{
  const manager = makeManager();
  manager.dbConnections.set("pg-1", {
    id: "pg-1", type: "postgresql", name: "pg:app",
    config: { host: "10.0.0.6", port: 5432, database: "app", ssl: "disabled", sshConnectionId: null },
    client: {}, tunnel: null, createdAt: new Date().toISOString()
  });
  manager.exportRows = async () => ({ ok: true, value: { format: "csv", bytes: 5, truncated: false, path: null, content: "a\r\n1\r\n" } });
  manager.describeTable = async () => ({ ok: true, value: { table: "users", ddl: null } }); // pg has no DDL
  manager.listTables = async () => ({ ok: true, value: { tables: ["users"] } });
  const pgCalls = [];
  manager.pgQueryOnce = async (record, sql, _params) => { pgCalls.push(sql); return { rowCount: 0 }; };

  const pgResult = await manager.execute({ dbConnectionId: "pg-1", sql: "DROP TABLE users", origin: "agent" });
  assert.equal(pgResult.ok, true, JSON.stringify(pgResult));
  assert.ok(pgCalls.some((sql) => /ALTER TABLE "users" RENAME TO "users_to_be_dropped_\d{8}"/.test(sql)), `pg rename: ${pgCalls.join(" | ")}`);
  assert.equal(pgResult.value.backup[0].schemaPath, null, "pg has no DDL to store");
}

db.close();
rmSync(base, { recursive: true, force: true });
console.log("db guard: backup, quarantine rename, operator-only purge and dialect rewrites passed");
