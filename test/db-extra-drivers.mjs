// New SQL drivers (SQLite via node:sqlite, ClickHouse via HTTP) and the
// CSV/JSON export path: type metadata, placeholder translation, result
// mapping, truncation, error surfacing, and the two export destinations
// (inline for a direct connection, remote file through the SSH tunnel).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DB_TYPE_DEFAULTS,
  clickhouseDescribeTable,
  clickhouseEndpoint,
  clickhouseExecute,
  clickhouseListTables,
  clickhouseQuery,
  defaultDbPort,
  isPgFamily,
  isSqlType,
  needsNetwork,
  openSqlite,
  sqliteDescribeTable,
  sqliteExecute,
  sqliteListTables,
  sqliteQuery,
  toCsv,
  toJson,
  translateClickHouseParams
} from "../src/db-drivers.js";
import { DbOpsManager, buildPreviewSql } from "../src/db-ops.js";

// ── type metadata ───────────────────────────────────────────────────────────
assert.equal(defaultDbPort("clickhouse"), 8123);
assert.equal(defaultDbPort("opengauss"), 5432);
assert.equal(defaultDbPort("sqlite"), 0);
assert.equal(DB_TYPE_DEFAULTS.mysql, 3306);
assert.equal(isPgFamily("opengauss"), true);
assert.equal(isPgFamily("postgresql"), true);
assert.equal(isPgFamily("mysql"), false);
assert.equal(isSqlType("sqlite"), true);
assert.equal(isSqlType("clickhouse"), true);
assert.equal(isSqlType("redis"), false);
assert.equal(needsNetwork("sqlite"), false);
assert.equal(needsNetwork("clickhouse"), true);

// ── preview SQL per dialect ─────────────────────────────────────────────────
assert.deepEqual(buildPreviewSql("sqlite", "users", 50, 100), { ok: true, sql: 'SELECT * FROM "users" LIMIT ? OFFSET ?', params: [50, 100] });
assert.deepEqual(buildPreviewSql("clickhouse", "events", 10, 0), { ok: true, sql: "SELECT * FROM `events` LIMIT ? OFFSET ?", params: [10, 0] });
assert.equal(buildPreviewSql("sqlite", "bad name; drop", 1, 0).ok, false);
// The identifier whitelist rejects quotes/backticks before any quoting helper
// sees them — dialect quoting is the second line, not the only one.
assert.equal(buildPreviewSql("clickhouse", 'we"ird`tick', 1, 0).ok, false);
assert.equal(buildPreviewSql("clickhouse", "analytics.events", 1, 0).ok, true);
assert.equal(buildPreviewSql("sqlite", "main.hosts", 1, 0).sql, 'SELECT * FROM "main.hosts" LIMIT ? OFFSET ?');

// ── ClickHouse placeholder translation ──────────────────────────────────────
{
  const { sql, searchParams } = translateClickHouseParams("SELECT * FROM t WHERE a = ? AND b = ? LIMIT ?", ["x", 42, 10]);
  assert.equal(sql, "SELECT * FROM t WHERE a = {p1:String} AND b = {p2:UInt64} LIMIT {p3:UInt64}");
  assert.deepEqual(searchParams, [["param_p1", "x"], ["param_p2", "42"], ["param_p3", "10"]]);

  // Quoted literals, identifiers and comments must not be treated as placeholders.
  const tricky = translateClickHouseParams("SELECT '?' AS q, \"?\" AS d, `?` AS b /* ? */ -- ?\n, ? AS real", ["v"]);
  assert.equal(tricky.sql, "SELECT '?' AS q, \"?\" AS d, `?` AS b /* ? */ -- ?\n, {p1:String} AS real");
  assert.deepEqual(tricky.searchParams, [["param_p1", "v"]]);

  // Doubled quotes inside a string literal are escapes, not terminations.
  const escaped = translateClickHouseParams("SELECT 'it''s ?' AS s, ? AS x", [7]);
  assert.equal(escaped.sql, "SELECT 'it''s ?' AS s, {p1:UInt64} AS x");

  assert.throws(() => translateClickHouseParams("SELECT ?", []), /参数个数多于/);
  assert.throws(() => translateClickHouseParams("SELECT 1", ["v"]), /不一致/);
  assert.equal(translateClickHouseParams("SELECT 1", []).sql, "SELECT 1");
}

// ── ClickHouse endpoint + HTTP round trips on a stubbed fetch ───────────────
{
  const record = { config: { host: "ch.internal", port: 8123, username: "reader", password: "s3cret", database: "analytics", ssl: "disabled" } };
  const { url, headers } = clickhouseEndpoint(record);
  assert.equal(url, "http://ch.internal:8123/");
  assert.equal(headers["X-ClickHouse-User"], "reader");
  assert.equal(headers["X-ClickHouse-Key"], "s3cret");
  assert.equal(headers["X-ClickHouse-Database"], "analytics");
  assert.equal(clickhouseEndpoint({ config: { host: "h", port: 8443, ssl: "verify" } }).url, "https://h:8443/");
  assert.equal(clickhouseEndpoint({ config: { host: "h", port: 8443, ssl: "preferred" } }).secure, true);

  const calls = [];
  const jsonCompact = (names, data) => JSON.stringify({ meta: names.map((name) => ({ name, type: "String" })), data, rows: data.length });
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init.body, headers: init.headers });
    const body = String(init.body);
    if (/SHOW TABLES/.test(body)) return { ok: true, text: async () => jsonCompact(["name"], [["events"], ["users"]]) };
    if (/DESCRIBE TABLE/.test(body)) {
      return { ok: true, text: async () => jsonCompact(["name", "type", "is_in_primary_key", "default_type", "default_expression"], [["id", "UInt64", 1, "", ""], ["mail", "Nullable(String)", 0, "", ""]]) };
    }
    if (/max_result_rows/.test(url)) return { ok: true, text: async () => jsonCompact(["n", "s"], [[1, "a"], [2, "b"], [3, "c"]]) };
    return { ok: true, text: async () => jsonCompact(["ok"], [[1]]) };
  };

  const queried = await clickhouseQuery(record, "SELECT n, s FROM t WHERE s = ?", ["x"], { fetchImpl, maxRows: 2 });
  assert.deepEqual(queried.fieldNames, ["n", "s"]);
  assert.deepEqual(queried.rows, [{ n: 1, s: "a" }, { n: 2, s: "b" }]);
  assert.equal(queried.truncated, true, "one row past the cap marks the result truncated");
  const queryCall = calls.at(-1);
  assert.ok(queryCall.body.endsWith("FORMAT JSONCompact"), "read path appends the compact format");
  assert.ok(queryCall.url.includes("param_p1=x"), "bindings travel as URL parameters");
  assert.ok(queryCall.url.includes("result_overflow_mode=break"));

  await assert.rejects(() => clickhouseQuery(record, "SELECT 1 FORMAT CSV", [], { fetchImpl }), /FORMAT 子句/);

  await clickhouseExecute(record, "INSERT INTO t VALUES (?)", [5], { fetchImpl });
  assert.equal(calls.at(-1).body, "INSERT INTO t VALUES ({p1:UInt64})", "write path keeps the statement free of values");

  assert.deepEqual(await clickhouseListTables(record, { fetchImpl }), ["events", "users"]);
  const described = await clickhouseDescribeTable(record, "users", { fetchImpl });
  assert.equal(described[0].key, "PRI");
  assert.equal(described[1].nullable, true);

  const failing = async () => ({ ok: false, status: 500, text: async () => "Code: 62. DB::Exception: Syntax error: failed at position 1" });
  await assert.rejects(() => clickhouseQuery(record, "SELECT", [], { fetchImpl: failing }),
    /ClickHouse HTTP 500: Syntax error: failed at position 1/,
    "the registry's Code/DB::Exception wrapper is stripped, the reason is kept");
}

// ── SQLite end to end on a real temp file ───────────────────────────────────
//
// `node:sqlite` is a built-in only from Node 22.5 on, and the CI matrix covers
// Node 20: there the driver is EXPECTED to refuse with a clear message (that
// path is asserted below), and the round-trip half of this file has nothing to
// talk to. Probe the runtime once and skip that half rather than failing a
// suite that cannot possibly pass.
const sqliteSupported = await import("node:sqlite").then(() => true, () => false);
if (!sqliteSupported) {
  console.log(`db extra drivers: skipping the SQLite round trip — this runtime (${process.version}) has no node:sqlite`);
  const unavailable = await openSqlite("/tmp/would-be.db").then(() => null, (error) => error);
  assert.match(String(unavailable?.message ?? ""), /不提供内置 SQLite/, "an unsupported runtime is refused with the documented message");
}
const dir = sqliteSupported ? mkdtempSync(join(tmpdir(), "dsh-ssh-ops-sqlite-")) : null;
if (sqliteSupported) try {
  const file = join(dir, "ops.db");
  await assert.rejects(() => openSqlite(""), /需要填写数据库文件路径/);

  const db = await openSqlite(file);
  sqliteExecute(db, "CREATE TABLE hosts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, tags TEXT)");
  const inserted = sqliteExecute(db, "INSERT INTO hosts (name, tags) VALUES (?, ?)", ["web-1", null]);
  assert.equal(inserted.affectedRows, 1);
  sqliteExecute(db, "INSERT INTO hosts (name, tags) VALUES (?, ?)", ["web-2", "prod"]);
  sqliteExecute(db, "UPDATE hosts SET name = ? WHERE id = ?", ["web-2-renamed", 2]);
  assert.equal(sqliteExecute(db, "DELETE FROM hosts WHERE id = ?", [1]).affectedRows, 1);

  const all = sqliteQuery(db, "SELECT id, name, tags FROM hosts ORDER BY id", [], 200);
  assert.deepEqual(all.fieldNames, ["id", "name", "tags"]);
  assert.deepEqual(all.rows, [{ id: 2, name: "web-2-renamed", tags: "prod" }]);
  assert.equal(all.truncated, false);

  const capped = sqliteQuery(db, "SELECT id FROM hosts", [], 0);
  assert.equal(capped.truncated, true, "a zero cap still reports truncation rather than dropping rows silently");

  assert.deepEqual(sqliteListTables(db), ["hosts"]);
  const columns = sqliteDescribeTable(db, "hosts");
  assert.deepEqual(columns.map((c) => c.name), ["id", "name", "tags"]);
  assert.equal(columns[0].key, "PRI");
  assert.equal(columns[1].nullable, false);
  assert.equal(columns[2].nullable, true);

  // A table name with a quote is quoted as a literal, never interpolated.
  assert.deepEqual(sqliteDescribeTable(db, 'we"ird'), []);

  // Export through the manager: no SSH connection → inline content.
  const manager = Object.create(DbOpsManager.prototype);
  manager.dbConnections = new Map();
  manager.maxDbRows = 200;
  manager.sshOpsService = { sftpWriteFile: async () => { throw new Error("must not be called for a direct connection"); } };
  manager.dbConnections.set("db-1", {
    id: "db-1", type: "sqlite", name: "sqlite:ops.db",
    config: { host: "", port: 0, database: file, ssl: "disabled", sshConnectionId: null },
    client: db, tunnel: null, createdAt: new Date().toISOString()
  });
  const inline = await manager.exportRows({ dbConnectionId: "db-1", sql: "SELECT id, name FROM hosts", format: "csv" });
  assert.equal(inline.ok, true);
  assert.equal(inline.value.path, null);
  assert.equal(inline.value.rows, 1);
  assert.equal(inline.value.content, "id,name\r\n2,web-2-renamed\r\n");
  assert.equal(inline.value.truncated, false);

  const json = await manager.exportRows({ dbConnectionId: "db-1", sql: "SELECT id, name FROM hosts", format: "json", delimiter: "tab" });
  assert.equal(json.ok, true);
  assert.deepEqual(JSON.parse(json.value.content), [{ id: 2, name: "web-2-renamed" }]);

  // Export refuses to become a second write channel.
  const writeAttempt = await manager.exportRows({ dbConnectionId: "db-1", sql: "DELETE FROM hosts", format: "csv" });
  assert.equal(writeAttempt.ok, false);
  assert.equal(writeAttempt.error.code, "readonly-sql");

  // Export through an SSH connection lands on the server as base64 SFTP bytes.
  const writes = [];
  manager.sshOpsService = {
    sftpWriteFile: async (request) => { writes.push(request); return { ok: true, value: { path: request.path, bytes: 0 } }; }
  };
  manager.dbConnections.set("db-2", {
    id: "db-2", type: "sqlite", name: "sqlite:tunneled",
    config: { host: "", port: 0, database: file, ssl: "disabled", sshConnectionId: "ssh-1" },
    client: db, tunnel: null, createdAt: new Date().toISOString()
  });
  const remote = await manager.exportRows({ dbConnectionId: "db-2", sql: "SELECT id, name FROM hosts", format: "csv" });
  assert.equal(remote.ok, true);
  assert.match(remote.value.path, /^\/tmp\/dsh-export-sqlite-tunneled-[\dT-]+\.csv$/);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].connectionId, "ssh-1");
  assert.equal(writes[0].path, remote.value.path);
  assert.equal(Buffer.from(writes[0].data, "base64").toString("utf8"), remote.value.content ?? "id,name\r\n2,web-2-renamed\r\n");

  const explicit = await manager.exportRows({ dbConnectionId: "db-2", sql: "SELECT id FROM hosts", format: "csv", path: "/data/dump.csv" });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.value.path, "/data/dump.csv");

  // A SQLite connect must NOT open a tunnel (the file is local), yet it keeps
  // the sshConnectionId so a later export can land on that server.
  {
    const connectManager = Object.create(DbOpsManager.prototype);
    connectManager.dbConnections = new Map();
    connectManager.maxDbRows = 200;
    connectManager.fetchImpl = undefined;
    let tunnelCalls = 0;
    connectManager.createTunnel = async () => { tunnelCalls += 1; throw new Error("tunnel must not be attempted for sqlite"); };
    connectManager.sshOpsService = {};
    const connected = await connectManager.connect({ type: "sqlite", database: file, sshConnectionId: "ssh-1", name: "sqlite tunnel-bound" });
    assert.equal(connected.ok, true, `sqlite connect with a sshConnectionId must succeed: ${JSON.stringify(connected)}`);
    assert.equal(tunnelCalls, 0, "sqlite never asks the SSH connection for a tunnel");
    const record = connectManager.dbConnections.get(connected.value.dbConnectionId);
    assert.equal(record.config.sshConnectionId, "ssh-1", "the ssh connection stays recorded as the export destination");
    assert.equal(record.config.host, "");
    await connectManager.disconnect({ dbConnectionId: connected.value.dbConnectionId });
  }

  db.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ── CSV / JSON serializers ──────────────────────────────────────────────────
{
  const columns = ["a", "b", "c"];
  const rows = [
    { a: "plain", b: 'has "quotes"', c: "line\nbreak" },
    { a: null, b: "with,comma", c: undefined }
  ];
  const csv = toCsv(columns, rows);
  assert.equal(csv, 'a,b,c\r\nplain,"has ""quotes""","line\nbreak"\r\n,"with,comma",\r\n');
  const tsv = toCsv(columns, rows, { delimiter: "\t", header: false });
  assert.equal(tsv.split("\r\n")[0], 'plain\t"has ""quotes"""\t"line\nbreak"');
  const json = JSON.parse(toJson(columns, rows));
  assert.deepEqual(json[1], { a: null, b: "with,comma", c: null }, "explicit nulls keep every column present");
}

console.log("db extra drivers: sqlite round trips, clickhouse protocol mapping, export destinations all passed");
