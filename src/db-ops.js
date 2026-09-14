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

const DB_QUERY_TIMEOUT_MS = 30000;
/** Idle transactions are rolled back and released after this long. */
const DB_TX_IDLE_MS = 5 * 60 * 1000;

/**
 * Client-side ceilings for every driver await. A half-open transport (idle
 * NAT drop, network switch, server restart behind an SSH tunnel) produces
 * neither an error event nor data, so server-side guards like pg's
 * statement_timeout never fire — the SQL never reaches the server. Without
 * these ceilings the awaited driver promise simply never settles: the tool
 * call spins forever, GUI "stop" cannot interrupt it (cancellation can only
 * wait for the tool to settle), and checked-out pool slots (max 4) leak one
 * by one until every later db_query on the connection freezes. Every value
 * stays below the tools' timeoutMs budget so the agent sees the specific
 * message from here instead of a generic policy cancellation.
 */
export const DB_DEADLINES = Object.freeze({
  /** One statement round-trip (server statement_timeout is 30s, plus grace). */
  op: 35000,
  /** Acquiring a pooled connection (pg pool.connect / mysql getConnection). */
  checkout: 12000,
  /** Best-effort cleanup round-trips: RESET statement_timeout, cursor close. */
  reset: 2000,
  /** Whole db_connect handshake + validation checkout. */
  connect: 20000,
  /** Driver-level connect timeout (pg connectionTimeoutMillis, mysql connectTimeout). */
  poolConnection: 10000,
  /** Teardown: pool.end()/quit()/close() and transaction disposal. */
  end: 5000
});

/**
 * Race driver work against cancellation and a deadline. On a half-open
 * transport the driver promise never settles, so losing the race is the only
 * way out; `onLose` must destroy the underlying connection so the abandoned
 * work reaches quiescence and pool slots are reclaimed. Both handlers are
 * attached up front, so a late-settling driver promise can never surface as
 * an unhandled rejection.
 */
function raceDeadline(work, { signal, timeoutMs, label, onLose }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    const lose = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { onLose?.(error); } catch {}
      reject(error);
    };
    function onAbort() { lose(new Error(`${label} cancelled`)); }
    work.then(
      (value) => { if (settled) return; settled = true; cleanup(); resolve(value); },
      (error) => { if (settled) return; settled = true; cleanup(); reject(error); }
    );
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    if (Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => lose(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }
  });
}

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
  constructor(sshOpsService, maxDbRows = 200) {
    this.sshOpsService = sshOpsService;
    this.maxDbRows = maxDbRows;
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
    const signal = request.signal;
    let client;
    try {
      if (type === "mysql") {
        client = mysql.createPool({
          host: connectHost, port: connectPort, user: username, password, database,
          ssl: buildMysqlSsl(ssl), connectionLimit: 4, supportBigNumbers: true,
          connectTimeout: this.dl("poolConnection")
        });
        const c = await this.mysqlCheckout({ client }, { signal, label: "db_connect", timeoutMs: this.dl("connect") });
        c.release();
      } else if (type === "postgresql") {
        client = new pg.Pool({
          host: connectHost, port: connectPort, user: username, password, database,
          ssl: buildPgSsl(ssl), max: 4,
          // Without this pg-pool waits forever — both on new TCP connects and
          // on the waiter queue of an exhausted pool (the half-open state).
          connectionTimeoutMillis: this.dl("poolConnection")
        });
        const c = await this.pgCheckout({ client }, { signal, label: "db_connect", timeoutMs: this.dl("connect") });
        c.release();
      } else if (type === "redis") {
        client = createRedisClient({
          socket: { ...buildRedisSocket(ssl, connectHost, connectPort), connectTimeout: this.dl("poolConnection") },
          password,
          database: database ? Number(database) : undefined
        });
        await raceDeadline(client.connect(), {
          signal, timeoutMs: this.dl("connect"), label: "db_connect",
          onLose: () => { try { client.disconnect(); } catch {} }
        });
      } else if (type === "mongodb") {
        const cred = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password ?? "")}@` : "";
        const uri = `mongodb://${cred}${connectHost}:${connectPort}/${database ?? ""}`;
        client = new MongoClient(uri, {
          ...buildMongoOptions(ssl),
          serverSelectionTimeoutMS: this.dl("connect"),
          connectTimeoutMS: this.dl("poolConnection")
        });
        await raceDeadline(client.connect(), {
          signal, timeoutMs: this.dl("connect"), label: "db_connect",
          onLose: () => { try { client.close(true); } catch {} }
        });
      } else {
        throw new Error(`unsupported database type: ${type}`);
      }
    } catch (error) {
      // A half-created client must not keep sockets or retry loops alive:
      // node-redis retries forever on its own, and an abandoned pg/mysql pool
      // still holds connecting sockets. Teardown is best-effort fire-and-
      // forget — pool.end() on a dead transport may never settle, and the
      // failed connect must not wait for it.
      if (client) {
        try {
          if (type === "redis" && typeof client.disconnect === "function") client.disconnect();
          else if (type === "mongodb" && typeof client.close === "function") client.close(true).catch(() => {});
          else if (typeof client.end === "function") client.end()?.catch?.(() => {});
        } catch {}
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
    } else if (record.type === "mongodb" && typeof client.close === "function") {
      // Force-close: a graceful close() would wait on the dead transport.
      try { client.close(true).catch(() => {}); } catch {}
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

  // ── bounded driver primitives (half-open transport self-healing) ──────────

  /** Deadline lookup; `this.deadlines` is an instance override used by tests. */
  dl(key) {
    return this.deadlines?.[key] ?? DB_DEADLINES[key];
  }

  /**
   * pool.connect() with cancellation and a deadline. Without
   * connectionTimeoutMillis pg-pool queues waiters forever; a late-arriving
   * client after we gave up is destroyed on arrival (release(err)) so it can
   * neither leak a slot nor hand a suspect connection to the next caller.
   */
  async pgCheckout(record, { signal, label, timeoutMs } = {}) {
    const checkout = record.client.connect();
    try {
      return await raceDeadline(checkout, {
        signal, timeoutMs: timeoutMs ?? this.dl("checkout"), label: `${label} checkout`
      });
    } catch (error) {
      checkout.then(
        (client) => { try { client.release(error instanceof Error ? error : new Error(String(error))); } catch {} },
        () => {}
      );
      throw error;
    }
  }

  /**
   * mysql2 counterpart of pgCheckout; mysql2 pools have no acquire timeout.
   * Pools created before this change (and test doubles) may expose only
   * query(), which manages its own pooled connection internally — then there
   * is no slot to hand back and the statement itself is the unit of work.
   */
  async mysqlCheckout(record, { signal, label, timeoutMs } = {}) {
    if (typeof record.client.getConnection !== "function") {
      return { kind: "pool", pool: record.client, release() {}, destroy() {} };
    }
    const checkout = record.client.getConnection();
    try {
      return await raceDeadline(checkout, {
        signal, timeoutMs: timeoutMs ?? this.dl("checkout"), label: `${label} checkout`
      });
    } catch (error) {
      checkout.then(
        (conn) => { try { conn.destroy(); } catch {} },
        () => {}
      );
      throw error;
    }
  }

  /** One statement on a dedicated checked-out pg client; kill-safe. */
  async pgQueryOnce(record, sql, params, opts) {
    return this.pgWithClient(record, opts, (run) => run(sql, params));
  }

  /** One statement on a dedicated checked-out mysql connection; kill-safe. */
  async mysqlQueryOnce(record, sql, params, opts) {
    return this.mysqlWithConn(record, opts, (run) => run(sql, params));
  }

  /**
   * Run `fn(run)` against one checked-out pg client. Every statement is
   * raced; a lost race marks the client dead so it is released WITH an error
   * — pg-pool then removes it synchronously and its end() force-destroys the
   * socket of a hung query, returning the slot to the pool.
   */
  async pgWithClient(record, opts, fn) {
    const label = opts?.label ?? "db statement";
    const client = await this.pgCheckout(record, { signal: opts?.signal, label, timeoutMs: this.dl("checkout") });
    let dead = false;
    const run = (sql, params) => raceDeadline(client.query(sql, params), {
      signal: opts?.signal, timeoutMs: this.dl("op"), label, onLose: () => { dead = true; }
    });
    try {
      return await fn(run);
    } finally {
      if (dead) client.release(new Error(`${label}: connection killed after cancel/timeout`));
      else client.release();
    }
  }

  /**
   * mysql counterpart of pgWithClient. A pool-shaped handle (no
   * getConnection) issues the statement through pool.query(); pg has no such
   * shape because pg.Pool.query() checks out and releases internally, which
   * would bypass the kill path, so pg always goes through a checked-out client.
   */
  async mysqlWithConn(record, opts, fn) {
    const label = opts?.label ?? "db statement";
    const conn = await this.mysqlCheckout(record, { signal: opts?.signal, label, timeoutMs: this.dl("checkout") });
    const target = conn.kind === "pool" ? conn.pool : conn;
    let killed = false;
    const run = (sql, params) => raceDeadline(target.query(sql, params), {
      signal: opts?.signal, timeoutMs: this.dl("op"), label, onLose: () => { killed = true; }
    }).catch((error) => {
      // A timed-out or protocol-fatal command leaves the connection
      // mid-protocol; it must never go back to the pool (see mysqlQueryPaged).
      if (error?.code === "PROTOCOL_SEQUENCE_TIMEOUT" || error?.fatal === true) killed = true;
      throw error;
    });
    try {
      return await fn(run);
    } finally {
      if (killed) { try { conn.destroy(); } catch {} } else conn.release();
    }
  }

  async disconnect(request) {
    const record = this.dbConnections.get(request.dbConnectionId);
    if (!record) return fail("no-db-connection", `database connection ${request.dbConnectionId} not found`);
    // Open transactions must be rolled back while the pool is still alive —
    // but bounded: on a dead transport even the ROLLBACK round-trip hangs.
    await raceDeadline(this.disposeDbTransactionsFor(request.dbConnectionId), {
      timeoutMs: this.dl("end"), label: "db_disconnect tx cleanup"
    }).catch(() => {});
    this.dbConnections.delete(request.dbConnectionId);
    // The teardown itself is raced too: pool.end()/quit()/close() wait on the
    // transport, and the record must leave the manager even if it never dies.
    const teardown = (async () => {
      if (record.type === "mysql" || record.type === "postgresql") await record.client.end();
      else if (record.type === "redis") await record.client.quit();
      else if (record.type === "mongodb") await record.client.close();
    })();
    await raceDeadline(teardown, {
      signal: request.signal, timeoutMs: this.dl("end"), label: "db_disconnect",
      // A pool whose end() never returns keeps its half-open sockets (and, for
      // pg, its waiter queue) alive for the life of the process. Force-destroy
      // the checked-out clients; pg's pool.end() then completes on its own.
      onLose: () => this.forceClosePool(record)
    }).catch(() => {});
    if (record.tunnel) { try { record.tunnel.server.close(); } catch {} }
    return { ok: true, value: { dbConnectionId: request.dbConnectionId, disconnected: true } };
  }

  /**
   * Best-effort force teardown of a pool whose graceful end() hung on a dead
   * transport: destroy every checked-out and idle client so no socket survives
   * disconnect. Idempotent — clients already destroyed are skipped by the
   * driver, and a missing internal array (test doubles) is simply ignored.
   */
  forceClosePool(record) {
    const client = record.client;
    for (const bucket of ["_clients", "clients"]) {
      const list = client?.[bucket];
      if (!Array.isArray(list)) continue;
      for (const entry of [...list]) {
        try { entry?.connection?.stream?.destroy?.(); } catch {}
        try { entry?.end?.(); } catch {}
      }
    }
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
    try {
      const paged = await this.queryPaged(record, request);
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
   * Dialect dispatch for the read path. The statement already passed the
   * read-only lexical gate in query() and its values always travel as
   * driver-bound placeholders; the caller's cancellation signal rides along
   * so a half-open transport cannot pin the call forever.
   */
  queryPaged(record, request) {
    const opts = { signal: request.signal, label: "db_query" };
    const { sql: statement, params: bindings } = request;
    return record.type === "mysql"
      ? this.mysqlQueryPaged(record, statement, bindings ?? [], opts)
      : this.pgQueryPaged(record, statement, bindings ?? [], opts);
  }

  /**
   * Stream a MySQL query row by row and stop as soon as one row past the cap
   * arrives, so a huge table never reaches memory in full. Uses a dedicated
   * pooled connection: the per-query `timeout` aborts long-running statements,
   * and an early stop destroys the connection (its protocol state is not
   * reusable after a mid-stream abort). The stream additionally races the
   * caller's cancellation and the client-side op deadline: the per-query
   * timeout is itself a protocol timer, and a half-open socket never fires it.
   */
  async mysqlQueryPaged(record, statement, bindings, opts = {}) {
    const label = opts.label ?? "db_query";
    const conn = await this.mysqlCheckout(record, { signal: opts.signal, label });
    const rows = [];
    let fieldNames = [];
    let truncated = false;
    let settled = false;
    let killed = false;
    try {
      // Object form: mysql2 renders `statement` with `?` placeholders and
      // sends `bindings` through the protocol's separate parameter slot.
      const stream = conn.connection
        .query({ sql: statement, values: bindings, timeout: DB_QUERY_TIMEOUT_MS })
        .stream();
      const streamed = new Promise((resolve, reject) => {
        const once = (fn) => {
          if (settled) return;
          settled = true;
          fn();
        };
        stream.on("fields", (fields) => {
          if (fields?.length) fieldNames = fields.map((f) => f.name);
        });
        stream.on("result", (row) => {
          if (rows.length >= this.maxDbRows) {
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
      await raceDeadline(streamed, {
        signal: opts.signal, timeoutMs: this.dl("op"), label,
        onLose: () => { killed = true; try { stream.destroy(); } catch {} }
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
   *
   * Every await here is bounded: on a half-open transport (SSH tunnel silently
   * dead) the statement, the portal fetch AND the trailing reset all wait
   * forever, because none of those guards is client-side. Losing any race
   * marks the client dead so it is released WITH an error and pg-pool destroys
   * it — the alternative is leaking one pool slot (max 4) per hung query until
   * the whole connection is unusable.
   */
  async pgQueryPaged(record, statement, bindings, opts = {}) {
    const label = opts.label ?? "db_query";
    const client = await this.pgCheckout(record, { signal: opts.signal, label });
    const rows = [];
    let fieldNames = [];
    let truncated = false;
    let dead = false;
    const run = (text, params) => raceDeadline(client.query(text, params), {
      signal: opts.signal, timeoutMs: this.dl("op"), label, onLose: () => { dead = true; }
    });
    try {
      await run("SELECT set_config('statement_timeout', $1, false)", [String(DB_QUERY_TIMEOUT_MS)]);
      const cursor = client.query(new Cursor(statement, bindings));
      try {
        await raceDeadline(new Promise((resolve, reject) => {
          const readBatch = () => {
            cursor.read(this.maxDbRows + 1 - rows.length, (err, batch) => {
              if (err) { reject(err); return; }
              if (batch.length === 0) { resolve(); return; }
              rows.push(...batch);
              if (rows.length > this.maxDbRows) {
                truncated = true;
                rows.length = this.maxDbRows;
                resolve();
                return;
              }
              readBatch();
            });
          };
          readBatch();
        }), {
          signal: opts.signal, timeoutMs: this.dl("op"), label,
          // The portal is mid-fetch: the client must not return to the pool.
          onLose: () => { dead = true; }
        });
      } finally {
        // Closing the portal is best-effort; on a dead socket it never answers.
        await raceDeadline(cursor.close().catch(() => {}), {
          timeoutMs: this.dl("reset"), label: "db_query cursor close", onLose: () => { dead = true; }
        }).catch(() => {});
      }
      const fields = cursor.rowDescription?.fields;
      if (fields?.length) fieldNames = fields.map((f) => f.name);
    } finally {
      // Bounded by construction: a bare await here would hang forever on a
      // half-open transport, leaking this pool slot with it.
      await raceDeadline(client.query("RESET statement_timeout"), {
        timeoutMs: this.dl("reset"), label: "db_query reset", onLose: () => { dead = true; }
      }).catch(() => {});
      if (dead) client.release(new Error(`${label}: connection killed after cancel/timeout`));
      else client.release();
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
      const opts = { signal: request.signal, label: "db_execute" };
      let affectedRows, insertId;
      if (record.type === "mysql") {
        const r = await this.mysqlQueryOnce(record, request.sql, request.params ?? [], opts);
        const [rows] = r;
        if (Array.isArray(rows)) {
          affectedRows = rows.length;
        } else {
          affectedRows = rows.affectedRows ?? 0;
          if (rows.insertId) insertId = rows.insertId;
        }
      } else {
        const r = await this.pgQueryOnce(record, request.sql, request.params ?? [], opts);
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
      const opts = { signal: request.signal, label: "db_list_tables" };
      let tables;
      if (record.type === "mysql") {
        const [rows] = await this.mysqlQueryOnce(record, "SHOW TABLES", [], opts);
        tables = rows.map((row) => Object.values(row)[0]);
      } else {
        const r = await this.pgQueryOnce(record, "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name", [], opts);
        tables = r.rows.map((row) => Object.values(row)[0]);
      }
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
    // Every introspection statement runs on a dedicated, deadline-bounded
    // connection: metadata reads hang exactly like user queries when the
    // transport goes half-open.
    const opts = { signal: request.signal, label: "db_describe_table" };
    try {
      let columns;
      let indexes = [];
      let foreignKeys = [];
      let ddl = null;
      let stats = null;
      if (record.type === "mysql") {
        const [r] = await this.mysqlQueryOnce(record, "SHOW COLUMNS FROM ??", [request.table], opts);
        columns = r.map((c) => ({
          name: c.Field, type: c.Type, nullable: c.Null === "YES",
          key: c.Key, default: c.Default, extra: c.Extra
        }));
        const [idxRows] = await this.mysqlQueryOnce(record, "SHOW INDEX FROM ??", [request.table], opts);
        const byName = new Map();
        for (const row of idxRows) {
          const entry = byName.get(row.Key_name) ?? { name: row.Key_name, unique: row.Non_unique === 0, columns: [], definition: null };
          entry.columns.push(row.Column_name);
          byName.set(row.Key_name, entry);
        }
        indexes = [...byName.values()];
        const [createRows] = await this.mysqlQueryOnce(record, "SHOW CREATE TABLE ??", [request.table], opts);
        ddl = createRows?.[0]?.["Create Table"] ?? createRows?.[0]?.["Create View"] ?? null;
        const [statRows] = await this.mysqlQueryOnce(record,
          "SELECT TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
          [bareTable], opts
        );
        const s = statRows?.[0];
        if (s) {
          stats = {
            estimatedRows: s.TABLE_ROWS == null ? null : Number(s.TABLE_ROWS),
            dataBytes: s.DATA_LENGTH == null ? null : Number(s.DATA_LENGTH),
            indexBytes: s.INDEX_LENGTH == null ? null : Number(s.INDEX_LENGTH)
          };
        }
        const [fkRows] = await this.mysqlQueryOnce(record,
          "SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL",
          [bareTable], opts
        );
        foreignKeys = fkRows.map((row) => ({
          name: row.CONSTRAINT_NAME, column: row.COLUMN_NAME,
          foreignTable: row.REFERENCED_TABLE_NAME, foreignColumn: row.REFERENCED_COLUMN_NAME
        }));
      } else {
        const r = await this.pgQueryOnce(record,
          "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = $1 AND table_schema = current_schema() ORDER BY ordinal_position",
          [bareTable], opts
        );
        columns = r.rows.map((c) => ({
          name: c.column_name, type: c.data_type, nullable: c.is_nullable === "YES",
          default: c.column_default, extra: null
        }));
        const idx = await this.pgQueryOnce(record,
          "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = $1 AND schemaname = current_schema() ORDER BY indexname",
          [bareTable], opts
        );
        indexes = idx.rows.map((row) => ({
          name: row.indexname, definition: row.indexdef,
          unique: /CREATE\s+UNIQUE/i.test(row.indexdef), columns: []
        }));
        const fks = await this.pgQueryOnce(record,
          `SELECT kcu.column_name, kcu.constraint_name, ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
           FROM information_schema.key_column_usage kcu
           JOIN information_schema.table_constraints tc
             ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
           JOIN information_schema.constraint_column_usage ccu
             ON ccu.constraint_name = kcu.constraint_name AND ccu.table_schema = kcu.table_schema
           WHERE kcu.table_name = $1 AND kcu.table_schema = current_schema() AND tc.constraint_type = 'FOREIGN KEY'`,
          [bareTable], opts
        );
        foreignKeys = fks.rows.map((row) => ({
          name: row.constraint_name, column: row.column_name,
          foreignTable: row.foreign_table, foreignColumn: row.foreign_column
        }));
        const st = await this.pgQueryOnce(record,
          "SELECT reltuples::bigint AS estimate, pg_total_relation_size(c.oid) AS total_bytes FROM pg_class c WHERE c.relname = $1",
          [bareTable], opts
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
    const requestedLimit = Math.floor(Number(request.limit) || 50);
    if (requestedLimit > this.maxDbRows) return fail("db-limit-too-high", `requested limit ${requestedLimit} exceeds configured max ${this.maxDbRows}`);
    const limit = Math.max(1, requestedLimit);
    const offset = Math.max(0, Math.floor(Number(request.offset) || 0));
    const built = buildPreviewSql(record.type, request.table, limit, offset);
    if (!built.ok) return fail("bad-request", built.error);
    const bareTable = request.table.split(".").pop();
    let estimatedTotal = null;
    const opts = { signal: request.signal, label: "db_preview estimate" };
    try {
      if (record.type === "mysql") {
        const [statsRows] = await this.mysqlQueryOnce(record,
          "SELECT TABLE_ROWS AS est FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
          [bareTable], opts
        );
        estimatedTotal = statsRows?.[0]?.est == null ? null : Number(statsRows[0].est);
      } else {
        const estimate = await this.pgQueryOnce(record, "SELECT reltuples::bigint AS est FROM pg_class WHERE relname = $1", [bareTable], opts);
        estimatedTotal = estimate.rows?.[0]?.est == null ? null : Number(estimate.rows[0].est);
      }
      if (estimatedTotal != null && estimatedTotal < 0) estimatedTotal = null;
    } catch (error) {
      // The estimate is decoration; the rows are the answer. Cancellation is
      // the one exception - the caller asked us to stop, so stop.
      if (request.signal?.aborted) return fail("db-query-cancelled", `db_preview cancelled: ${error.message}`);
    }
    const result = await this.query({ dbConnectionId: request.dbConnectionId, sql: built.sql, params: built.params, signal: request.signal });
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
    const signal = request.signal;
    let handle;
    try {
      if (record.type === "mysql") {
        const conn = await this.mysqlCheckout(record, { signal, label: "db_tx_begin" });
        let lost = false;
        try {
          await raceDeadline(conn.query("START TRANSACTION"), {
            signal, timeoutMs: this.dl("op"), label: "db_tx_begin",
            onLose: () => { lost = true; try { conn.destroy(); } catch {} }
          });
        } catch (error) {
          if (!lost) { try { conn.destroy(); } catch {} }
          throw error;
        }
        handle = { kind: "mysql", conn, signal };
      } else {
        const client = await this.pgCheckout(record, { signal, label: "db_tx_begin" });
        let lost = false;
        try {
          await raceDeadline(client.query("BEGIN"), {
            signal, timeoutMs: this.dl("op"), label: "db_tx_begin",
            onLose: () => { lost = true; try { client.release(new Error("db_tx_begin: connection killed")); } catch {} }
          });
        } catch (error) {
          if (!lost) { try { client.release(new Error("db_tx_begin failed")); } catch {} }
          throw error;
        }
        handle = { kind: "pg", client, signal };
      }
    } catch (error) {
      // START TRANSACTION/BEGIN failed before a transaction record existed.
      // The dedicated connection is therefore owned only here; destroy it so
      // a failed handshake or cancelled begin cannot leak a pool slot.
      return fail("db-tx-begin-failed", error.message);
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
    // The statement already passed the destructive-verb gate above and its
    // values are handed to the driver as a separate bindings array — never
    // assembled into the statement text.
    const statement = request.sql;
    const bindings = request.params ?? [];
    const signal = request.signal ?? tx.handle.signal;
    try {
      let value;
      if (tx.handle.kind === "mysql") {
        const [r] = await raceDeadline(tx.handle.conn.query(statement, bindings), {
          signal, timeoutMs: this.dl("op"), label: "db_tx_execute",
          onLose: () => this.killTransaction(tx)
        });
        if (Array.isArray(r)) {
          const truncated = r.length > this.maxDbRows;
          const rows = truncated ? r.slice(0, this.maxDbRows) : r;
          value = { affectedRows: 0, rowCount: rows.length, truncated, rows: rows.map(serializeDbValue) };
        } else {
          value = { affectedRows: r.affectedRows ?? 0, rowCount: 0, truncated: false, rows: [] };
          if (r.insertId) value.insertId = r.insertId;
        }
      } else {
        const r = await raceDeadline(tx.handle.client.query(statement, bindings), {
          signal, timeoutMs: this.dl("op"), label: "db_tx_execute",
          onLose: () => this.killTransaction(tx)
        });
        const allRows = r.rows ?? [];
        const truncated = allRows.length > this.maxDbRows;
        const rows = truncated ? allRows.slice(0, this.maxDbRows) : allRows;
        value = { affectedRows: r.rowCount ?? allRows.length, rowCount: rows.length, truncated, rows: rows.map(serializeDbValue) };
      }
      this.touchTransaction(tx);
      return { ok: true, value };
    } catch (error) {
      return fail("db-tx-execute-failed", error.message);
    }
  }

  /**
   * Abandon a transaction whose statement lost a race (cancel/deadline) while
   * it was in flight on a half-open transport: the dedicated connection is
   * mid-protocol, so it is destroyed rather than released, and the bookmark is
   * dropped so the agent reconnects instead of reusing a poisoned transaction.
   */
  killTransaction(tx) {
    if (!tx || tx.finished) return;
    tx.finished = true;
    if (tx.timer) clearTimeout(tx.timer);
    this.dbTransactions.delete(tx.txId);
    try {
      if (tx.handle.kind === "mysql") tx.handle.conn.destroy();
      else tx.handle.client.release(new Error(`transaction ${tx.txId}: connection killed after cancel/timeout`));
    } catch {}
  }

  async dbTxCommit(request) {
    return await this.finishTransaction(request.txId, "COMMIT", "db-tx-commit-failed", request.signal);
  }

  async dbTxRollback(request) {
    return await this.finishTransaction(request.txId, "ROLLBACK", "db-tx-rollback-failed", request.signal);
  }

  async finishTransaction(txId, action, errorCode, signal) {
    const tx = this.dbTransactions.get(txId);
    if (!tx) return fail("tx-missing", `transaction ${txId} not found or already finished`);
    const label = action === "COMMIT" ? "db_tx_commit" : "db_tx_rollback";
    let killed = false;
    try {
      const settled = tx.handle.kind === "mysql"
        ? await raceDeadline(tx.handle.conn.query(action), {
          signal, timeoutMs: this.dl("op"), label, onLose: () => { killed = true; }
        })
        : await raceDeadline(tx.handle.client.query(action), {
          signal, timeoutMs: this.dl("op"), label, onLose: () => { killed = true; }
        });
      void settled;
      if (killed) {
        // Raced out: the connection is mid-protocol and its transaction state
        // is unknown, so drop it instead of returning it to the pool.
        if (tx.handle.kind === "mysql") tx.handle.conn.destroy();
        else tx.handle.client.release(new Error(`${label}: connection killed after timeout`));
        this.dbTransactions.delete(txId);
        if (tx.timer) clearTimeout(tx.timer);
        return fail(errorCode, `${label} timed out after ${this.dl("op")}ms: the transaction outcome is unknown — verify the data before retrying`);
      }
      if (tx.handle.kind === "mysql") tx.handle.conn.release();
      else tx.handle.client.release();
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
        else tx.handle.client.release(killed ? new Error(`${label}: connection killed after cancel/timeout`) : undefined);
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
    let killed = false;
    try {
      if (tx.handle.kind === "mysql") {
        await raceDeadline(tx.handle.conn.query(action), {
          timeoutMs: this.dl("end"), label: "transaction cleanup", onLose: () => { killed = true; }
        });
        if (killed) tx.handle.conn.destroy();
        else tx.handle.conn.release();
      } else {
        await raceDeadline(tx.handle.client.query(action), {
          timeoutMs: this.dl("end"), label: "transaction cleanup", onLose: () => { killed = true; }
        });
        if (killed) tx.handle.client.release(new Error("transaction cleanup: connection killed after timeout"));
        else tx.handle.client.release();
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
    const opts = { signal: request.signal, label: "db_explain" };
    try {
      let plan;
      if (record.type === "mysql") {
        const [r] = await this.mysqlQueryOnce(record, "EXPLAIN FORMAT=JSON " + request.sql, request.params ?? [], opts);
        const raw = r?.[0]?.EXPLAIN ?? null;
        plan = typeof raw === "string" ? JSON.parse(raw) : raw;
      } else {
        const r = await this.pgQueryOnce(record, "EXPLAIN (FORMAT JSON) " + request.sql, request.params ?? [], opts);
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
        // node-redis queues commands while the socket is down and would answer
        // only after its own reconnect succeeds — on a dead tunnel that never
        // happens, so the command must race client-side. A lost race leaves the
        // connection suspect: drop it (disconnect also stops the retry loop).
        const result = await raceDeadline(record.client.sendCommand([command, ...(args ?? [])]), {
          signal: request.signal, timeoutMs: this.dl("op"), label: "db_run",
          onLose: (error) => { this.handleDbTransportLoss(record.id, record.client, error); }
        });
        return { ok: true, value: { result: serializeDbValue(result) } };
      }
      if (record.type === "mongodb") {
        const { collection, operation, filter, document, update, options } = request;
        if (!collection || !operation) return fail("bad-request", "mongodb run requires { collection, operation }");
        const col = record.client.db(record.config.database).collection(collection);
        // The driver's own socketTimeoutMS is a SERVER option; a locally dead
        // tunnel is not covered by it, so every op races the client deadline.
        const mongoRun = async () => {
          switch (operation) {
            case "find": return await col.find(filter ?? {}).limit(100).toArray();
            case "findOne": return await col.findOne(filter ?? {});
            case "insertOne": return await col.insertOne(document);
            case "updateOne": return await col.updateOne(filter ?? {}, update, options);
            case "deleteOne": return await col.deleteOne(filter ?? {});
            case "countDocuments": return await col.countDocuments(filter ?? {});
            default: throw new Error(`unsupported mongo operation: ${operation}`);
          }
        };
        const result = await raceDeadline(mongoRun(), {
          signal: request.signal, timeoutMs: this.dl("op"), label: "db_run",
          onLose: (error) => {
            // Clear the stuck topology so the next call starts from a clean
            // selection instead of queueing behind the dead one.
            try { record.client.close(true).catch(() => {}); } catch {}
            this.handleDbTransportLoss(record.id, record.client, error);
          }
        });
        return { ok: true, value: { result: serializeDbValue(result) } };
      }
      return fail("unsupported-op", `db_run only supports redis/mongodb, use db_query for ${record.type}`);
    } catch (error) {
      return fail("db-run-failed", error.message);
    }
  }
}
