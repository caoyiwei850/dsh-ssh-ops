/**
 * DbOpsManager: in-memory database connection manager for the sshOps service.
 * Supports MySQL, PostgreSQL, Redis, MongoDB. Optional SSH tunnel reuses an
 * existing ssh2 connection (forwardOut + net.createServer) so agents can reach
 * databases on private networks. High-risk SQL (DROP DATABASE/SCHEMA/TABLE,
 * TRUNCATE, SHUTDOWN) is blocked on db_execute via db-safety.js.
 */
import net from "node:net";
import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise.js";
import pg from "pg";
import { createClient as createRedisClient } from "redis";
import { MongoClient } from "mongodb";
import pgCursorModule from "pg-cursor";
import { assessSqlStatement, assessReadOnlySql } from "./db-safety.js";
// The db layer wraps every failure straight into the full result envelope.
import { failResult as fail } from "./envelope.js";

const Cursor = pgCursorModule.default ?? pgCursorModule;

const MAX_DB_ROWS = 200;
const DB_QUERY_TIMEOUT_MS = 30000;
/** Idle transactions are rolled back and released after this long. */
const DB_TX_IDLE_MS = 5 * 60 * 1000;

// ── SSL option mappers (pure, unit-tested) ──────────────────────────────────

/** mysql2: undefined omits ssl; preferred/verify set rejectUnauthorized. */
export function buildMysqlSsl(ssl) {
  if (!ssl || ssl === "disabled") return undefined;
  return { rejectUnauthorized: ssl === "verify" };
}

/** pg: false disables ssl; object enables it. */
export function buildPgSsl(ssl) {
  if (!ssl || ssl === "disabled") return false;
  return { rejectUnauthorized: ssl === "verify" };
}

/** redis v4: socket options with tls flag. */
export function buildRedisSocket(ssl, host, port) {
  const socket = { host, port };
  if (ssl && ssl !== "disabled") {
    socket.tls = true;
    socket.rejectUnauthorized = ssl === "verify";
  }
  return socket;
}

/** mongodb: tls flags. preferred allows self-signed certs. */
export function buildMongoOptions(ssl) {
  if (!ssl || ssl === "disabled") return {};
  return { tls: true, tlsAllowInvalidCertificates: ssl === "preferred" };
}

// ── SSH tunnel routing for db_connect (pure, unit-tested) ──────────────────

const LOOPBACK_RE = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|::1)$/i;

/** True when host is a loopback address, i.e. "this machine" from the caller. */
export function isLoopbackHost(host) {
  return LOOPBACK_RE.test(String(host ?? ""));
}

/**
 * Decide which SSH connection (if any) a db_connect request should tunnel
 * through, so the agent can reach databases on the already-connected server
 * without knowing its internal connection id.
 *
 * - explicit sshConnectionId always wins;
 * - viaSsh "no" forces a direct connection;
 * - viaSsh "yes" forces the current active SSH connection (errors if none);
 * - viaSsh "auto" (default) tunnels only loopback hosts through the active
 *   connection, leaving public/private addresses as direct connections.
 */
export function pickSshConnectionId({ sshConnectionId, viaSsh, host, resolveActive }) {
  if (sshConnectionId !== undefined) return { sshConnectionId };
  const mode = viaSsh ?? "auto";
  if (mode === "no") return { sshConnectionId: undefined };
  const resolved = resolveActive();
  if (!resolved.ok) {
    if (mode === "yes") return { error: resolved.error };
    return { sshConnectionId: undefined };
  }
  if (mode === "yes" || isLoopbackHost(host)) {
    return { sshConnectionId: resolved.connectionId };
  }
  return { sshConnectionId: undefined };
}

// ── identifier validation + paginated preview SQL (pure, unit-tested) ───────

const DB_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)?$/;

/**
 * Validate a single, optionally schema-qualified identifier (table name). This
 * is the injection gate for every query that must embed a caller-supplied
 * identifier: reject anything that is not a plain word (or word.word) — values
 * themselves are ALWAYS bound through driver placeholders, never interpolated.
 */
export function validateDbIdentifier(name) {
  if (typeof name !== "string" || name.length > 128 || !DB_IDENTIFIER_RE.test(name)) return { ok: false };
  return { ok: true };
}

/** Quote a validated pg identifier: each dot-part double-quoted, quotes doubled. */
export function quotePgIdentifier(name) {
  return name.split(".").map((part) => `"${part.replace(/"/g, '""')}"`).join(".");
}

/**
 * Build `SELECT * FROM <table> LIMIT ? OFFSET ?` with the identifier either
 * passed through mysql2's `??` escaping (mysql) or quoted above (pg), and
 * limit/offset always bound as values.
 */
export function buildPreviewSql(dialect, table, limit, offset) {
  if (!validateDbIdentifier(table).ok) return { ok: false, error: `illegal table name: ${String(table)}` };
  if (dialect === "mysql") {
    return { ok: true, sql: "SELECT * FROM ?? LIMIT ? OFFSET ?", params: [table, limit, offset] };
  }
  return { ok: true, sql: `SELECT * FROM ${quotePgIdentifier(table)} LIMIT $1 OFFSET $2`, params: [limit, offset] };
}

// ── value serialization (MongoDB ObjectId/Decimal/Date, Buffer, bigint) ─────

function serializeDbValue(value) {
  return JSON.parse(JSON.stringify(value, (_key, val) => {
    if (val === undefined) return null;
    if (typeof val === "bigint") return val.toString();
    if (Buffer.isBuffer(val)) return val.toString("utf8");
    if (val && typeof val === "object") {
      if (typeof val.toISOString === "function" && val instanceof Date) return val.toISOString();
      if (typeof val.toHexString === "function") return val.toHexString();
      if (typeof val.toString === "function" && val.constructor?.name === "Decimal128") return val.toString();
    }
    return val;
  }));
}

// ── DbOpsManager ────────────────────────────────────────────────────────────

export class DbOpsManager {
  /** @param {import("./index.js").default} sshOpsService */
  constructor(sshOpsService) {
    this.sshOpsService = sshOpsService;
    this.dbConnections = new Map();
    /** txId -> interactive transaction { txId, dbId, kind, handle, timer, createdAt } */
    this.dbTransactions = new Map();
  }

  /**
   * Open a local TCP listener that forwards each accepted socket through an
   * existing ssh2 connection to dbHost:dbPort. Returns { server, port }.
   */
  async createTunnel(sshConnectionId, dbHost, dbPort) {
    const conn = this.sshOpsService.connections.get(sshConnectionId);
    if (!conn) throw new Error(`SSH connection ${sshConnectionId} not found`);
    if (conn.dead) throw new Error(`SSH connection ${sshConnectionId} is dead`);
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        conn.client.forwardOut("127.0.0.1", 0, dbHost, dbPort, (error, stream) => {
          if (error) { socket.destroy(); return; }
          stream.on("error", () => socket.destroy());
          socket.on("error", () => stream.destroy());
          socket.pipe(stream);
          stream.pipe(socket);
        });
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        // Post-listen errors (EMFILE on accept storms etc.) must still land on
        // a listener: an 'error' with zero listeners crashes the DSH process.
        server.on("error", () => {});
        const { port } = server.address();
        resolve({ server, port });
      });
    });
  }

  async connect(request) {
    const { type, host, port, database, username, password, ssl, sshConnectionId, name } = request;
    let tunnel = null;
    let connectHost = host;
    let connectPort = port;

    if (sshConnectionId) {
      try {
        tunnel = await this.createTunnel(sshConnectionId, host, port);
        connectHost = "127.0.0.1";
        connectPort = tunnel.port;
      } catch (error) {
        return fail("db-tunnel-failed", `SSH tunnel to ${host}:${port} via ${sshConnectionId}: ${error.message}`);
      }
    }

    const id = `db-${randomUUID().slice(0, 8)}`;
    let client;
    try {
      if (type === "mysql") {
        client = mysql.createPool({
          host: connectHost, port: connectPort, user: username, password, database,
          ssl: buildMysqlSsl(ssl), connectionLimit: 4, supportBigNumbers: true
        });
        const c = await client.getConnection();
        c.release();
      } else if (type === "postgresql") {
        client = new pg.Pool({
          host: connectHost, port: connectPort, user: username, password, database,
          ssl: buildPgSsl(ssl), max: 4
        });
        const c = await client.connect();
        c.release();
      } else if (type === "redis") {
        client = createRedisClient({
          socket: buildRedisSocket(ssl, connectHost, connectPort),
          password,
          database: database ? Number(database) : undefined
        });
        await client.connect();
      } else if (type === "mongodb") {
        const cred = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password ?? "")}@` : "";
        const uri = `mongodb://${cred}${connectHost}:${connectPort}/${database ?? ""}`;
        client = new MongoClient(uri, buildMongoOptions(ssl));
        await client.connect();
      } else {
        throw new Error(`unsupported database type: ${type}`);
      }
    } catch (error) {
      // node-redis retries forever on its own; a half-opened client from a
      // failed connect must be disconnected or it spins on a dead target.
      if (type === "redis" && client && typeof client.disconnect === "function") {
        try { client.disconnect(); } catch {}
      }
      if (tunnel) { try { tunnel.server.close(); } catch {} }
      const target = tunnel ? `${connectHost}:${connectPort} (tunneled to ${host}:${port})` : `${connectHost}:${connectPort}`;
      return fail("db-connect-failed", `${type} connect to ${target}: ${error.message}`);
    }

    const record = {
      id, type, name: name ?? `${type}:${host}:${port}`,
      config: { host, port, database, username, ssl: ssl ?? "disabled", sshConnectionId: sshConnectionId ?? null },
      client, tunnel, createdAt: new Date().toISOString()
    };
    this.dbConnections.set(id, record);
    this.attachDbTransportHandlers(record);
    return { ok: true, value: { dbConnectionId: id, name: record.name, type } };
  }

  /**
   * Wire transport-loss handling onto a DB client so an unexpected socket
   * drop (idle NAT, SSH-tunnel reset, server restart) can never surface as an
   * unhandled 'error' that crashes the whole web process. The dead record is
   * removed from the map (and its tunnel closed); a later db_run / db_query on
   * the same id then fails loudly with "not found" so the agent reconnects.
   */
  attachDbTransportHandlers(record) {
    const { id, client } = record;
    if (!client || typeof client.on !== "function") return;
    const onLoss = (error) => this.handleDbTransportLoss(id, client, error);
    // node-redis v4 never re-emits 'close' on the client; its socket drop
    // surfaces as 'error' (RedisSocket converts close into an error emit),
    // and it then AUTO-RECONNECTS unless disconnected — see handleDbTransportLoss.
    client.on("error", onLoss);
  }

  handleDbTransportLoss(id, client, error) {
    const record = this.dbConnections.get(id);
    if (!record || record.client !== client || record.dead) return;
    record.dead = true;
    this.dbConnections.delete(id);
    this.dropTransactionsFor(id);
    if (record.tunnel) { try { record.tunnel.server.close(); } catch {} }
    // Only node-redis reconnects on its own; with the tunnel already closed it
    // would retry a dead local port forever, so stop its retry loop for good.
    if (record.type === "redis" && typeof client.disconnect === "function") {
      try { client.disconnect(); } catch {}
    }
    const target = `${record.config.host}:${record.config.port}`;
    this.warn(`database connection ${id} (${record.type} ${target}) dropped: ${error?.message ?? error}`);
  }

  warn(...args) {
    try { this.sshOpsService?.ctx?.logger?.warn?.(...args); } catch {}
    // ctx.logger is not wired in the DSH host; console output is what reaches
    // ~/.dsh/web.log, so a transport loss must not stay fully silent there.
    try { console.warn("[dsh-ssh-ops] db transport lost:", ...args); } catch {}
  }

  getRecord(dbConnectionId) {
    const record = this.dbConnections.get(dbConnectionId);
    if (!record) throw new Error(`database connection ${dbConnectionId} not found`);
    return record;
  }

  async disconnect(request) {
    const record = this.dbConnections.get(request.dbConnectionId);
    if (!record) return fail("no-db-connection", `database connection ${request.dbConnectionId} not found`);
    // Open transactions must be rolled back while the pool is still alive.
    await this.disposeDbTransactionsFor(request.dbConnectionId);
    this.dbConnections.delete(request.dbConnectionId);
    try {
      if (record.type === "mysql" || record.type === "postgresql") await record.client.end();
      else if (record.type === "redis") await record.client.quit();
      else if (record.type === "mongodb") await record.client.close();
    } catch {}
    if (record.tunnel) { try { record.tunnel.server.close(); } catch {} }
    return { ok: true, value: { dbConnectionId: request.dbConnectionId, disconnected: true } };
  }

  /** Close every database connection (called from sshOps cleanup/disconnect). */
  async closeAll() {
    const ids = [...this.dbConnections.keys()];
    for (const id of ids) {
      await this.disconnect({ dbConnectionId: id }).catch(() => {});
    }
  }

  list() {
    const connections = [...this.dbConnections.values()].map((r) => ({
      dbConnectionId: r.id, name: r.name, type: r.type,
      host: r.config.host, port: r.config.port,
      database: r.config.database ?? null,
      username: r.config.username ?? null,
      ssl: r.config.ssl, sshConnectionId: r.config.sshConnectionId ?? null,
      createdAt: r.createdAt
    }));
    return { ok: true, value: { connections } };
  }

  async query(request) {
    let record;
    try { record = this.getRecord(request.dbConnectionId); }
    catch (error) { return fail("no-db-connection", error.message); }
    if (record.type !== "mysql" && record.type !== "postgresql") {
      return fail("unsupported-op", `db_query only supports mysql/postgresql, use db_run for ${record.type}`);
    }
    // The query channel is lexically read-only, not just by convention: the
    // caller-supplied statement text is gated here before any driver sees it,
    // and its values are always bound as driver placeholders (never strings
    // interpolated into SQL).
    const gate = assessReadOnlySql(request.sql);
    if (!gate.ok) return fail("readonly-sql", gate.reason);
    const sqlText = request.sql;
    const values = request.params ?? [];
    try {
      const paged = record.type === "mysql"
        ? await this.mysqlQueryPaged(record, sqlText, values)
        : await this.pgQueryPaged(record, sqlText, values);
      const columns = paged.fieldNames.length > 0 ? paged.fieldNames : (paged.rows[0] ? Object.keys(paged.rows[0]) : []);
      return {
        ok: true,
        value: { columns, rows: paged.rows.map(serializeDbValue), rowCount: paged.rows.length, truncated: paged.truncated }
      };
    } catch (error) {
      return fail("db-query-failed", error.message);
    }
  }

  /**
   * Stream a MySQL query row by row and stop as soon as one row past the cap
   * arrives, so a huge table never reaches memory in full. Uses a dedicated
   * pooled connection: the per-query `timeout` aborts long-running statements,
   * and an early stop destroys the connection (its protocol state is not
   * reusable after a mid-stream abort).
   */
  async mysqlQueryPaged(record, sqlText, values) {
    const conn = await record.client.getConnection();
    const rows = [];
    let fieldNames = [];
    let truncated = false;
    let settled = false;
    let killed = false;
    try {
      await new Promise((resolve, reject) => {
        const once = (fn) => {
          if (settled) return;
          settled = true;
          fn();
        };
        const stream = conn.connection
          .query({ sql: sqlText, values, timeout: DB_QUERY_TIMEOUT_MS })
          .stream();
        stream.on("fields", (fields) => {
          if (fields?.length) fieldNames = fields.map((f) => f.name);
        });
        stream.on("result", (row) => {
          if (rows.length >= MAX_DB_ROWS) {
            truncated = true;
            killed = true;
            once(resolve);
            try { stream.destroy(); } catch {}
            return;
          }
          rows.push(row);
        });
        stream.on("error", (err) => {
          // A timed-out (PROTOCOL_SEQUENCE_TIMEOUT — mysql2 abandons the
          // in-flight command without touching the connection) or
          // protocol-fatal query leaves the connection mid-command, so it
          // must be destroyed, never released back to the pool. Ordinary
          // server errors (bad syntax etc.) end the command cleanly and the
          // connection stays reusable.
          if (err?.code === "PROTOCOL_SEQUENCE_TIMEOUT" || err?.fatal === true) killed = true;
          once(() => reject(err));
        });
        stream.on("end", () => once(resolve));
      });
    } finally {
      // Once destroyed the connection may be mid-protocol; never hand it back.
      if (killed) { try { conn.destroy(); } catch {} } else { conn.release(); }
    }
    return { rows, fieldNames, truncated };
  }

  /**
   * pg counterpart: a cursor portal fetches rows in batches and is closed just
   * past the cap. statement_timeout guards runaway statements on the checked
   * out client and is reset before release so pooled writes are unaffected.
   * The timeout itself is bound as a parameter via set_config (pg cannot
   * parameterize SET, and SQL must never be assembled by interpolation).
   */
  async pgQueryPaged(record, sqlText, values) {
    const client = await record.client.connect();
    const rows = [];
    let fieldNames = [];
    let truncated = false;
    try {
      await client.query("SELECT set_config('statement_timeout', $1, false)", [String(DB_QUERY_TIMEOUT_MS)]);
      const cursor = client.query(new Cursor(sqlText, values));
      try {
        await new Promise((resolve, reject) => {
          const readBatch = () => {
            cursor.read(MAX_DB_ROWS + 1 - rows.length, (err, batch) => {
              if (err) return reject(err);
              if (batch.length === 0) return resolve();
              rows.push(...batch);
              if (rows.length > MAX_DB_ROWS) {
                truncated = true;
                rows.length = MAX_DB_ROWS;
                return resolve();
              }
              readBatch();
            });
          };
          readBatch();
        });
      } finally {
        await cursor.close().catch(() => {});
      }
      const fields = cursor.rowDescription?.fields;
      if (fields?.length) fieldNames = fields.map((f) => f.name);
    } finally {
      try { await client.query("RESET statement_timeout"); } catch {}
      client.release();
    }
    return { rows, fieldNames, truncated };
  }

  async execute(request) {
    let record;
    try { record = this.getRecord(request.dbConnectionId); }
    catch (error) { return fail("no-db-connection", error.message); }
    const assessment = assessSqlStatement(request.sql);
    if (assessment.blocked) return fail("unsafe-sql", assessment.reason);
    if (record.type !== "mysql" && record.type !== "postgresql") {
      return fail("unsupported-op", `db_execute only supports mysql/postgresql, use db_run for ${record.type}`);
    }
    try {
      let affectedRows, insertId;
      if (record.type === "mysql") {
        const [r] = await record.client.query(request.sql, request.params ?? []);
        if (Array.isArray(r)) {
          affectedRows = r.length;
        } else {
          affectedRows = r.affectedRows ?? 0;
          if (r.insertId) insertId = r.insertId;
        }
      } else {
        const r = await record.client.query(request.sql, request.params ?? []);
        affectedRows = r.rowCount ?? r.rows?.length ?? 0;
      }
      const value = { affectedRows, truncated: false };
      if (insertId !== undefined) value.insertId = insertId;
      return { ok: true, value };
    } catch (error) {
      return fail("db-execute-failed", error.message);
    }
  }

  async listTables(request) {
    let record;
    try { record = this.getRecord(request.dbConnectionId); }
    catch (error) { return fail("no-db-connection", error.message); }
    if (record.type !== "mysql" && record.type !== "postgresql") {
      return fail("unsupported-op", `db_list_tables only supports mysql/postgresql, use db_run for ${record.type}`);
    }
    try {
      let rows;
      if (record.type === "mysql") {
        const [r] = await record.client.query("SHOW TABLES");
        rows = r;
      } else {
        const r = await record.client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name");
        rows = r.rows;
      }
      const tables = rows.map((row) => Object.values(row)[0]);
      return { ok: true, value: { tables } };
    } catch (error) {
      return fail("db-list-tables-failed", error.message);
    }
  }

  async describeTable(request) {
    let record;
    try { record = this.getRecord(request.dbConnectionId); }
    catch (error) { return fail("no-db-connection", error.message); }
    if (record.type !== "mysql" && record.type !== "postgresql") {
      return fail("unsupported-op", `db_describe_table only supports mysql/postgresql, use db_run for ${record.type}`);
    }
    // The identifier is the only caller-controlled token embedded in these
    // metadata queries; it must pass the whitelist and is quoted per dialect.
    if (!validateDbIdentifier(request.table).ok) {
      return fail("bad-request", `illegal table name: ${String(request.table)}`);
    }
    const bareTable = request.table.split(".").pop();
    try {
      let columns;
      let indexes = [];
      let foreignKeys = [];
      let ddl = null;
      let stats = null;
      if (record.type === "mysql") {
        const [r] = await record.client.query("SHOW COLUMNS FROM ??", [request.table]);
        columns = r.map((c) => ({
          name: c.Field, type: c.Type, nullable: c.Null === "YES",
          key: c.Key, default: c.Default, extra: c.Extra
        }));
        const [idxRows] = await record.client.query("SHOW INDEX FROM ??", [request.table]);
        const byName = new Map();
        for (const row of idxRows) {
          const entry = byName.get(row.Key_name) ?? { name: row.Key_name, unique: row.Non_unique === 0, columns: [], definition: null };
          entry.columns.push(row.Column_name);
          byName.set(row.Key_name, entry);
        }
        indexes = [...byName.values()];
        const [createRows] = await record.client.query("SHOW CREATE TABLE ??", [request.table]);
        ddl = createRows?.[0]?.["Create Table"] ?? createRows?.[0]?.["Create View"] ?? null;
        const [statRows] = await record.client.query(
          "SELECT TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
          [bareTable]
        );
        const s = statRows?.[0];
        if (s) {
          stats = {
            estimatedRows: s.TABLE_ROWS == null ? null : Number(s.TABLE_ROWS),
            dataBytes: s.DATA_LENGTH == null ? null : Number(s.DATA_LENGTH),
            indexBytes: s.INDEX_LENGTH == null ? null : Number(s.INDEX_LENGTH)
          };
        }
        const [fkRows] = await record.client.query(
          "SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL",
          [bareTable]
        );
        foreignKeys = fkRows.map((row) => ({
          name: row.CONSTRAINT_NAME, column: row.COLUMN_NAME,
          foreignTable: row.REFERENCED_TABLE_NAME, foreignColumn: row.REFERENCED_COLUMN_NAME
        }));
      } else {
        const r = await record.client.query(
          "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = $1 AND table_schema = current_schema() ORDER BY ordinal_position",
          [bareTable]
        );
        columns = r.rows.map((c) => ({
          name: c.column_name, type: c.data_type, nullable: c.is_nullable === "YES",
          default: c.column_default, extra: null
        }));
        const idx = await record.client.query(
          "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = $1 AND schemaname = current_schema() ORDER BY indexname",
          [bareTable]
        );
        indexes = idx.rows.map((row) => ({
          name: row.indexname, definition: row.indexdef,
          unique: /CREATE\s+UNIQUE/i.test(row.indexdef), columns: []
        }));
        const fks = await record.client.query(
          `SELECT kcu.column_name, kcu.constraint_name, ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
           FROM information_schema.key_column_usage kcu
           JOIN information_schema.table_constraints tc
             ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
           JOIN information_schema.constraint_column_usage ccu
             ON ccu.constraint_name = kcu.constraint_name AND ccu.table_schema = kcu.table_schema
           WHERE kcu.table_name = $1 AND kcu.table_schema = current_schema() AND tc.constraint_type = 'FOREIGN KEY'`,
          [bareTable]
        );
        foreignKeys = fks.rows.map((row) => ({
          name: row.constraint_name, column: row.column_name,
          foreignTable: row.foreign_table, foreignColumn: row.foreign_column
        }));
        const st = await record.client.query(
          "SELECT reltuples::bigint AS estimate, pg_total_relation_size(c.oid) AS total_bytes FROM pg_class c WHERE c.relname = $1",
          [bareTable]
        );
        const s = st.rows?.[0];
        if (s) {
          stats = {
            estimatedRows: s.estimate == null ? null : Number(s.estimate),
            dataBytes: s.total_bytes == null ? null : Number(s.total_bytes),
            indexBytes: null
          };
        }
      }
      return { ok: true, value: { table: request.table, columns, indexes, foreignKeys, ddl, stats } };
    } catch (error) {
      return fail("db-describe-failed", error.message);
    }
  }

  /**
   * Paginated table preview: `SELECT * FROM <table> LIMIT ? OFFSET ?` with the
   * identifier validated/quoted by buildPreviewSql and limit/offset bound as
   * values. estimatedTotal comes from planner statistics (information_schema /
   * pg_class), never from a COUNT(*) over the whole table.
   */
  async preview(request) {
    let record;
    try { record = this.getRecord(request.dbConnectionId); }
    catch (error) { return fail("no-db-connection", error.message); }
    if (record.type !== "mysql" && record.type !== "postgresql") {
      return fail("unsupported-op", `db_preview only supports mysql/postgresql, use db_run for ${record.type}`);
    }
    const limit = Math.max(1, Math.min(MAX_DB_ROWS, Math.floor(Number(request.limit) || 50)));
    const offset = Math.max(0, Math.floor(Number(request.offset) || 0));
    const built = buildPreviewSql(record.type, request.table, limit, offset);
    if (!built.ok) return fail("bad-request", built.error);
    const bareTable = request.table.split(".").pop();
    let estimatedTotal = null;
    try {
      if (record.type === "mysql") {
        const [r] = await record.client.query(
          "SELECT TABLE_ROWS AS est FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
          [bareTable]
        );
        estimatedTotal = r?.[0]?.est == null ? null : Number(r[0].est);
      } else {
        const r = await record.client.query("SELECT reltuples::bigint AS est FROM pg_class WHERE relname = $1", [bareTable]);
        estimatedTotal = r.rows?.[0]?.est == null ? null : Number(r.rows[0].est);
      }
      if (estimatedTotal != null && estimatedTotal < 0) estimatedTotal = null;
    } catch {}
    const result = await this.query({ dbConnectionId: request.dbConnectionId, sql: built.sql, params: built.params });
    if (!result.ok) return result;
    return { ok: true, value: { ...result.value, table: request.table, limit, offset, estimatedTotal } };
  }

  // ── interactive transactions (operator-verified change workflow) ───────────

  /**
   * Begin a transaction on a dedicated pooled connection so the agent can
   * execute, verify with SELECTs, and only then commit or roll back. An idle
   * transaction is rolled back automatically after DB_TX_IDLE_MS.
   */
  async dbTxBegin(request) {
    let record;
    try { record = this.getRecord(request.dbConnectionId); }
    catch (error) { return fail("no-db-connection", error.message); }
    if (record.type !== "mysql" && record.type !== "postgresql") {
      return fail("unsupported-op", "transactions only support mysql/postgresql");
    }
    const txId = `tx-${randomUUID().slice(0, 8)}`;
    let handle;
    if (record.type === "mysql") {
      const conn = await record.client.getConnection();
      await conn.query("START TRANSACTION");
      handle = { kind: "mysql", conn };
    } else {
      const client = await record.client.connect();
      await client.query("BEGIN");
      handle = { kind: "pg", client };
    }
    const tx = { txId, dbId: record.id, handle, createdAt: new Date().toISOString(), timer: null };
    this.dbTransactions.set(txId, tx);
    this.touchTransaction(tx);
    return { ok: true, value: { txId, dbConnectionId: record.id } };
  }

  touchTransaction(tx) {
    if (tx.timer) clearTimeout(tx.timer);
    tx.timer = setTimeout(() => {
      this.warn(`transaction ${tx.txId} idle for over ${DB_TX_IDLE_MS / 1000}s — rolling back automatically`);
      this.disposeTransaction(tx.txId, "ROLLBACK").catch(() => {});
    }, DB_TX_IDLE_MS);
  }

  /** Execute one statement inside the transaction (still gated for DROP/TRUNCATE/SHUTDOWN). */
  async dbTxExecute(request) {
    const tx = this.dbTransactions.get(request.txId);
    if (!tx) return fail("tx-missing", `transaction ${request.txId} not found or already finished`);
    const assessment = assessSqlStatement(request.sql);
    if (assessment.blocked) return fail("unsafe-sql", assessment.reason);
    const sqlText = request.sql;
    const values = request.params ?? [];
    try {
      let value;
      if (tx.handle.kind === "mysql") {
        const [r] = await tx.handle.conn.query(sqlText, values);
        if (Array.isArray(r)) {
          const truncated = r.length > MAX_DB_ROWS;
          const rows = truncated ? r.slice(0, MAX_DB_ROWS) : r;
          value = { affectedRows: 0, rowCount: rows.length, truncated, rows: rows.map(serializeDbValue) };
        } else {
          value = { affectedRows: r.affectedRows ?? 0, rowCount: 0, truncated: false, rows: [] };
          if (r.insertId) value.insertId = r.insertId;
        }
      } else {
        const r = await tx.handle.client.query(sqlText, values);
        const allRows = r.rows ?? [];
        const truncated = allRows.length > MAX_DB_ROWS;
        const rows = truncated ? allRows.slice(0, MAX_DB_ROWS) : allRows;
        value = { affectedRows: r.rowCount ?? allRows.length, rowCount: rows.length, truncated, rows: rows.map(serializeDbValue) };
      }
      this.touchTransaction(tx);
      return { ok: true, value };
    } catch (error) {
      return fail("db-tx-execute-failed", error.message);
    }
  }

  async dbTxCommit(request) {
    return await this.finishTransaction(request.txId, "COMMIT", "db-tx-commit-failed");
  }

  async dbTxRollback(request) {
    return await this.finishTransaction(request.txId, "ROLLBACK", "db-tx-rollback-failed");
  }

  async finishTransaction(txId, action, errorCode) {
    const tx = this.dbTransactions.get(txId);
    if (!tx) return fail("tx-missing", `transaction ${txId} not found or already finished`);
    try {
      if (tx.handle.kind === "mysql") {
        await tx.handle.conn.query(action);
        tx.handle.conn.release();
      } else {
        await tx.handle.client.query(action);
        tx.handle.client.release();
      }
      if (tx.timer) clearTimeout(tx.timer);
      this.dbTransactions.delete(txId);
      const value = { txId, finished: true };
      value[action === "COMMIT" ? "committed" : "rolledBack"] = true;
      return { ok: true, value };
    } catch (error) {
      this.dbTransactions.delete(txId);
      if (tx.timer) clearTimeout(tx.timer);
      try {
        if (tx.handle.kind === "mysql") tx.handle.conn.destroy();
        else tx.handle.client.release();
      } catch {}
      return fail(errorCode, error.message);
    }
  }

  /** Timer/transport-driven cleanup: rolls back and releases the connection. */
  async disposeTransaction(txId, action) {
    const tx = this.dbTransactions.get(txId);
    if (!tx) return;
    this.dbTransactions.delete(txId);
    if (tx.timer) clearTimeout(tx.timer);
    try {
      if (tx.handle.kind === "mysql") {
        await tx.handle.conn.query(action);
        tx.handle.conn.release();
      } else {
        await tx.handle.client.query(action);
        tx.handle.client.release();
      }
    } catch {
      try { if (tx.handle.kind === "mysql") tx.handle.conn.destroy(); else tx.handle.client.release(); } catch {}
    }
  }

  /** Roll back every transaction of a connection (used by explicit disconnect). */
  async disposeDbTransactionsFor(dbConnectionId) {
    const ids = [...this.dbTransactions.keys()].filter((id) => this.dbTransactions.get(id)?.dbId === dbConnectionId);
    for (const id of ids) {
      await this.disposeTransaction(id, "ROLLBACK").catch(() => {});
    }
  }

  /** Drop transaction bookkeeping without touching the (already dead) pool. */
  dropTransactionsFor(dbConnectionId) {
    if (!this.dbTransactions) return; // partially-constructed instances in unit tests
    for (const [txId, tx] of [...this.dbTransactions.entries()]) {
      if (tx.dbId === dbConnectionId) {
        if (tx.timer) clearTimeout(tx.timer);
        this.dbTransactions.delete(txId);
      }
    }
  }

  // ── performance diagnostics ─────────────────────────────────────────────────

  /**
   * EXPLAIN a caller-supplied SELECT/WITH query. The statement is gated by the
   * read-only lexer first; the EXPLAIN prefix is prepended as a plain string
   * (the only permitted leading verbs make it impossible to smuggle a write
   * past the gate) and values stay bound as driver placeholders.
   */
  async explain(request) {
    let record;
    try { record = this.getRecord(request.dbConnectionId); }
    catch (error) { return fail("no-db-connection", error.message); }
    if (record.type !== "mysql" && record.type !== "postgresql") {
      return fail("unsupported-op", "db_explain only supports mysql/postgresql");
    }
    const gate = assessReadOnlySql(request.sql);
    if (!gate.ok) return fail("readonly-sql", gate.reason);
    if (!gate.verbs?.length || !["SELECT", "WITH"].includes(gate.verbs[0])) {
      return fail("unsupported-op", "db_explain 仅支持 SELECT/WITH 查询计划");
    }
    const sqlText = request.sql;
    const values = request.params ?? [];
    try {
      let plan;
      if (record.type === "mysql") {
        const [r] = await record.client.query("EXPLAIN FORMAT=JSON " + sqlText, values);
        const raw = r?.[0]?.EXPLAIN ?? null;
        plan = typeof raw === "string" ? JSON.parse(raw) : raw;
      } else {
        const r = await record.client.query("EXPLAIN (FORMAT JSON) " + sqlText, values);
        const raw = r.rows?.[0]?.["QUERY PLAN"] ?? null;
        plan = typeof raw === "string" ? JSON.parse(raw) : raw;
      }
      return { ok: true, value: { plan: serializeDbValue(plan) } };
    } catch (error) {
      return fail("db-explain-failed", error.message);
    }
  }

  async run(request) {
    let record;
    try { record = this.getRecord(request.dbConnectionId); }
    catch (error) { return fail("no-db-connection", error.message); }
    try {
      if (record.type === "redis") {
        const { command, args } = request;
        if (!command) return fail("bad-request", "redis run requires { command, args }");
        const result = await record.client.sendCommand([command, ...(args ?? [])]);
        return { ok: true, value: { result: serializeDbValue(result) } };
      }
      if (record.type === "mongodb") {
        const { collection, operation, filter, document, update, options } = request;
        if (!collection || !operation) return fail("bad-request", "mongodb run requires { collection, operation }");
        const col = record.client.db(record.config.database).collection(collection);
        let result;
        switch (operation) {
          case "find": result = await col.find(filter ?? {}).limit(100).toArray(); break;
          case "findOne": result = await col.findOne(filter ?? {}); break;
          case "insertOne": result = await col.insertOne(document); break;
          case "updateOne": result = await col.updateOne(filter ?? {}, update, options); break;
          case "deleteOne": result = await col.deleteOne(filter ?? {}); break;
          case "countDocuments": result = await col.countDocuments(filter ?? {}); break;
          default: throw new Error(`unsupported mongo operation: ${operation}`);
        }
        return { ok: true, value: { result: serializeDbValue(result) } };
      }
      return fail("unsupported-op", `db_run only supports redis/mongodb, use db_query for ${record.type}`);
    } catch (error) {
      return fail("db-run-failed", error.message);
    }
  }
}
