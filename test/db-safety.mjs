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

// ── dialect comment-split probes (ported from navop's SQL lexer regressions) ─
//
// navop 连续两轮修的注释/字符串切分边界，在这里作为安全门禁的回归探针：
// 三段式 COMMENT ON、嵌套块注释、PG E'' 转义串，以及 Oracle q'' 交替引号
// 的「否决探针」（曾按 Oracle 语义实现又被实测否决，见第 3 节）。
// 方向性原则：扫描器宁可多暴露文本（误拦，安全方向），绝不能吞掉服务器
// 真会执行的文本（漏检）。

// 1) COMMENT ON 三段式（navop f44b141 / ecd90db 的原始现场）：带引号的三段
//    标识符、字符串里的分号，都必须按一条完整语句处理，而不是被引号里的
//    内容骗出多余的语句切分。
{
  const commentCases = [
    `COMMENT ON COLUMN "ai-manager-330-dev"."AI_SKILL_SYNC_RECORD"."ID" IS 'Id';`,
    `COMMENT ON COLUMN "ai-manager-330-dev"."AI_SKILL_SYNC_RECORD"."ID" IS 'Id'`,
    `COMMENT ON COLUMN "db"."t"."c" IS '含分号的注释; DROP 字样也安全';`,
    `ALTER TABLE "ai-manager-330-dev"."t" ADD COLUMN "c" VARCHAR(20);`
  ];
  for (const sql of commentCases) {
    // 破坏性动词门禁：COMMENT/ALTER 不是 DROP/TRUNCATE/SHUTDOWN，放行。
    assert.equal(assessSqlStatement(sql).blocked, false, `COMMENT/ALTER 不应拦：${sql}`);
    // 只读门禁：动词不是读动词，必须整体拒绝——关键是拒绝原因指向语句动词
    // 本身，而不是被字符串内容污染出来的假语句。
    const gate = assessReadOnlySql(sql);
    assert.equal(gate.ok, false, `只读门禁应拒绝：${sql}`);
    assert.match(gate.reason, /^(只读查询不允许以)/, `拒绝原因是语句动词：${sql}`);
    assert.equal(gate.verbs.length, 1, `三段式语句必须是完整一条：${sql} → ${JSON.stringify(gate.verbs)}`);
  }
  // 前半段是真查询、后半段是 COMMENT ON：切分必须精确落在顶层分号上。
  const mixed = assessReadOnlySql(`SELECT 1; COMMENT ON COLUMN "s"."T"."C" IS 'Id; note'`);
  assert.equal(mixed.ok, false);
  assert.deepEqual(mixed.verbs, ["SELECT", "COMMENT"], `多语句切分：${JSON.stringify(mixed.verbs)}`);
}

// 2) 嵌套块注释：本扫描器按单层注释处理（MySQL/Oracle 语义，第一个 */ 收口）。
//    这在 PG/MSSQL（支持嵌套）下会把注释文本多当 SQL 词法——误拦方向，安全。
//    关键回归是反方向绝不发生：MySQL 语义下早收口后暴露的文本是真 SQL，
//    破坏性动词必须照样被拦（navop streaming_parser 的嵌套判定边界）。
{
  // PG 嵌套注释里的文本被当成词法——不崩溃、不漏检即可。
  assert.equal(assessSqlStatement("SELECT /* /* inner */ still comment */ 1").blocked, false);
  // MySQL 语义：第一个 */ 收口，后面是活 SQL → 必须拦。
  assert.equal(assessSqlStatement("/* /* 嵌套示例 */ DROP TABLE x").blocked, true, "早收口后暴露的 DROP 必须拦");
  // 完整包裹形式的嵌套写法（整句都在注释里，MySQL 下是纯注释）不误拦。
  assert.equal(assessSqlStatement("/* /* nested */ all comment */").blocked, false);
}

// 3) q'[...]' 绝不能按 Oracle 交替引号当字面量吞掉（0.3.15 复测实测漏检）。
//    本插件 SQL 驱动只有 MySQL/PG：两个方言里 q 都是普通别名标识符，
//    q'[a' 之后分号切出的语句服务器真会执行。扫描器的普通引号语义（下一个
//    未转义、未翻倍的引号收口）与 MySQL 串规则逐字符一致，因此把 q'[..]'
//    整段吞成假字面量只会把真实语句藏起来——漏检方向，绝对禁止。
{
  // 合法别名 + 普通字符串形态：读门禁放行、单语句。
  const qCases = [
    [`SELECT q'[a;b]' FROM dual`, "干净引号串按 MySQL 语义切分"],
    [`SELECT q'[it's]' FROM dual`, "撇号收口后的余文进字符串（MySQL 同样如此，服务端是语法错误）"],
    [`SELECT q'<a>' FROM dual`, "尖括号在普通串内"],
    [`SELECT q'(a(b)c)' FROM dual`, "圆括号在普通串内"],
    [`SELECT Q"[it's]" FROM dual`, "双引号串路径（撇号在 \"..\" 内）"],
    [`SELECT 1 q'alias'`, "MySQL 别名 + 串"],
    [`SELECT freq'[x]' FROM dual`, "长标识符最大 munch 后接普通串"]
  ];
  for (const [sql, why] of qCases) {
    const gate = assessReadOnlySql(sql);
    assert.equal(gate.ok, true, `${why}：${sql} → ${gate.reason ?? ""}`);
    assert.equal(gate.verbs.length, 1, `${why}（单语句）：${sql} → ${JSON.stringify(gate.verbs)}`);
  }
  // 撇号提前收口后，分号切出的 DROP 是活语句：必须拦（服务端因尾部
  // 定界符残留会报语法错误、DROP 不执行——拦它是误拦方向，安全）。
  const exposed = `SELECT q'{it's; DROP TABLE x}' FROM dual`;
  assert.equal(assessSqlStatement(exposed).blocked, true, "收口后暴露的 DROP 必须拦");
  const exposedGate = assessReadOnlySql(exposed);
  assert.equal(exposedGate.ok, false);
  assert.deepEqual(exposedGate.verbs, ["SELECT", "DROP"], `暴露切分：${JSON.stringify(exposedGate.verbs)}`);
  // P1 回归现场：把 q'[..]' 当 Oracle 字面量会让这两条双双过闸，而
  // MySQL 上 DROP 真会执行（st1=别名+串合法，st2=DROP，st3=注释；PG 对
  // 表达式后接字符串字面量报语法错误、整串不执行——无论哪个方言，拦都是对的）。
  const bypasses = [
    `SELECT q'[a'; DROP TABLE important; --]'`,
    `SELECT q'[a'; DROP TABLE important`
  ];
  for (const sql of bypasses) {
    assert.equal(assessSqlStatement(sql).blocked, true, `q'' 假字面量不得藏住 DROP：${sql}`);
    const gate = assessReadOnlySql(sql);
    assert.equal(gate.ok, false, `读门禁必须看到第二条 DROP：${sql}`);
    assert.deepEqual(gate.verbs, ["SELECT", "DROP"], `切分精确：${sql} → ${JSON.stringify(gate.verbs)}`);
  }
  // 对照：没有 q 前缀的同形语句（旧行为）本就拦截，不依赖本轮改动。
  assert.equal(assessSqlStatement(`SELECT x'[a'; DROP TABLE important; --]'`).blocked, true);
  // 前半查询、后半 DROP，必须精确切分并拦截。
  const split = `SELECT q'[a;b]' FROM dual; DROP TABLE x`;
  assert.equal(assessSqlStatement(split).blocked, true, "q 串之后的第二条 DROP 必须拦");
  const gate = assessReadOnlySql(split);
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.verbs, ["SELECT", "DROP"], `q 串后的切分：${JSON.stringify(gate.verbs)}`);
  // 首个引号串未收口（全文再无引号）：字符串吞到行尾，没有活语句——
  // 不拦；服务端该语句是未终止字符串的语法错误，同样什么都不会执行。
  assert.equal(assessSqlStatement("SELECT q'[未收口; DROP TABLE x").blocked, false, "未收口串内的 DROP 不拦");
}

// 4) PG E'' 转义字符串：反斜杠转义的引号与分号都在字符串内。
{
  const eCases = [
    `SELECT E'it\\'s; DROP' FROM t`,
    `SELECT e'a\\'b; TRUNCATE c' FROM t`,
    `SELECT E'ends with escaped quote\\''`
  ];
  for (const sql of eCases) {
    const gate = assessReadOnlySql(sql);
    assert.equal(gate.ok, true, `E 串转义内容不外泄：${sql} → ${gate.reason ?? ""}`);
    assert.equal(gate.verbs.length, 1, `E 串不产生假切分：${sql} → ${JSON.stringify(gate.verbs)}`);
  }
  // E 串结束后真语句照常识别。
  const after = `SELECT E'x\\'y'; DROP TABLE t`;
  assert.equal(assessSqlStatement(after).blocked, true, "E 串之后的 DROP 必须拦");
}

// 5) 反斜杠引号的双解释（修 PG 普通字符串的既有漏检）：MySQL 默认把 \'
//    当转义；PG 普通字符串/引号标识符、MySQL 反引号标识符、SQLite 字符串
//    都不认反斜杠转义——字符串边界随方言漂移的 SQL，门禁按「两种读法取
//    拦截」处置：分词一致则行为照旧，分歧则只读通道拒绝、破坏性动词取并集。
{
  // PG 漏检现场：PG/SQLite 上第二条 DROP 真会执行，MySQL 读法把它藏进字符串。
  const pgMiss = "SELECT 'a\\'; DROP TABLE x; SELECT 'b'";
  assert.equal(assessSqlStatement(pgMiss).blocked, true, "反斜杠引号的方言歧义不得藏住 DROP");
  assert.equal(assessSqlStatement(pgMiss).verb, "DROP");
  assert.equal(assessReadOnlySql(pgMiss).ok, false, "读门禁必须拒绝方言歧义查询");
  // MySQL 反引号标识符同族漏检：\` 在标识符里不转义，DROP 是活语句。
  const backtickMiss = "SELECT `a\\`; DROP TABLE important; --`";
  assert.equal(assessSqlStatement(backtickMiss).blocked, true, "反引号标识符的 \\` 不得藏住 DROP");
  // 良性歧义（MySQL 合法串 'a\'b'）：只读通道拒绝并提示改写；写通道不拦
  //（两种读法都没有破坏性动词）。
  const benign = "SELECT 'a\\'b'";
  const benignGate = assessReadOnlySql(benign);
  assert.equal(benignGate.ok, false, "歧义 SQL 读通道拒绝");
  assert.match(benignGate.reason, /''/, "拒绝理由须提示 '' 引号转义改写");
  assert.equal(assessSqlStatement(benign).blocked, false, "无破坏性动词的歧义 SQL 写通道放行");
  // 反斜杠不在引号前（Windows 路径、LIKE \%）——两种读法一致，行为照旧。
  const plain = "SELECT 'C:\\path\\file' FROM t";
  assert.equal(assessReadOnlySql(plain).ok, true, "引号前的反斜杠才歧义");
  assert.equal(assessReadOnlySql(plain).verbs.length, 1);
  // PG E'' 串在两种读法下都精确（独立 e/E 标识符紧邻引号即施转义），
  // 合法 E 串不得被歧义拒绝。
  const eExact = "SELECT E'a\\'; DROP' FROM t";
  assert.equal(assessReadOnlySql(eExact).ok, true, `E 串不算歧义：${assessReadOnlySql(eExact).reason ?? ""}`);
  assert.equal(assessReadOnlySql(eExact).verbs.length, 1);
  assert.equal(assessSqlStatement(eExact).blocked, false);
  // 方言歧义的破坏性 SQL 不得进隔离改名流程：目标解析返回 null → 硬拦。
  assert.equal(parseDestructiveTarget(pgMiss), null, "歧义破坏性 SQL 不解析隔离目标");
  // 审查补遗：PG "引号标识符"里的 \ 不转义；长标识符尾部 E 不是 E'' 前缀。
  assert.equal(assessSqlStatement('SELECT "a\\"; DROP TABLE t; --"').blocked, true, "PG 引号标识符的 \\\" 不得藏住 DROP");
  assert.equal(assessSqlStatement("SELECT freqE'x\\'; DROP TABLE t'").blocked, true, "标识符尾部 E 走普通串路径");
  // MySQL 习惯写法（VALUES 里的 \'）在写通道不受影响。
  assert.equal(assessSqlStatement("INSERT INTO logs VALUES ('can\\'t stop')").blocked, false, "写通道良性 \\' 放行");
}

// 6) PG dollar 引用（$$…$$ / $tag$…$tag$，对抗复核发现的漏检）：PG 空参数走
//    simple-query 协议、多语句真会执行，而 $…$ 里的引号分号都是字面量；
//    MySQL/SQLite/ClickHouse 无此语法且本插件通道不支持多语句执行。
{
  // 漏检现场：PG 把 $$'$$ 读成字符串 '，其后的 DROP 是活语句。
  const dollarMiss = "SELECT $$'$$; DROP TABLE t";
  assert.equal(assessSqlStatement(dollarMiss).blocked, true, "dollar 串不得藏住 DROP");
  assert.equal(assessSqlStatement(dollarMiss).verb, "DROP");
  assert.equal(assessReadOnlySql(dollarMiss).ok, false, "读门禁必须看到第二条 DROP");
  const taggedMiss = "SELECT $q$'; TRUNCATE TABLE t $q$; DROP TABLE u";
  assert.equal(assessSqlStatement(taggedMiss).blocked, true, "带 tag 的 dollar 串同理");
  assert.deepEqual(assessReadOnlySql(taggedMiss).verbs, ["SELECT", "DROP"]);
  // 合法 dollar 串：内容里的分号、引号、破坏性字样都是字面量。
  const legit = "SELECT $$a'; DROP$$ AS x";
  assert.equal(assessSqlStatement(legit).blocked, false, "dollar 字面量不误拦");
  assert.equal(assessReadOnlySql(legit).ok, true);
  assert.equal(assessReadOnlySql(legit).verbs.length, 1);
  // $1 位置参数不是 dollar 开引号（tag 不能以数字开头）。
  assert.equal(assessReadOnlySql("SELECT * FROM t WHERE id = $1").ok, true, "$1 不误认");
  // 未闭合 dollar 串：吞到结尾无活语句；PG 同样按未终止字符串报错，不执行。
  assert.equal(assessSqlStatement("SELECT $q$; DROP TABLE t").blocked, false, "未闭合 dollar 串内 DROP 不拦");
}

console.log("db-safety dialect probes: COMMENT-ON/nested-comment/q-quote/E-string/backslash cases passed");
