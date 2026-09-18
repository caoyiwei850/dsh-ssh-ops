/**
 * Extra SQL drivers beyond the mysql2/pg pair: SQLite through the host
 * runtime's built-in `node:sqlite` and ClickHouse through its HTTP interface.
 * Both are deliberately dependency-free — the plugin ships no native module
 * for them, so the two drivers that ops actually reach for most (a local file
 * and an analytics server) stay one `await import` away.
 *
 * Connection records are opened lazily by DbOpsManager; this module owns only
 * the per-driver mechanics (open/close/query/execute/metadata) and the small
 * amount of type metadata the rest of the plugin shares.
 */

/** Default TCP port per database type; SQLite has none (it is a file). */
export const DB_TYPE_DEFAULTS = Object.freeze({
  mysql: 3306,
  postgresql: 5432,
  opengauss: 5432,
  clickhouse: 8123,
  redis: 6379,
  mongodb: 27017
});

/** The port a record falls back to when none was supplied. */
export function defaultDbPort(type) {
  return DB_TYPE_DEFAULTS[type] ?? 0;
}

/**
 * PostgreSQL wire-protocol family. openGauss speaks the same protocol and is
 * served by the pg driver; only the server-side defaults differ.
 */
export function isPgFamily(type) {
  return type === "postgresql" || type === "opengauss";
}

/** Types whose query channel accepts SQL (as opposed to Redis/Mongo commands). */
export function isSqlType(type) {
  return type === "mysql" || isPgFamily(type) || type === "sqlite" || type === "clickhouse";
}

/** Types that need a network host/port; SQLite is addressed by file path. */
export function needsNetwork(type) {
  return type !== "sqlite";
}

// ── SQLite (host runtime's node:sqlite) ──────────────────────────────────────

/**
 * Open a SQLite file. `database` carries the file path (the same field other
 * drivers use for the schema name), so profiles and the connect dialog need no
 * extra field for it.
 * @param database - absolute or relative path of the SQLite file.
 */
export async function openSqlite(database) {
  if (typeof database !== "string" || database.trim() === "") {
    throw new Error("SQLite 连接需要填写数据库文件路径（database 字段）");
  }
  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch (error) {
    throw new Error(`当前宿主的 Node.js 不提供内置 SQLite（node:sqlite）：${error.message}`);
  }
  const db = new sqlite.DatabaseSync(database, { enableForeignKeyConstraints: true });
  return db;
}

/** Column names for a prepared statement, preferring the statement's own metadata. */
function sqliteColumns(stmt, rows) {
  if (typeof stmt.columns === "function") {
    const columns = stmt.columns();
    if (Array.isArray(columns) && columns.length > 0) {
      return columns.map((column) => column.name ?? column.column ?? String(column));
    }
  }
  return rows.length > 0 ? Object.keys(rows[0]) : [];
}

/**
 * Run one read statement, capped like every other driver: at most `maxRows + 1`
 * rows are materialized so truncation is detectable without holding the whole
 * result.
 */
export function sqliteQuery(db, statement, bindings = [], maxRows = 200) {
  const stmt = db.prepare(statement);
  // node:sqlite hands back null-prototype objects; every other driver returns
  // plain ones, and downstream code mixes rows from both paths.
  const rows = stmt.all(...bindings).map((row) => ({ ...row }));
  const truncated = rows.length > maxRows;
  return {
    // Same shape as the mysql/pg paged results (fieldNames), so the shared
    // query/export consumers stay driver-agnostic.
    fieldNames: sqliteColumns(stmt, rows),
    rows: truncated ? rows.slice(0, maxRows) : rows,
    truncated
  };
}

/** Run one write statement; returns the driver's changes/lastInsertRowid. */
export function sqliteExecute(db, statement, bindings = []) {
  const stmt = db.prepare(statement);
  const result = stmt.run(...bindings);
  return { affectedRows: Number(result.changes ?? 0), insertId: result.lastInsertRowid ?? null };
}

/** Tables and views, hiding SQLite's internal `sqlite_%` names. */
export function sqliteListTables(db) {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all();
  return rows.map((row) => row.name);
}

/** PRAGMA-based column description mapped onto the shared DbColumn shape. */
export function sqliteDescribeTable(db, table) {
  // The identifier arrives from the caller; quote it as a SQLite literal name
  // (`"` doubled inside) and never interpolate anything else.
  const quoted = `"${String(table).replaceAll('"', '""')}"`;
  const rows = db.prepare(`PRAGMA table_info(${quoted})`).all().map((row) => ({ ...row }));
  return rows.map((row) => ({
    name: row.name,
    type: String(row.type ?? "").length > 0 ? String(row.type) : "ANY",
    nullable: Number(row.notnull ?? 0) === 0,
    key: Number(row.pk ?? 0) > 0 ? "PRI" : undefined,
    default: row.dflt_value ?? undefined,
    extra: null
  }));
}

// ── ClickHouse (HTTP interface) ──────────────────────────────────────────────

/** ClickHouse parameter type for one JS value (LIMIT/OFFSET need integers). */
function clickhouseParamType(value) {
  if (typeof value === "boolean") return "UInt8";
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value) ? (value < 0 ? "Int64" : "UInt64") : "Float64";
  }
  if (typeof value === "bigint") return "Int64";
  return "String";
}

/**
 * Split SQL on `?` placeholders that are actual placeholders: quotes
 * ('' strings, "" and `` identifiers), line comments and block comments are
 * skipped. ClickHouse has no binary protocol binding in this driver, so each
 * placeholder becomes a typed `{pN:Type}` parameter passed as
 * `param_pN=<value>` on the request URL — values never enter the statement
 * text, which keeps the no-interpolation rule the other drivers follow.
 */
export function translateClickHouseParams(statement, params) {
  const values = Array.isArray(params) ? params : [];
  let sql = "";
  let index = 0;
  let i = 0;
  const take = (count) => { sql += statement.slice(i, i + count); i += count; };
  const searchParams = [];
  while (i < statement.length) {
    const ch = statement[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      // Quoted literal / identifier: consume to its closing quote, honouring
      // the doubled-quote escape, and copy verbatim.
      const quote = ch;
      const start = i;
      take(1);
      while (i < statement.length) {
        if (statement[i] === "\\" && quote === "'") { take(2); continue; }
        if (statement[i] === quote) {
          take(1);
          if (statement[i] === quote) { take(1); continue; }
          break;
        }
        take(1);
      }
      void start;
    } else if (ch === "-" && statement[i + 1] === "-") {
      while (i < statement.length && statement[i] !== "\n") take(1);
    } else if (ch === "/" && statement[i + 1] === "*") {
      take(2);
      while (i < statement.length && !(statement[i] === "*" && statement[i + 1] === "/")) take(1);
      take(2);
    } else if (ch === "?") {
      if (index >= values.length) throw new Error("ClickHouse 参数个数多于 SQL 中的 ? 占位符");
      index += 1;
      const value = values[index - 1];
      sql += `{p${index}:${clickhouseParamType(value)}}`;
      searchParams.push([`param_p${index}`, value === null || value === undefined ? "" : String(value)]);
      i += 1;
    } else {
      take(1);
    }
  }
  if (index !== values.length) throw new Error(`ClickHouse 参数个数（${values.length}）与 SQL 占位符（${index}）不一致`);
  return { sql, searchParams };
}

/** Base URL and auth headers for one connection record. */
export function clickhouseEndpoint(record) {
  const { host, port, username, password, database, ssl } = record.config;
  const secure = ssl === "preferred" || ssl === "verify";
  const scheme = secure ? "https" : "http";
  return {
    url: `${scheme}://${host}:${port}/`,
    headers: {
      ...(username ? { "X-ClickHouse-User": username } : {}),
      ...(password ? { "X-ClickHouse-Key": password } : {}),
      ...(database ? { "X-ClickHouse-Database": database } : {})
    },
    secure
  };
}

/** Compose the registry error body ("Code: 62. DB::Exception: ...") into one line. */
function clickhouseError(status, body) {
  const text = String(body ?? "").trim();
  const match = text.match(/DB::Exception:\s*([^\n]+)/);
  return `ClickHouse HTTP ${status}: ${match ? match[1] : text.slice(0, 300)}`;
}

/**
 * One request against the HTTP interface.
 * @param record - the connection record (config carries host/port/auth/ssl).
 * @param statement - SQL already translated for placeholders.
 * @param options - { signal, searchParams, fetchImpl, body }.
 */
export async function clickhouseRequest(record, statement, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("当前宿主不提供 fetch，无法使用 ClickHouse HTTP 接口");
  const { url, headers } = clickhouseEndpoint(record);
  const search = new URLSearchParams(options.searchParams ?? []);
  const response = await fetchImpl(`${url}?${search.toString()}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
    body: options.body ?? statement,
    signal: options.signal
  });
  const text = await response.text();
  if (!response.ok) throw new Error(clickhouseError(response.status, text));
  return text;
}

/**
 * Read path: append `FORMAT JSONCompact`, bound the result with the
 * server-side row cap, and translate the compact payload back into the shared
 * { columns, rows, truncated } shape.
 */
export async function clickhouseQuery(record, statement, bindings = [], options = {}) {
  const maxRows = options.maxRows ?? 200;
  if (/\bFORMAT\s+\w+\s*$/i.test(statement.trim())) {
    throw new Error("请去掉语句末尾的 FORMAT 子句：导出格式由 db_query/db_export 自行指定");
  }
  const { sql, searchParams } = translateClickHouseParams(statement, bindings);
  const text = await clickhouseRequest(record, `${sql}\nFORMAT JSONCompact`, {
    signal: options.signal,
    fetchImpl: options.fetchImpl,
    searchParams: [
      ...searchParams,
      ["max_result_rows", String(maxRows + 1)],
      ["result_overflow_mode", "break"]
    ]
  });
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`ClickHouse 返回了非 JSON 结果：${text.slice(0, 200)}`);
  }
  const columns = (payload.meta ?? []).map((field) => field.name);
  const rows = (payload.data ?? []).map((tuple) => {
    const row = {};
    columns.forEach((name, index) => { row[name] = tuple[index]; });
    return row;
  });
  const truncated = rows.length > maxRows;
  return { fieldNames: columns, rows: truncated ? rows.slice(0, maxRows) : rows, truncated };
}

/** Write/DDL path: no FORMAT, no row cap; the server returns an empty body on success. */
export async function clickhouseExecute(record, statement, bindings = [], options = {}) {
  const { sql, searchParams } = translateClickHouseParams(statement, bindings);
  await clickhouseRequest(record, sql, { signal: options.signal, fetchImpl: options.fetchImpl, searchParams });
  return { affectedRows: 0, insertId: null };
}

/** Tables in the connection's current database. */
export async function clickhouseListTables(record, options = {}) {
  const text = await clickhouseRequest(record, "SHOW TABLES FORMAT JSONCompact", { signal: options.signal, fetchImpl: options.fetchImpl });
  const payload = JSON.parse(text);
  return (payload.data ?? []).map((tuple) => String(tuple[0]));
}

/** Column description through DESCRIBE TABLE. */
export async function clickhouseDescribeTable(record, table, options = {}) {
  const quoted = `\`${String(table).replaceAll("`", "``")}\``;
  const text = await clickhouseRequest(record, `DESCRIBE TABLE ${quoted} FORMAT JSONCompact`, { signal: options.signal, fetchImpl: options.fetchImpl });
  const payload = JSON.parse(text);
  const rows = (payload.data ?? []).map((tuple) => {
    const row = {};
    (payload.meta ?? []).forEach((field, index) => { row[field.name] = tuple[index]; });
    return row;
  });
  return rows.map((row) => ({
    name: row.name,
    type: String(row.type ?? ""),
    // DESCRIBE reports Nullable(T) wrapping; surface the wrapped nullability.
    nullable: /^Nullable\(/.test(String(row.type ?? "")),
    key: row.is_in_primary_key === 1 || row.is_in_primary_key === "1" ? "PRI" : undefined,
    default: row.default_expression ? String(row.default_expression) : undefined,
    extra: row.default_type ?? null
  }));
}

// ── CSV / JSON serialization (table export) ──────────────────────────────────

/** Delimiters the export dialog offers, mirroring the ones ops tools ship. */
export const EXPORT_DELIMITERS = Object.freeze({ comma: ",", tab: "\t", semicolon: ";", pipe: "|" });

/**
 * RFC 4180 CSV: fields containing the delimiter, a quote, CR or LF are quoted
 * with `"` doubled. A cell is rendered as its JSON-free string form so nulls
 * stay empty instead of reading "null".
 */
export function toCsv(columns, rows, { delimiter = ",", header = true } = {}) {
  const escape = (value) => {
    if (value === null || value === undefined) return "";
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    return /["\n\r\u2028\u2029]/.test(text) || text.includes(delimiter) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const lines = [];
  if (header) lines.push(columns.map(escape).join(delimiter));
  for (const row of rows) lines.push(columns.map((column) => escape(row[column])).join(delimiter));
  return `${lines.join("\r\n")}\r\n`;
}

/** JSON export: an array of row objects, pretty enough to diff. */
export function toJson(columns, rows) {
  const projected = rows.map((row) => {
    const item = {};
    for (const column of columns) item[column] = row[column] ?? null;
    return item;
  });
  return `${JSON.stringify(projected, null, 2)}\n`;
}
