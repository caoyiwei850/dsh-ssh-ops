import assert from "node:assert/strict";
import { assessSqlStatement } from "../src/db-safety.js";

// 不可恢复 / 停库语句必须拦截（大小写、空格、分号不敏感）
const blockedSql = [
  "DROP DATABASE production",
  "drop database production",
  "  DROP  DATABASE  production  ",
  "DROP SCHEMA public",
  "DROP TABLE users",
  "DROP TABLE IF EXISTS users",
  "TRUNCATE TABLE users",
  "truncate users",
  "SHUTDOWN",
  "shutdown;",
  // 多语句注入：第二条语句的 DROP / TRUNCATE 必须被拦
  "SELECT 1; DROP TABLE x",
  "-- note line\nDROP TABLE x",
  "/* c */ TRUNCATE TABLE t"
];

// 可恢复 / 正常写操作放行。高频 CRUD 里常出现含 DROP/TRUNCATE/SHUTDOWN
// 字样的字符串、注释或列名——动词识别必须不误伤这些。
const allowedSql = [
  "SELECT * FROM users",
  "SELECT 1",
  "INSERT INTO users (id) VALUES (1)",
  "UPDATE users SET name='x' WHERE id=1",
  "DELETE FROM users WHERE id=1",
  "DELETE FROM users",
  "CREATE TABLE t (id int)",
  "ALTER TABLE t ADD COLUMN c int",
  "SHOW TABLES",
  "SHOW DATABASES",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "INSERT INTO audit_log(event) VALUES ('user ran TRUNCATE TABLE orders')",
  "INSERT INTO t(msg) VALUES ('DROP TABLE secrets')",
  "SELECT 'SHUTDOWN' AS label",
  "CREATE TABLE meta(note text) /* TRUNCATE demo */",
  "SELECT note FROM truncate_log WHERE note LIKE '%DROP%'"
];

for (const sql of blockedSql) {
  const result = assessSqlStatement(sql);
  assert.equal(result.blocked, true, `expected blocked: ${sql}`);
  assert.ok(typeof result.reason === "string" && result.reason.length > 0, `expected reason for: ${sql}`);
}

for (const sql of allowedSql) {
  const result = assessSqlStatement(sql);
  assert.equal(result.blocked, false, `expected allowed: ${sql}`);
}

console.log(`db-safety: ${blockedSql.length} blocked and ${allowedSql.length} allowed cases passed`);

// ── read-only gate for the query channel (assessReadOnlySql) ─────────────────

import { assessReadOnlySql } from "../src/db-safety.js";

// Legitimate read statements pass.
const readonlyOk = [
  "SELECT * FROM users WHERE name = 'delete' LIMIT 10",
  "select id, name from `update` where x > 1",
  "SHOW TABLES",
  "SHOW CREATE TABLE users",
  "SHOW INDEX FROM t1",
  "DESCRIBE users",
  "EXPLAIN SELECT * FROM users",
  "WITH recent AS (SELECT * FROM orders WHERE created_at > '2026-01-01') SELECT * FROM recent",
  "WITH c AS (SELECT 1 AS one) SELECT * FROM c",
  "SELECT REPLACE(name, 'a', 'b') FROM users",
  "SELECT 1; SELECT 2",            // multiple read statements
  "-- UPDATE users\nSELECT * FROM users",   // write keyword inside comment
  "SELECT * FROM users /* DROP TABLE x */",
];
for (const sql of readonlyOk) {
  const gate = assessReadOnlySql(sql);
  assert.equal(gate.ok, true, `expected read-only OK: ${sql} → ${gate.reason ?? ""}`);
}

// Anything that writes, locks, or escapes the read channel is rejected.
const readonlyBlocked = [
  "UPDATE users SET a = 1",
  "DELETE FROM users",
  "INSERT INTO users VALUES (1)",
  "SELECT 1; DROP TABLE x",                          // multi-statement smuggle
  "WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x",  // PG data-modifying CTE
  "WITH x AS (UPDATE t SET a = 1) SELECT * FROM x",
  "SELECT * FROM t FOR UPDATE",                      // locking read
  "SELECT * FROM t FOR SHARE",
  "SELECT * FROM t INTO OUTFILE '/tmp/x'",           // MySQL SELECT INTO
  "SELECT * FROM t INTO @v",
  "REPLACE INTO users VALUES (1)",                   // REPLACE statement (not function)
  "CALL do_something()",
  "SET GLOBAL max_connections = 1",
  "EXPLAIN ANALYZE DELETE FROM t",                   // PG EXPLAIN ANALYZE executes
  "CREATE TABLE t2 (id int)",
  "GRANT ALL ON *.* TO u",
  "SELECT 1; INSERT INTO logs VALUES (1)",
  // MySQL executable version comments are sent verbatim and EXECUTED by the
  // server; their content must be lexed as SQL, never skipped as a comment.
  "SELECT 1; /*!32302 DROP TABLE x */",
  "/*!50000 DELETE FROM users */",
  "SELECT 1 /* plain */; /*!50000 TRUNCATE t */",
];
for (const sql of readonlyBlocked) {
  const gate = assessReadOnlySql(sql);
  assert.equal(gate.ok, false, `expected blocked: ${sql}`);
  assert.ok(gate.reason, `blocked case carries a reason: ${sql}`);
}

console.log(`db-safety readonly gate: ${readonlyOk.length} allowed and ${readonlyBlocked.length} blocked cases passed`);

// ── destructive-target parsing (backup / quarantine machinery) ───────────────
import { parseDestructiveTarget, QUARANTINE_SUFFIX_RE } from "../src/db-safety.js";

const targetCases = [
  ["DROP TABLE users", { verb: "DROP", kind: "table", identifier: "users" }],
  ["drop table Users", { verb: "DROP", kind: "table", identifier: "Users" }], // case preserved
  ["DROP TABLE IF EXISTS t1", { verb: "DROP", kind: "table", identifier: "t1" }],
  ["DROP TABLE schema_a.users", { verb: "DROP", kind: "table", identifier: "schema_a.users" }],
  ["  DROP  TABLE  t2 ", { verb: "DROP", kind: "table", identifier: "t2" }],
  ["DROP DATABASE production", { verb: "DROP", kind: "database", identifier: "production" }],
  ["DROP SCHEMA private", { verb: "DROP", kind: "schema", identifier: "private" }],
  ["TRUNCATE TABLE logs", { verb: "TRUNCATE", kind: "table", identifier: "logs" }],
  ["TRUNCATE logs", { verb: "TRUNCATE", kind: "table", identifier: "logs" }],
  ["truncate table access_log_2026", { verb: "TRUNCATE", kind: "table", identifier: "access_log_2026" }],
  ["SELECT 1; DROP TABLE x", { verb: "DROP", kind: "table", identifier: "x" }], // first destructive statement
  ["DROP TABLE a, b", { verb: "DROP", kind: "table", identifier: "a" }], // multi-table: first target only
  ["DROP TABLE t CASCADE", { verb: "DROP", kind: "table", identifier: "t" }],
  ["DROP TABLE t RESTRICT", { verb: "DROP", kind: "table", identifier: "t" }],
  ["SHUTDOWN", { verb: "SHUTDOWN", kind: null, identifier: null }],
  ["DROP PROCEDURE p", { verb: "DROP", kind: null, identifier: null }],
  ["DROP TRIGGER trg", { verb: "DROP", kind: null, identifier: null }],
  ["DROP TABLE `weird name`", { verb: "DROP", kind: "table", identifier: null }], // quoted identifiers are lexed out
  ["DROP TABLE", { verb: "DROP", kind: "table", identifier: null }]
];
for (const [sql, expected] of targetCases) {
  assert.deepEqual(parseDestructiveTarget(sql), expected, `parse target of: ${sql}`);
}
// Assessments agree on the verb the parser reports.
for (const [sql] of targetCases) {
  const assessment = assessSqlStatement(sql);
  assert.equal(assessment.blocked, true, `expected blocked: ${sql}`);
  const target = parseDestructiveTarget(sql);
  assert.equal(target.verb, assessment.verb, `verb agreement: ${sql}`);
}
assert.equal(parseDestructiveTarget("SELECT * FROM t"), null);
assert.equal(parseDestructiveTarget(""), null);

// Quarantine suffix recognition: rename target names must round-trip.
assert.ok(QUARANTINE_SUFFIX_RE.test("users_to_be_dropped_20260924"));
assert.ok(QUARANTINE_SUFFIX_RE.test("users_to_be_dropped_20260924_2"));
assert.ok(QUARANTINE_SUFFIX_RE.test("t_to_be_dropped_20261231"));
assert.ok(!QUARANTINE_SUFFIX_RE.test("users"));
assert.ok(!QUARANTINE_SUFFIX_RE.test("users_to_be_dropped"));
assert.ok(!QUARANTINE_SUFFIX_RE.test("users_to_be_dropped_2026"));

console.log(`db-safety destructive-target parser: ${targetCases.length} cases passed`);
