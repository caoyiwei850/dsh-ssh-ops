import { t } from "./i18n/core.js";
/**
 * SQL safety assessment for db_execute. Database CRUD is far more frequent than
 * host-shell ops, so detection is statement-verb based rather than a substring
 * scan: keywords that merely appear inside string literals, comments, or
 * column names must NOT trip the guard (otherwise a logging INSERT that quotes
 * the word "TRUNCATE" would be falsely blocked). Destructive leading verbs are
 * DROP / TRUNCATE / SHUTDOWN, detected per statement across multi-statement
 * input so `SELECT 1; DROP TABLE x` is still caught. Recoverable writes
 * (INSERT/UPDATE/DELETE/CREATE/ALTER) are allowed; DELETE without WHERE remains
 * permitted because it is transactional and a common legitimate bulk operation.
 */

const DESTRUCTIVE_VERBS = new Set(["DROP", "TRUNCATE", "SHUTDOWN"]);

const WHITESPACE = new Set([" ", "\t", "\n", "\r", "\f", "\v"]);
const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

/**
 * Walk the SQL text and return the leading verb (uppercased) of every
 * top-level statement. Derived from scanTokens so the string/comment/quote
 * handling exists exactly once; a statement whose first bare word sits inside
 * a parenthesis yields no verb, matching the historical walker.
 */
function statementVerbs(sql) {
  return scanTokens(sql)
    .map((stmt) => (stmt.tokens[0] && stmt.tokens[0].depth === 0 ? stmt.tokens[0].word : null))
    .filter((verb) => verb !== null);
}

/**
 * @param {string} sql
 * @returns {{ blocked: boolean, reason?: string, verb?: string }}
 */
export function assessSqlStatement(sql) {
  if (typeof sql !== "string" || sql.trim() === "") return { blocked: false };
  for (const verb of statementVerbs(sql)) {
    if (DESTRUCTIVE_VERBS.has(verb)) {
      return { blocked: true, reason: t(`${verb} is irreversible or takes the database down`), verb };
    }
  }
  return { blocked: false };
}

// ── read-only gate for the query channel ─────────────────────────────────────

const READONLY_VERBS = new Set(["SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "WITH"]);

/**
 * Bare words that must never appear (outside strings, quoted identifiers and
 * comments) anywhere in a read-only statement. Covers statement verbs, the
 * data-modifying CTE bodies PostgreSQL allows (`WITH x AS (DELETE ...) SELECT`)
 * and write-adjacent keywords (INTO OUTFILE/@var, locking reads, session
 * control). Bare-word matching is safe because all of these are reserved
 * words: a real column named "update" or "delete" must be quoted and is then
 * skipped as an identifier literal.
 */
const WRITE_KEYWORDS = new Set([
  "INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE", "REPLACE",
  "CREATE", "ALTER", "DROP", "RENAME", "GRANT", "REVOKE",
  "CALL", "DO", "SET", "LOAD", "HANDLER", "INTO",
  "LOCK", "UNLOCK", "SHARE", "OPTIMIZE", "PURGE", "FLUSH", "RESET", "KILL", "SHUTDOWN",
  "PREPARE", "EXECUTE", "DEALLOCATE", "START", "STOP", "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT",
  "ANALYZE"
]);

/**
 * Walk the SQL collecting every bare word token per statement, with the paren
 * depth it appears at and whether it is immediately followed by "(" (call).
 * Strings, quoted identifiers and comments are skipped so keywords inside them
 * never produce tokens. Statements are split on top-level ";".
 */
function scanTokens(sql) {
  const statements = [];
  let current = null;
  const n = sql.length;
  let i = 0;
  let depth = 0;

  const closeStatement = () => {
    if (current && current.tokens.length > 0) statements.push(current);
    current = null;
    depth = 0;
  };

  while (i < n) {
    const ch = sql[i];
    if (WHITESPACE.has(ch)) { i++; continue; }
    if ((ch === "-" && sql[i + 1] === "-") || ch === "#") {
      i += ch === "#" ? 1 : 2;
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      // MySQL executable version comments: /*!50000 DROP TABLE x */ is sent to
      // the server verbatim and EXECUTED, so its content must be lexed as SQL,
      // never skipped as a comment. Plain comments and optimizer hints skip.
      if (sql[i + 2] === "!") {
        i += 3;
        while (i < n && sql[i] >= "0" && sql[i] <= "9") i++;
        continue;
      }
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      i++;
      while (i < n) {
        const c = sql[i];
        if (c === "\\") { i += 2; continue; }
        if (c === quote) {
          if (sql[i + 1] === quote) { i += 2; continue; }
          i++; break;
        }
        i++;
      }
      continue;
    }
    if (ch === ";") { closeStatement(); i++; continue; }
    if (ch === t("(")) { depth++; i++; continue; }
    if (ch === t(")")) { depth = Math.max(0, depth - 1); i++; continue; }
    // Punctuation the target parser needs to see: dots separate qualified
    // identifiers, commas separate multi-table drops. They are bare-word
    // no-ops for the keyword gates (never in READONLY/WRITE keyword sets).
    if (ch === "." || ch === ",") {
      if (!current) current = { tokens: [] };
      current.tokens.push({ word: ch, raw: ch, depth, isCall: false });
      i++;
      continue;
    }
    if (IDENT_START.test(ch)) {
      if (!current) current = { tokens: [] };
      let j = i;
      while (j < n && IDENT_PART.test(sql[j])) j++;
      let k = j;
      while (k < n && WHITESPACE.has(sql[k])) k++;
      const isCall = sql[k] === t("(");
      // `raw` keeps the original case: keyword matching uses `word`, but
      // identifier reconstruction (destructive-target parsing) must not
      // uppercase a table name on case-sensitive servers.
      current.tokens.push({ word: sql.slice(i, j).toUpperCase(), raw: sql.slice(i, j), depth, isCall });
      i = j;
      continue;
    }
    i++;
  }
  closeStatement();
  return statements;
}

/**
 * Lexical read-only gate for the query channel: every statement must start
 * with a read verb AND contain no write keyword as a bare word at any depth.
 * `SHOW CREATE TABLE` is allowed (the one legit bare CREATE), and REPLACE is
 * allowed when used as the string function `REPLACE(...)` (not as REPLACE INTO).
 *
 * @param {string} sql
 * @returns {{ ok: boolean, reason?: string, verbs?: string[] }}
 */
export function assessReadOnlySql(sql) {
  if (typeof sql !== "string" || sql.trim() === "") return { ok: true, verbs: [] };
  const statements = scanTokens(sql);
  const verbs = statements.map((stmt) => stmt.tokens[0].word);
  for (const stmt of statements) {
    const verb = stmt.tokens[0].word;
    if (!READONLY_VERBS.has(verb)) {
      return { ok: false, reason: t(`A read-only query may not start with “${verb}” (only SELECT/SHOW/DESCRIBE/EXPLAIN/WITH are allowed)`), verbs };
    }
    for (const token of stmt.tokens) {
      if (token.word === "CREATE" && verb === "SHOW") continue; // SHOW CREATE TABLE
      if (token.word === "REPLACE" && token.isCall) continue;   // REPLACE(str, a, b)
      if (WRITE_KEYWORDS.has(token.word)) {
        return { ok: false, reason: t(`A read-only query may not contain ${token.word}; to make changes use db_execute (high-risk ones go to human confirmation) or the database panel`), verbs };
      }
    }
  }
  return { ok: true, verbs };
}

// ── destructive-target parsing (backup / quarantine machinery) ───────────────

/** Suffix that marks a table as quarantined by the plugin rather than dropped. */
export const QUARANTINE_SUFFIX_RE = /_to_be_dropped_\d{8}(_\d+)?$/;

/**
 * Parse the first destructive statement of a multi-statement SQL text into its
 * target. Returns null when the destructive statement has no exploitable
 * target (SHUTDOWN, DROP PROCEDURE, quoted identifiers the lexer skips, …) —
 * the caller then keeps the plain blocked flow. Identifier reconstruction
 * keeps the original case (`raw` tokens) and joins schema-qualified parts.
 *
 * @returns {{ verb: string, kind: "table"|"database"|"schema"|null, identifier: string|null } | null}
 */
export function parseDestructiveTarget(sql) {
  if (typeof sql !== "string" || sql.trim() === "") return null;
  for (const stmt of scanTokens(sql)) {
    const tokens = stmt.tokens;
    if (tokens.length === 0 || tokens[0].depth !== 0) continue;
    const verb = tokens[0].word;
    if (!DESTRUCTIVE_VERBS.has(verb)) continue;
    if (verb === "SHUTDOWN") return { verb, kind: null, identifier: null };

    let i = 1;
    let kind;
    const kindWord = tokens[i]?.word;
    if (verb === "TRUNCATE") {
      // TRUNCATE [TABLE] <name> — the TABLE keyword is optional and the
      // target is always a table.
      kind = "table";
      if (kindWord === "TABLE") i++;
    } else if (kindWord === "TABLE") { kind = "table"; i++; }
    else if (kindWord === "DATABASE") { kind = "database"; i++; }
    else if (kindWord === "SCHEMA") { kind = "schema"; i++; }
    else return { verb, kind: null, identifier: null };

    if (tokens[i]?.word === "IF" && tokens[i + 1]?.word === "EXISTS") i += 2;

    // Rebuild a (possibly schema-qualified) identifier from word/dot tokens.
    // A comma (MySQL multi-table drop) or any following keyword ends it; the
    // statement is blocked either way, so a partial parse only narrows the
    // best-effort backup, never the guard.
    const parts = [];
    let expectPart = true;
    for (; i < tokens.length && tokens[i].depth === 0; i++) {
      const word = tokens[i].word;
      if (word === ".") {
        if (expectPart || parts.length === 0) break;
        parts.push(".");
        expectPart = true;
        continue;
      }
      if (word === ",") break;
      if (!expectPart) break;
      parts.push(tokens[i].raw);
      expectPart = false;
    }
    const identifier = parts.join("").replace(/\.$/, "");
    return { verb, kind, identifier: identifier.length > 0 ? identifier : null };
  }
  return null;
}
