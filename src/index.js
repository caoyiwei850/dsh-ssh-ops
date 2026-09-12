/**
 * dsh-ssh-ops host half: a Typert Remote service named `sshOps` that manages
 * ssh2 connections and PTY shell sessions, streaming output to the browser
 * through long-poll reads. Also registers agent tools (ssh_connect, ssh_exec,
 * ...) so the main conversation can drive the same sessions the panel shows.
 */
import { createTerminalOutput } from "./terminal-output.js";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { Client } from "ssh2";
import { Service } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { z } from "zod";
import { assessShellCommand, isPrefillable, shellQuote } from "./safety.js";
import { EXEC_CWD_ERROR_PREFIX, buildCwdAwareCommand, execEchoWarning, extractExecCwd, posixLoginShell } from "./exec-cwd.js";
import { scpCommand, scpDownload, scpUpload } from "./scp.js";
import { redactForModel } from "./redact.js";
import { isTransientConnectError } from "./net-errors.js";
import { processTerminalInput } from "./terminal-input.js";
import { fail } from "./envelope.js";
import { POLICY_NOTICE_PREFIX, DANGEROUS_DEFAULT_REASON } from "./policy-messages.js";
import { DbOpsManager } from "./db-ops.js";
import {
  KnownHosts,
  decideHostKey,
  keyFingerprint,
  blobAlgorithm,
  DEFAULT_HOST_KEY_MODE
} from "./hostkey.js";
import { registerSshSessionTools } from "./tools/ssh-session.js";
import { registerSftpTools } from "./tools/sftp.js";
import { registerTunnelTools } from "./tools/tunnel.js";
import { registerBatchTools } from "./tools/batch.js";
import { registerDbTools } from "./tools/db.js";

const MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const MAX_CAPTURE_BYTES = 128 * 1024;
const READ_TIMEOUT_MS = 300;
const MAX_SESSIONS = 64;
// ssh2 disables keepalives by default; without them NATs and cloud firewalls
// silently drop idle connections and every later operation fails on a dead
// transport. Keep the mapping alive and detect a truly dead link fast.
const KEEPALIVE_INTERVAL_MS = 20000;
const KEEPALIVE_COUNT_MAX = 3;
// Transient connect failures (resets, timeouts, scanner-induced refusals) are
// retried with backoff; authentication failures are never retried.
const CONNECT_RETRIES = 3;

/**
 * Key-exchange algorithms for Huawei legacy VRP (S12712 and similar switches,
 * also some old IOS/Comware builds). Such devices offer ONLY SHA-1 group14 and
 * reject every modern KEX, so the handshake dies with "no matching key
 * exchange algorithm" and the device looks simply unreachable.
 *
 * ssh2 ships `diffie-hellman-group14-sha1` in SUPPORTED_KEX but deliberately
 * leaves it out of DEFAULT_KEX (SHA-1 KEX is no longer considered secure), so
 * it must be opted into explicitly. `append` places these after every modern
 * algorithm: a modern peer still negotiates modern, and only a peer that
 * speaks nothing else lands on SHA-1. Scope is deliberately KEX-only — host
 * key and cipher policy are left at ssh2's defaults.
 */
export const LEGACY_VRP_ALGORITHMS = Object.freeze({
  kex: { append: ["diffie-hellman-group14-sha1"] }
});

/**
 * True when the handshake failed because the two sides share no KEX algorithm
 * (as opposed to a wrong password, an unreachable host, or a timeout). Only
 * this specific failure justifies retrying with legacy algorithms — matching
 * anything broader would silently weaken every failing connection.
 */
export function isKexMismatchError(error) {
  const message = String(error?.message ?? error ?? "");
  return /no matching key exchange|no matching kex|key exchange algorithm/i.test(message);
}
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const RECONNECT_WAIT_MS = 30000;
// Stream push keepalive: when the terminal is idle the generator still yields
// an empty item at this cadence, so the client can tell a live-but-quiet
// terminal from a dead WebSocket mux.
const STREAM_HEARTBEAT_MS = 15000;
// Streaming file plane (workbench S6 patch): plain-HTTP byte routes registered
// on the DSH webserver, guarded by the connection service's Host/Origin +
// browser-cookie fence (the same guard the typert gateway applies to /api and
// /api/remote.mux). Raw bytes on the wire — no base64 envelope, and no
// whole-file buffering on either side of the ssh2 SFTP streams.
const STREAM_ROUTE_PREFIX = "/ssh-ops/stream";
const STREAM_HIGH_WATER_MARK = 256 * 1024;
// Zombie-upload bound: a paused request cannot observe the client's FIN while
// unread body bytes precede it (Node reports request close only after the body
// drains), so an idle-socket timeout backstops the cancelled-upload cleanup.
const STREAM_IDLE_TIMEOUT_MS = 30000;
// batchRun opens a full SSH connect + exec per target; an unbounded Promise.all
// would storm every selected server (and any rate-limited network path between)
// at once. Worker-pool the targets instead.
const BATCH_MAX_CONCURRENCY = 4;
// Upper bound for one SFTP/SCP read (agent tools may lower it via max_bytes).
const MAX_FILE_READ_BYTES = 4 * 1024 * 1024;
// Late readers can still see the exit status of the N most recently exited
// sessions (session tombstones).
const MAX_EXIT_TOMBSTONES = 64;

const profileRecordSchema = z.object({
  name: z.string(),
  host: z.string(),
  port: z.number().int(),
  username: z.string(),
  authKind: z.enum(["password", "key"]),
  groupId: z.string().uuid().nullable(),
  // Host-key TOFU mode persisted per saved server; optional so records saved
  // before this feature existed still load (treated as the accept-new default).
  hostKeyMode: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

const groupRecordSchema = z.object({
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string()
});

const profileDomainSpec = defineDomain({
  name: "ssh_ops_profiles",
  version: 1,
  tables: {
    profiles: domainTable(profileRecordSchema),
    groups: domainTable(groupRecordSchema)
  }
});

const dbProfileRecordSchema = z.object({
  name: z.string(),
  type: z.enum(["mysql", "postgresql", "redis", "mongodb"]),
  host: z.string(),
  port: z.number().int(),
  database: z.string().nullable(),
  username: z.string().nullable(),
  ssl: z.string(),
  sshProfileId: z.string().uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
});

const dbProfileDomainSpec = defineDomain({
  name: "db_ops_profiles",
  version: 1,
  tables: {
    profiles: domainTable(dbProfileRecordSchema)
  }
});

const knownHostRecordSchema = z.object({
  host: z.string(),
  port: z.number().int(),
  algorithm: z.string(),
  fingerprint: z.string(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string()
});

const knownHostDomainSpec = defineDomain({
  name: "ssh_ops_known_hosts",
  version: 1,
  tables: {
    known_hosts: domainTable(knownHostRecordSchema)
  }
});

function profileCredentialRefs(profileId) {
  const stem = profileId.replaceAll("-", "").toUpperCase();
  return {
    password: `DSH_SSH_OPS_${stem}_PASSWORD`,
    privateKey: `DSH_SSH_OPS_${stem}_PRIVATE_KEY`,
    passphrase: `DSH_SSH_OPS_${stem}_PASSPHRASE`
  };
}

function dbProfileCredentialRefs(dbProfileId) {
  const stem = dbProfileId.replaceAll("-", "").toUpperCase();
  return { password: `DSH_DB_OPS_${stem}_PASSWORD` };
}

/** Base64-decode a wire payload to a UTF-8 string. */
function decodeData(data) {
  return Buffer.from(data, "base64").toString("utf8");
}

/** Base64-encode a UTF-8 string for the wire. */
function encodeData(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

function appendCapped(current, next, maxBytes) {
  const existing = Buffer.byteLength(current, "utf8");
  const incoming = Buffer.from(next, "utf8");
  if (existing >= maxBytes) return { text: current, truncated: incoming.length > 0 };
  const remaining = maxBytes - existing;
  if (incoming.length <= remaining) return { text: current + next, truncated: false };
  return { text: current + incoming.subarray(0, remaining).toString("utf8"), truncated: true };
}

function tailCapped(text, maxBytes) {
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= maxBytes ? text : bytes.subarray(bytes.length - maxBytes).toString("utf8");
}

function promptFromTerminalData(text) {
  const visible = String(text)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const match = visible.match(/(?:^|[\r\n])([^\r\n]*[#$] )$/);
  return match?.[1] ?? null;
}

/**
 * ssh2 exec channels return LF-delimited text. xterm keeps the current column
 * on a bare LF, which makes multi-line agent output drift diagonally. Agent
 * output is synthetic terminal data, so normalize it to the terminal CRLF.
 */
export function normalizeTerminalEol(text) {
  return String(text ?? "").replace(/\r\n|\r|\n/g, "\r\n");
}

/**
 * SshOpsService: one cordis service (and Typert Remote) that owns all SSH
 * connections and their PTY shell sessions for the web profile.
 */
export default class SshOpsService extends TypertRemoteService {
  /** Host-owned profiles and secrets never cross the agent tool boundary. */
  static inject = ["tools", "storageDomain", "credentials"];

  /** connectionId -> live connection record */
  connections = new Map();
  /** sessionId -> live PTY shell session record */
  sessions = new Map();
  /** sessionId -> tombstoned exit records for late reads */
  exitedSessions = new Map();
  /** confirmationId -> agent-originated dangerous command awaiting a human. */
  pendingConfirmations = new Map();
  /** batchId -> operator-selected batch exec task awaiting selection/execution. */
  batchTasks = new Map();

  /** The connection currently represented by the right-side terminal panel. */
  activeConnectionId = null;
  profileTable = null;
  groupTable = null;
  /** known_hosts table (host:port → fingerprint record); null until [Service.init]. */
  knownHostTable = null;
  /** KnownHosts adapter over `knownHostTable`; null until [Service.init]. */
  knownHosts = null;

  constructor(ctx, config = {}) {
    super(ctx, "sshOps");
    this.config = {
      defaultReadTimeoutMs: READ_TIMEOUT_MS,
      maxBufferBytes: MAX_BUFFER_BYTES,
      maxCommandOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
      maxCaptureBytes: MAX_CAPTURE_BYTES,
      streamHeartbeatMs: STREAM_HEARTBEAT_MS,
      ...config
    };
    // Tear down all connections when the plugin fiber unloads.
    ctx.effect(() => () => {
      for (const conn of this.connections.values()) {
        conn.closing = true;
        if (conn.reconnectTimer !== null) clearTimeout(conn.reconnectTimer);
        try { conn.client?.end(); } catch {}
        for (const hop of conn.hops ?? []) { try { hop.end(); } catch {} }
      }
      this.connections.clear();
      this.sessions.clear();
      this.exitedSessions.clear();
      this.pendingConfirmations.clear();
      this.activeConnectionId = null;
      try { this.dbOps?.closeAll().catch(() => {}); } catch {}
    }, "ssh-ops: cleanup");
    this.dbOps = new DbOpsManager(this);
    this.registerTools(ctx);
    // Streaming file routes (workbench S6 patch): reactive inject — no hard
    // activation dependency, so compositions without a webserver simply never
    // serve the byte plane. Same registration pattern the typert gateway uses
    // for the /api/remote.mux WebSocket (connection.requestRejection guard +
    // webServer.register prefix route, disposed with this fiber).
    ctx.inject(["connection", "webServer"], (hostCtx) => {
      hostCtx.effect(() => hostCtx.webServer.register({
        kind: "prefix",
        path: STREAM_ROUTE_PREFIX,
        handler: (req, res) => {
          this.handleStreamRoute(req, res, hostCtx.connection);
        }
      }), "ssh-ops: streaming file routes");
    });
  }

  async [Service.init]() {
    const domain = await this.ctx.storageDomain.open(profileDomainSpec);
    this.profileTable = domain.table("profiles");
    this.groupTable = domain.table("groups");
    this.ctx.effect(() => () => domain.close(), "ssh-ops: profile domain close");
    const dbDomain = await this.ctx.storageDomain.open(dbProfileDomainSpec);
    this.dbProfileTable = dbDomain.table("profiles");
    this.ctx.effect(() => () => dbDomain.close(), "ssh-ops: db profile domain close");
    const knownHostDomain = await this.ctx.storageDomain.open(knownHostDomainSpec);
    this.knownHostTable = knownHostDomain.table("known_hosts");
    this.knownHosts = new KnownHosts(this.knownHostTable);
    this.ctx.effect(() => () => knownHostDomain.close(), "ssh-ops: known-host domain close");
  }

  // ── Remote methods ─────────────────────────────────────────────────────────

  async list() {
    const connections = [];
    for (const [connectionId, c] of this.connections) {
      const connection = {
        connectionId,
        host: c.host,
        port: c.port,
        username: c.username,
        connected: true,
        sessions: [...c.sessions]
      };
      // Strict Typert results must be JSON-safe: optional fields must be
      // absent, rather than present with an `undefined` value.
      if (c.name !== undefined) connection.name = c.name;
      connections.push(connection);
    }
    return { ok: true, value: { connections, activeConnectionId: this.activeConnectionId } };
  }

  async connect(request) {
    return this.connectInternal(request);
  }

  async connectInternal(request, profileId = undefined) {
    const id = request.name ? `${request.name}-${randomUUID().slice(0, 8)}` : randomUUID();
    const connectConfig = {
      host: request.host,
      port: request.port ?? 22,
      username: request.username,
      readyTimeout: request.readyTimeout ?? 20000,
      keepaliveInterval: request.keepaliveInterval ?? KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: request.keepaliveCountMax ?? KEEPALIVE_COUNT_MAX
    };
    if (request.auth.kind === "password") {
      connectConfig.password = request.auth.password;
    } else {
      connectConfig.privateKey = request.auth.privateKey;
      if (request.auth.passphrase !== void 0) connectConfig.passphrase = request.auth.passphrase;
    }
    const record = {
      id,
      client: null,
      hops: [],
      host: connectConfig.host,
      port: connectConfig.port,
      username: connectConfig.username,
      name: request.name,
      profileId,
      sessions: new Set(),
      sftp: null,
      tunnels: new Map(),
      // Transport health / self-healing state: keep the auth config around so
      // a dropped transport can be re-established transparently instead of
      // forcing the user to open a brand-new session.
      connectConfig,
      // Legacy-KEX policy for this connection: an explicit request disables
      // the automatic retry, because the user already told us what to use.
      legacyAlgorithms: request.legacy === true,
      legacyFallback: false,
      // `legacy: false` is an explicit "modern only, do NOT downgrade" — the
      // automatic retry is opt-out, not merely opt-in.
      allowLegacyDowngrade: request.legacy === undefined,
      proxyJump: Array.isArray(request.proxyJump) ? request.proxyJump : [],
      // Host-key TOFU mode for this connection (undefined → accept-new default
      // resolved in attachHostVerifier). Persisted on the record so transparent
      // reconnects re-check with the same policy.
      hostKeyMode: request.hostKeyMode,
      dead: true,
      closing: false,
      connecting: true,
      reconnectTimer: null,
      reconnectAttempts: 0,
      reconnectWaiters: []
    };
    this.connections.set(id, record);
    const connected = await this.connectClient(record, request.retries ?? CONNECT_RETRIES);
    record.connecting = false;
    if (!connected.ok) {
      this.connections.delete(id);
      return connected;
    }
    this.attachTransportHandlers(record);
    const value = {
      connectionId: id,
      host: connectConfig.host,
      port: connectConfig.port,
      username: connectConfig.username
    };
    // See list(): the RPC gateway rejects `undefined` as a JSON value.
    if (request.name !== undefined) value.name = request.name;
    // Surface a downgraded handshake to the caller: a silently weakened
    // transport is worse than a slow one, because nobody thinks to upgrade the
    // device afterwards.
    if (record.legacyFallback) {
      value.legacyFallback = true;
      value.warning = "This server offered no modern SSH key exchange; connected with the legacy diffie-hellman-group14-sha1 algorithm. The transport is weaker than the default — upgrade the device firmware when possible.";
    }
    // A newly connected server is the natural target for the conversation,
    // even if the browser has not rendered its PTY yet.
    this.activeConnectionId = id;
    return {
      ok: true,
      value
    };
  }

  // ── host-key TOFU ──────────────────────────────────────────────────────────

  /**
   * Build an ssh2 `hostVerifier` (key, verify) => boolean for a host:port.
   * Decides accept/record/reject against the known_hosts store; on rejection
   * stashes a verdict on `state` so the caller surfaces a non-retriable error,
   * and on first-seen acceptance stashes a record-to-persist after `ready`.
   */
  makeHostVerifier(state, host, port, mode) {
    return (key) => {
      try {
        const algorithm = blobAlgorithm(key);
        const presented = keyFingerprint(key);
        const known = this.knownHosts?.get(host, port);
        const verdict = decideHostKey({ mode, known, presentedFingerprint: presented, algorithm });
        if (!verdict.accept) {
          state.hostKeyMismatch = { reason: verdict.reason, host, port, mode, expected: verdict.expected, got: verdict.got ?? presented };
          return false;
        }
        if (verdict.record) {
          state.hostKeyToRecord = { host, port, fingerprint: verdict.record.fingerprint, algorithm: verdict.record.algorithm };
        }
        return true;
      } catch (error) {
        state.hostKeyMismatch = { reason: "verifier-error", host, port, mode, message: error.message };
        return false;
      }
    };
  }

  /** Attach a TOFU verifier to an ssh2 connect config (no-op when off or store not ready). */
  attachHostVerifier(config, state, host, port, mode) {
    const effective = mode ?? DEFAULT_HOST_KEY_MODE;
    if (this.knownHosts === null || effective === "off") return;
    config.hostVerifier = this.makeHostVerifier(state, host, port, effective);
  }

  /** Persist a first-seen host key after a successful handshake. */
  async persistFirstSeenHostKey(state) {
    const pending = state.hostKeyToRecord;
    if (!pending) return;
    state.hostKeyToRecord = null;
    if (this.knownHosts !== null) {
      await this.knownHosts.record(pending.host, pending.port, { fingerprint: pending.fingerprint, algorithm: pending.algorithm });
    }
  }

  /** Turn a stashed host-key verdict into a non-retriable result error. */
  hostKeyError(m) {
    const where = `${m.host}:${m.port}`;
    if (m.reason === "unseen-host") {
      return fail("host-key-unseen", `host key for ${where} is not previously trusted (mode ${m.mode}). Presented SHA256:${m.got}; verify it out of band. Strict mode will not create a trust record; follow your approved process before changing the profile policy.`);
    }
    if (m.reason === "host-key-mismatch") {
      return fail("host-key-mismatch", `host key for ${where} changed (mode ${m.mode}). Expected SHA256:${m.expected}; presented SHA256:${m.got}. This may be a man-in-the-middle or a re-provisioned server. Verify it out of band; if legitimate, use "忘记主机指纹" and reconnect.`);
    }
    return fail("host-key-error", `host key verification error for ${where} (mode ${m.mode}): ${m.message ?? m.reason}`);
  }

  /**
   * Establish (or re-establish) the ssh2 transport of a connection record.
   * Transient network failures are retried with backoff; authentication
   * failures are not.
   */
  async connectClient(record, retries = CONNECT_RETRIES) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (record.closing) {
        return { ok: false, error: fail("connect-cancelled", `connection "${record.id}" was closed`) };
      }
      // Build the jump chain first (if configured): each hop connects through
      // the previous one via forwardOut, producing a stream that becomes the
      // `sock` of the target connection. On failure the whole chain is torn down.
      let sock;
      if (record.proxyJump.length > 0) {
        try {
          const chain = await this.connectChain(record.proxyJump, record.connectConfig.host, record.connectConfig.port);
          record.hops = chain.hops;
          sock = chain.sock;
        } catch (error) {
          lastError = error;
          if (error?.code === "host-key-mismatch" || error?.code === "host-key-unseen" || error?.code === "host-key-error") {
            return { ok: false, error: fail(error.code, error.message) };
          }
          if (attempt >= retries) break;
          await this.sleep(Math.min(2000, 500 * 2 ** attempt));
          continue;
        }
      }
      const client = new Client();
      record.client = client;
      try {
        await new Promise((resolve, reject) => {
          // ssh2 can emit several protocol errors while a handshake is dying
          // (observed live: "Connection lost before handshake" twice in a
          // row). The first event settles the wait; the standing error
          // listener must outlive it, because an 'error' emission with zero
          // listeners crashes the whole DSH process. A cancelled connect is
          // broken out of via the close event below.
          let settled = false;
          const onReady = () => { if (!settled) { settled = true; resolve(); } };
          const onError = (cause) => { if (!settled) { settled = true; reject(cause); } };
          const onClose = () => { if (!settled) { settled = true; reject(new Error("connection closed before handshake completed")); } };
          client.once("ready", onReady);
          client.on("error", onError);
          client.once("close", onClose);
          const config = { ...record.connectConfig };
          // Single source of truth for the legacy KEX set: `legacy: true`
          // seeds the flag, an automatic downgrade flips it mid-loop, and this
          // is the only place a handshake's options are assembled (so the two
          // paths can never drift apart).
          if (record.legacyAlgorithms) {
            config.algorithms = { ...(config.algorithms ?? {}), ...LEGACY_VRP_ALGORITHMS };
          }
          if (sock !== undefined) config.sock = sock;
          this.attachHostVerifier(config, record, record.host, record.port, record.hostKeyMode);
          client.connect(config);
        });
        record.dead = false;
        record.reconnectAttempts = 0;
        await this.persistFirstSeenHostKey(record);
        return { ok: true };
      } catch (error) {
        // Host-key TOFU rejection is never transient: surface it, don't retry.
        if (record.hostKeyMismatch) {
          for (const hop of record.hops) { try { hop.end(); } catch {} }
          record.hops = [];
          return { ok: false, error: this.hostKeyError(record.hostKeyMismatch) };
        }
        lastError = error;
        // A cancelled connect must not spend its remaining retry attempts.
        if (record.closing) break;
        // Tear down hops on failure so the retry starts fresh.
        for (const hop of record.hops) { try { hop.end(); } catch {} }
        record.hops = [];
        // Only when the user did not ask for legacy explicitly: a shared
        // KEX-less handshake means this peer may be an old VRP switch, so
        // retry ONCE with the legacy algorithm set and remember that we did.
        //
        // This consumes a retry attempt on purpose — but the loop bound is
        // widened by one while the downgrade is still available, so a caller
        // that passed retries:0 (or a small budget) still gets the legacy
        // chance. Otherwise a modern-only handshake failure would be reported
        // for a device the plugin can actually reach.
        if (!record.legacyAlgorithms && record.allowLegacyDowngrade && isKexMismatchError(error)) {
          record.legacyAlgorithms = true;
          record.legacyFallback = true;
          this.log(`SSH ${record.host}:${record.port} offered no modern key exchange; retrying with legacy algorithms (diffie-hellman-group14-sha1). The transport is weaker than the default — reachable, but prefer upgrading the device if you can.`);
          if (attempt >= retries) retries += 1;
          continue;
        }
        if (!isTransientConnectError(error) || attempt >= retries) break;
        await this.sleep(Math.min(2000, 500 * 2 ** attempt));
      }
    }
    if (record.closing) {
      return { ok: false, error: fail("connect-cancelled", `connection "${record.id}" was closed`) };
    }
    return {
      ok: false,
      error: fail("connect-failed", `${record.username}@${record.host}:${record.port}: ${lastError?.message ?? "connection failed"}`)
    };
  }

  /**
   * Build one full jump chain: hop clients connected through in order, each
   * forwarding a stream to the next destination, ending with a stream usable
   * as the `sock` of the target connection. Returns the final stream and the
   * list of hop clients (for teardown). Each hop config is an inline object
   * {host, port, username, auth, readyTimeout}.
   */
  async connectChain(proxyJump, targetHost, targetPort) {
    const hops = [];
    let sock;
    for (let index = 0; index < proxyJump.length; index += 1) {
      const hopConfig = proxyJump[index];
      const hopConnectConfig = {
        host: hopConfig.host,
        port: hopConfig.port ?? 22,
        username: hopConfig.username,
        // Jump hosts are ordinary SSH servers; legacy KEX is NOT forced on
        // them, so an old switch as a jump host would need its own explicit
        // `legacy` support. The legacy downgrade applies to the target
        // connection (the one that terminates at the device).
        readyTimeout: hopConfig.readyTimeout ?? 20000
      };
      if (hopConfig.auth?.kind === "password") {
        hopConnectConfig.password = hopConfig.auth.password;
      } else if (hopConfig.auth?.kind === "key") {
        hopConnectConfig.privateKey = hopConfig.auth.privateKey;
        if (hopConfig.auth.passphrase !== void 0) hopConnectConfig.passphrase = hopConfig.auth.passphrase;
      }
      if (sock !== undefined) hopConnectConfig.sock = sock;
      const hopState = { hostKeyMismatch: null, hostKeyToRecord: null };
      this.attachHostVerifier(hopConnectConfig, hopState, hopConnectConfig.host, hopConnectConfig.port, hopConfig.hostKeyMode);
      const hopClient = new Client();
      try {
        await new Promise((resolve, reject) => {
          // Standing error listener for the hop's whole life: ssh2 may emit a
          // second protocol error after the first one settled this promise,
          // and an unhandled 'error' crashes the DSH process.
          let settled = false;
          hopClient.once("ready", () => { if (!settled) { settled = true; resolve(); } });
          hopClient.on("error", (cause) => { if (!settled) { settled = true; reject(cause); } });
          hopClient.connect(hopConnectConfig);
        });
        await this.persistFirstSeenHostKey(hopState);
      } catch (error) {
        for (const h of hops) { try { h.end(); } catch {} }
        if (hopState.hostKeyMismatch) {
          const m = hopState.hostKeyMismatch;
          const hostKeyFailure = this.hostKeyError(m);
          const hopError = new Error(`proxyJump hop ${index + 1} (${hopConnectConfig.username}@${hopConnectConfig.host}:${hopConnectConfig.port}): ${hostKeyFailure.message}`);
          hopError.code = hostKeyFailure.code;
          throw hopError;
        }
        throw new Error(`proxyJump hop ${index + 1} (${hopConnectConfig.username}@${hopConnectConfig.host}:${hopConnectConfig.port}): ${error.message}`);
      }
      hops.push(hopClient);
      // forwardOut to the next destination: the next hop, or the final target.
      const next = index + 1 < proxyJump.length ? proxyJump[index + 1] : null;
      const nextHost = next !== null ? next.host : targetHost;
      const nextPort = next !== null ? (next.port ?? 22) : targetPort;
      sock = await new Promise((resolve, reject) => {
        hopClient.forwardOut("127.0.0.1", 0, nextHost, nextPort, (error, stream) => {
          if (error) {
            for (const h of hops) { try { h.end(); } catch {} }
            reject(new Error(`proxyJump hop ${index + 1} forwardOut to ${nextHost}:${nextPort}: ${error.message}`));
          } else {
            resolve(stream);
          }
        });
      });
    }
    return { hops, sock };
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Wire transport-loss handlers to the record's current client. */
  /**
   * Defensive logging: ctx.logger is not wired in the DSH host, so console
   * output is what reaches ~/.dsh/web.log. Without this, a security-relevant
   * decision (a downgraded SSH handshake) would leave no trace anywhere.
   */
  log(message) {
    try { this.ctx?.logger?.warn?.(message); } catch {}
    try { console.warn("[dsh-ssh-ops]", message); } catch {}
  }

  attachTransportHandlers(record) {
    const client = record.client;
    client.on("error", (error) => this.handleTransportLoss(record, client, error));
    client.on("close", () => this.handleTransportLoss(record, client, null));
  }

  /**
   * The transport died under us (idle NAT drop, network blip, server reset).
   * Mark the record dead, retire its shell sessions and SFTP channel, then
   * schedule a transparent reconnect so later operations self-heal instead of
   * forcing a brand-new session every time.
   */
  handleTransportLoss(record, client, _error) {
    if (record.closing || record.client !== client || record.dead) return;
    record.dead = true;
    record.sftp = null;
    for (const sessionId of [...record.sessions]) {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.exited = session.exited ?? { code: 1 };
        session.stream = null;
        this.rememberExit(sessionId, session.exited);
      }
      this.sessions.delete(sessionId);
    }
    record.sessions.clear();
    for (const tunnel of record.tunnels.values()) tunnel.active = false;
    this.scheduleReconnect(record);
  }

  /** Auto-reconnect a dead record with capped exponential backoff. */
  scheduleReconnect(record) {
    if (record.closing || !record.dead || record.reconnectTimer !== null) return;
    const delay = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_BASE_DELAY_MS * 2 ** Math.min(record.reconnectAttempts, 5)
    );
    record.reconnectAttempts += 1;
    record.reconnectTimer = setTimeout(async () => {
      record.reconnectTimer = null;
      if (record.closing || !record.dead) return;
      const connected = await this.connectClient(record, 0);
      if (!connected.ok) {
        // A host-key mismatch/unseen must NOT trigger a reconnect storm against
        // a possibly re-provisioned or impersonated server: stop retrying and
        // let the operator decide (forget the key or investigate).
        const code = connected.error?.code;
        if (code === "host-key-mismatch" || code === "host-key-unseen" || code === "host-key-error") {
          return;
        }
        this.scheduleReconnect(record);
        return;
      }
      this.attachTransportHandlers(record);
      for (const tunnel of record.tunnels.values()) {
        if (tunnel.kind === "remote" && tunnel.bridgeInfo?.bridge) {
          record.client.prependListener("tcp connection", tunnel.bridgeInfo.bridge);
        }
        tunnel.active = true;
      }
      const waiters = record.reconnectWaiters.splice(0);
      for (const waiter of waiters) waiter();
    }, delay);
  }

  /**
   * Wait until the record's transport is usable. If it is dead, waits for the
   * in-flight reconnect (bounded). Resolves false only when the connection was
   * explicitly closed or reconnect did not complete in time.
   */
  ensureAlive(record, timeoutMs = RECONNECT_WAIT_MS) {
    if (record.closing) return Promise.resolve(false);
    if (!record.dead) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      record.reconnectWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  requireProfileTable() {
    if (this.profileTable === null) throw new Error("SSH resource storage is not ready");
    return this.profileTable;
  }

  requireKnownHostTable() {
    if (this.knownHostTable === null) throw new Error("known-host storage is not ready");
    return this.knownHostTable;
  }

  requireGroupTable() {
    if (this.groupTable === null) throw new Error("SSH resource storage is not ready");
    return this.groupTable;
  }

  groupPublic(groupId, record) {
    const profileCount = [...this.requireProfileTable().entries()].filter(([, profile]) => profile.groupId === groupId).length;
    return { groupId, name: record.name, profileCount };
  }

  async profilePublic(profileId, record) {
    const refs = profileCredentialRefs(profileId);
    const primaryRef = record.authKind === "password" ? refs.password : refs.privateKey;
    const [primary, passphrase] = await Promise.all([
      this.ctx.credentials.describe(credentialRef(primaryRef)),
      this.ctx.credentials.describe(credentialRef(refs.passphrase))
    ]);
    const connected = [...this.connections.values()].some((connection) => connection.profileId === profileId);
    const group = record.groupId === null ? undefined : this.requireGroupTable().get(record.groupId);
    return {
      profileId,
      name: record.name,
      host: record.host,
      port: record.port,
      username: record.username,
      authKind: record.authKind,
      hostKeyMode: record.hostKeyMode ?? DEFAULT_HOST_KEY_MODE,
      groupId: group === undefined ? null : record.groupId,
      groupName: group?.name ?? null,
      credentialConfigured: primary.configured,
      passphraseConfigured: passphrase.configured,
      connected
    };
  }

  async profileList() {
    try {
      const profiles = await Promise.all(
        [...this.requireProfileTable().entries()].map(async ([profileId, record]) => await this.profilePublic(profileId, record))
      );
      profiles.sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));
      return { ok: true, value: { profiles } };
    } catch (error) {
      return { ok: false, error: fail("profile-list-failed", error.message) };
    }
  }

  async profileSave(request) {
    try {
      const table = this.requireProfileTable();
      const profileId = request.profileId ?? randomUUID();
      const previous = table.get(profileId);
      if (request.profileId !== undefined && previous === undefined) {
        return { ok: false, error: fail("no-profile", `SSH resource "${profileId}" does not exist`) };
      }
      const now = new Date().toISOString();
      const groupId = request.groupId ?? null;
      if (groupId !== null && this.requireGroupTable().get(groupId) === undefined) {
        return { ok: false, error: fail("no-group", `SSH group "${groupId}" does not exist`) };
      }
      const record = {
        name: request.name.trim(),
        host: request.host.trim(),
        port: request.port ?? 22,
        username: request.username.trim(),
        authKind: request.authKind,
        hostKeyMode: request.hostKeyMode ?? DEFAULT_HOST_KEY_MODE,
        groupId,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now
      };
      await table.put(profileId, record);
      return {
        ok: true,
        value: {
          profile: await this.profilePublic(profileId, record),
          credentialRefs: profileCredentialRefs(profileId)
        }
      };
    } catch (error) {
      return { ok: false, error: fail("profile-save-failed", error.message) };
    }
  }

  async profileDelete(request) {
    try {
      const table = this.requireProfileTable();
      const record = table.get(request.profileId);
      if (record === undefined) return { ok: true, value: { deleted: false } };
      const refs = profileCredentialRefs(request.profileId);
      // Only names derived from this resource id are ever removed. A live SSH
      // transport keeps running; deletion only forgets future quick-connect.
      await Promise.all(Object.values(refs).map(async (ref) => await this.ctx.credentials.unset(credentialRef(ref))));
      await table.delete(request.profileId);
      return { ok: true, value: { deleted: true } };
    } catch (error) {
      return { ok: false, error: fail("profile-delete-failed", error.message) };
    }
  }

  /**
   * Disconnect every live connection opened for a saved profile. The
   * resources page owns this path so a "已连接" badge always has a matching
   * operator control, including connections re-adopted after a page reload.
   */
  async profileDisconnect(request) {
    try {
      const targets = [...this.connections.values()].filter((connection) => connection.profileId === request.profileId);
      for (const record of targets) await this.disconnect({ connectionId: record.id });
      return { ok: true, value: { disconnected: targets.length } };
    } catch (error) {
      return { ok: false, error: fail("profile-disconnect-failed", error.message) };
    }
  }

  async profileConnect(request) {
    try {
      const record = this.requireProfileTable().get(request.profileId);
      if (record === undefined) return { ok: false, error: fail("no-profile", `SSH resource "${request.profileId}" does not exist`) };
      const refs = profileCredentialRefs(request.profileId);
      const primaryRef = record.authKind === "password" ? refs.password : refs.privateKey;
      const primary = await this.ctx.credentials.resolve(credentialRef(primaryRef));
      if (primary === undefined) {
        return { ok: false, error: fail("credential-missing", `SSH resource "${record.name}" has no saved ${record.authKind === "password" ? "password" : "private key"}`) };
      }
      const passphrase = record.authKind === "key"
        ? await this.ctx.credentials.resolve(credentialRef(refs.passphrase))
        : undefined;
      return await this.connectInternal({
        name: record.name,
        host: record.host,
        port: record.port,
        username: record.username,
        hostKeyMode: record.hostKeyMode,
        readyTimeout: request.readyTimeout,
        retries: request.retries,
        auth: record.authKind === "password"
          ? { kind: "password", password: primary.value }
          : { kind: "key", privateKey: primary.value, ...(passphrase === undefined ? {} : { passphrase: passphrase.value }) }
      }, request.profileId);
    } catch (error) {
      return { ok: false, error: fail("profile-connect-failed", error.message) };
    }
  }

  /**
   * Abort an in-flight profile connect. Safe to call after the connect
   * settled (then it is a no-op); while the handshake is pending, ending the
   * socket breaks the wait immediately.
   */
  async cancelProfileConnect(request) {
    try {
      let cancelled = 0;
      for (const record of this.connections.values()) {
        if (!record.connecting) continue;
        if (request?.profileId !== undefined && record.profileId !== request.profileId) continue;
        record.closing = true;
        cancelled += 1;
        try { for (const hop of record.hops) { hop.end(); } } catch {}
        record.hops = [];
        try { record.client?.end(); } catch {}
      }
      return { ok: true, value: { cancelled } };
    } catch (error) {
      return { ok: false, error: fail("cancel-connect-failed", error.message) };
    }
  }

  /** Connect a saved profile, run one command, then disconnect. Batch channel only. */
  async runCommandOnProfile(profileId, command, timeoutMs = 30000) {
    const record = this.requireProfileTable().get(profileId);
    if (record === undefined) return { ok: false, error: fail("no-profile", `SSH resource "${profileId}" does not exist`) };
    const connect = await this.profileConnect({ profileId });
    if (!connect.ok) return connect;
    const connectionId = connect.value.connectionId;
    try {
      const raw = await this.execRawOnClient(this.connections.get(connectionId).client, command, timeoutMs);
      if (!raw.ok) return raw;
      return { ok: true, value: { ...raw.value, profileId, name: record.name, host: record.host } };
    } catch (error) {
      return { ok: false, error: fail("exec-failed", error.message) };
    } finally {
      await this.disconnect({ connectionId }).catch(() => {});
    }
  }


  async groupList() {
    try {
      const groups = [...this.requireGroupTable().entries()]
        .map(([groupId, record]) => this.groupPublic(groupId, record))
        .sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));
      return { ok: true, value: { groups } };
    } catch (error) {
      return { ok: false, error: fail("group-list-failed", error.message) };
    }
  }

  async groupSave(request) {
    try {
      const table = this.requireGroupTable();
      const groupId = request.groupId ?? randomUUID();
      const previous = table.get(groupId);
      if (request.groupId !== undefined && previous === undefined) {
        return { ok: false, error: fail("no-group", `SSH group "${groupId}" does not exist`) };
      }
      const name = request.name.trim();
      if ([...table.entries()].some(([id, group]) => id !== groupId && group.name.localeCompare(name, "zh-Hans-CN", { sensitivity: "accent" }) === 0)) {
        return { ok: false, error: fail("duplicate-group", `SSH group "${name}" already exists`) };
      }
      const now = new Date().toISOString();
      const record = { name, createdAt: previous?.createdAt ?? now, updatedAt: now };
      await table.put(groupId, record);
      return { ok: true, value: { group: this.groupPublic(groupId, record) } };
    } catch (error) {
      return { ok: false, error: fail("group-save-failed", error.message) };
    }
  }

  async groupDelete(request) {
    try {
      const groups = this.requireGroupTable();
      if (groups.get(request.groupId) === undefined) return { ok: true, value: { deleted: false, movedProfiles: 0 } };
      const profiles = this.requireProfileTable();
      let movedProfiles = 0;
      for (const [profileId, profile] of profiles.entries()) {
        if (profile.groupId !== request.groupId) continue;
        movedProfiles += 1;
        await profiles.put(profileId, { ...profile, groupId: null, updatedAt: new Date().toISOString() });
      }
      await groups.delete(request.groupId);
      return { ok: true, value: { deleted: true, movedProfiles } };
    } catch (error) {
      return { ok: false, error: fail("group-delete-failed", error.message) };
    }
  }

  // ── known-hosts management (operator only; NOT exposed as agent tools) ────

  async listKnownHosts() {
    try {
      const hosts = this.knownHosts ? this.knownHosts.list() : [];
      return { ok: true, value: { hosts } };
    } catch (error) {
      return { ok: false, error: fail("known-hosts-list-failed", error.message) };
    }
  }

  async forgetHostKey(request) {
    try {
      if (this.knownHosts === null) {
        return { ok: false, error: fail("known-hosts-not-ready", "known-host storage is not ready") };
      }
      const forgotten = await this.knownHosts.forget(request.host, request.port);
      return { ok: true, value: { forgotten } };
    } catch (error) {
      return { ok: false, error: fail("forget-host-key-failed", error.message) };
    }
  }

  async openSession(request) {
    const conn = this.connections.get(request.connectionId);
    if (conn === void 0) return { ok: false, error: fail("no-connection", `connection "${request.connectionId}" does not exist`) };
    if (this.sessions.size >= MAX_SESSIONS) return { ok: false, error: fail("session-limit", `too many live sessions (${MAX_SESSIONS})`) };
    if (!(await this.ensureAlive(conn))) {
      return { ok: false, error: fail("connection-lost", `connection "${request.connectionId}" is down and could not be re-established`) };
    }
    const sessionId = randomUUID();
    const cols = request.cols ?? 80;
    const rows = request.rows ?? 24;
    const session = {
      id: sessionId,
      connectionId: request.connectionId,
      cols,
      rows,
      buffer: "",
      // Browser reads drain `buffer`. Retain a separate bounded capture for
      // an explicit ssh_read without coupling it to UI polling.
      captureBuffer: "",
      lastPrompt: null,
      waiters: [],
      streamListeners: new Set(),
      exited: null,
      stream: null,
      // The PTY receives keystrokes one at a time. Track the current command
      // locally, then allow or cancel it only when Enter is pressed.
      inputLine: "",
      inputKnown: true
    };
    this.sessions.set(sessionId, session);
    this.exitedSessions.delete(sessionId);
    conn.sessions.add(sessionId);
    try {
      const stream = await new Promise((resolve, reject) => {
        conn.client.shell({ term: "xterm-256color", cols, rows }, (error, s) => {
          if (error) reject(error);
          else resolve(s);
        });
      });
      session.stream = stream;
      stream.on("data", (chunk) => {
        this.appendSessionOutput(session, chunk.toString("utf8"));
      });
      stream.on("close", () => {
        this.recordExit(session, { code: 0 });
      });
      stream.on("error", () => {
        this.recordExit(session, { code: 1 });
      });
      // The panel opens this session immediately after a successful manual
      // connection. Remember it so agent tools can act on the same server
      // without making the model discover an opaque connection id first.
      this.activeConnectionId = request.connectionId;
    } catch (error) {
      this.sessions.delete(sessionId);
      conn.sessions.delete(sessionId);
      return { ok: false, error: fail("shell-failed", `could not open shell on connection "${request.connectionId}": ${error.message}`) };
    }
    return {
      ok: true,
      value: {
        sessionId,
        connectionId: request.connectionId,
        cols,
        rows,
        alive: true
      }
    };
  }

  async write(request) {
    const session = this.sessions.get(request.sessionId);
    if (session === void 0) return { ok: false, error: fail("no-session", `session "${request.sessionId}" does not exist`) };
    if (session.exited !== null || session.stream === null) return { ok: false, error: fail("exited", `session "${request.sessionId}" has already exited`) };
    let text;
    try {
      text = decodeData(request.data);
    } catch {
      return { ok: false, error: fail("bad-data", "input is not valid base64") };
    }
    try {
      if (text) {
        const pending = this.pendingForSession(session.id);
        if (pending) {
          // A card's Execute button is the only confirmation path for an
          // agent-originated dangerous command.  Keyboard Enter cannot submit
          // it, while Ctrl-C and any edit revoke the pending approval first.
          if (text === "\r" || text === "\n") {
            this.appendTerminalNotice(session, "此危险命令不会因回车执行：请使用面板弹出的确认卡片，点击“执行”或“撤销”。");
            return { ok: true, value: { written: 0 } };
          }
          if (text === "\x03") {
            this.removePendingConfirmation(pending.confirmationId);
            session.stream.write(text);
            session.inputLine = "";
            session.inputKnown = true;
            return { ok: true, value: { written: text.length } };
          }
          this.removePendingConfirmation(pending.confirmationId);
          // Clear the protected prefill before allowing the operator's new
          // input through.  From this point the terminal is fully manual.
          session.stream.write(`\x15${text}`);
          session.inputLine = "";
          session.inputKnown = true;
          this.updateInputMirror(session, text);
          return { ok: true, value: { written: text.length } };
        }
        // This path is interactive operator input. It remains intentionally
        // unguarded; agent calls use writeToConnection()/execOnConnection().
        session.stream.write(text);
        this.updateInputMirror(session, text);
      }
    } catch (error) {
      return { ok: false, error: fail("write-failed", error.message) };
    }
    return { ok: true, value: { written: text.length } };
  }

  /** Explicit UI action: refuse drafts, foreground jobs, and ambiguous PTYs. */
  async changeDirectory(request) {
    if (typeof request.path !== "string" || !request.path.startsWith("/") || /[\x00-\x1f\x7f]/.test(request.path)) {
      return { ok: false, error: fail("bad-path", "目录必须是绝对路径，且不能包含控制字符") };
    }
    const session = this.sessions.get(request.sessionId);
    const conn = session && this.connections.get(session.connectionId);
    const ready = () => session && conn && this.sessions.get(request.sessionId) === session
      && !conn.dead && !conn.closing && session.exited === null && session.stream
      && session.inputKnown === true && session.inputLine === ""
      && !this.pendingForSession(session.id) && conn.sessions.size === 1;
    if (!ready()) return { ok: false, error: fail("terminal-not-ready", "请先结束前台程序、清空未提交输入，并仅保留一个交互终端") };
    const revision = session.inputRevision ?? 0;
    const client = conn.client;
    try {
      if (!posixLoginShell(await this.resolveLoginShell(conn))) {
        return { ok: false, error: fail("unsupported-shell", "无法确认此 shell 的空闲状态，请在终端手动切换目录") };
      }
      const probe = await this.collectExecOutput(client, buildCwdAwareCommand(":"), 5000);
      if (probe.exitCode !== 0 || extractExecCwd(probe.stdout).cwd === null) {
        return { ok: false, error: fail("terminal-busy", "未确认空闲交互 shell，请结束前台程序后重试或手动 cd") };
      }
      if (!ready() || client !== conn.client || revision !== (session.inputRevision ?? 0)) {
        return { ok: false, error: fail("terminal-changed", "终端输入已变化，请检查后重试") };
      }
      const quoted = "'" + request.path.replace(/'/g, "'\\''") + "'";
      return this.write({ sessionId: session.id, data: encodeData(`cd -- ${quoted}\r`) });
    } catch (error) {
      return { ok: false, error: fail("cd-failed", error.message) };
    }
  }

  async read(request) {
    const session = this.sessions.get(request.sessionId);
    if (session === void 0) {
      const exit = this.exitedSessions.get(request.sessionId);
      if (exit !== void 0) return { ok: true, value: { data: "", exit } };
      return { ok: false, error: fail("no-session", `session "${request.sessionId}" does not exist`) };
    }
    // Cursor readers share the append-only journal. This keeps stream-to-poll
    // fallback exact and lets multiple panes observe the same bytes without
    // competing for a destructive buffer.
    if (request.after !== undefined) {
      const journal = this.terminalOutput(session);
      const available = journal.read(request.after);
      if (available.data !== "" || session.exited !== null) {
        return { ok: true, value: { ...available, data: encodeData(available.data), exit: session.exited } };
      }
      const timeoutMs = request.timeoutMs ?? this.config.defaultReadTimeoutMs;
      return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const index = session.waiters.indexOf(waiter);
          if (index >= 0) session.waiters.splice(index, 1);
          const item = journal.read(request.after);
          resolve({ ok: true, value: { ...item, data: encodeData(item.data), exit: session.exited } });
        };
        const timer = setTimeout(finish, timeoutMs);
        const waiter = { resolve: finish, timer, cursor: true };
        session.waiters.push(waiter);
      });
    }
    if (session.exited !== null) {
      return { ok: true, value: { data: this.drain(session), exit: session.exited } };
    }
    const pending = this.drain(session);
    if (pending !== "") {
      return { ok: true, value: { data: pending, exit: null } };
    }
    const timeoutMs = request.timeoutMs ?? this.config.defaultReadTimeoutMs;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const index = session.waiters.indexOf(waiter);
        if (index >= 0) session.waiters.splice(index, 1);
        resolve(value);
      };
      const timer = setTimeout(() => {
        finish({ ok: true, value: { data: this.drain(session), exit: null } });
      }, timeoutMs);
      const waiter = { resolve: finish, timer };
      session.waiters.push(waiter);
    });
  }

  /**
   * Stream-push terminal output (typert mode:'stream', WebSocket mux carrier).
   * Each yielded item reuses the read() envelope so the client render path is
   * identical to polling; items are validated by the gateway against the
   * descriptor's strict result codec. Ends when the session exits or the
   * caller's AbortSignal fires — the client falls back to 300ms polling if the
   * stream can't be opened or breaks.
   */
  async *terminalStream(request, signal) {
    const session = this.sessions.get(request.sessionId);
    if (session === void 0) {
      yield { ok: false, error: fail("no-session", `session "${request.sessionId}" does not exist`) };
      return;
    }
    const journal = this.terminalOutput(session);
    const listener = { wake: null, timer: null };
    session.streamListeners ??= new Set();
    session.streamListeners.add(listener);
    let cursor = request.after;
    const abort = () => listener.wake?.();
    signal?.addEventListener("abort", abort);
    try {
      let heartbeatFired = false;
      while (!signal?.aborted) {
        const item = journal.read(cursor);
        const exit = session.exited;
        if (item.data !== "" || exit !== null || heartbeatFired) {
          cursor = item.offset;
          yield { ok: true, value: { ...item, data: encodeData(item.data), exit } };
        }
        if (exit !== null || signal?.aborted) return;
        // Output can arrive while suspended at yield. Do not sleep over it.
        if (journal.read(cursor).data !== "") continue;
        heartbeatFired = false;
        await new Promise((resolve) => {
          listener.wake = resolve;
          listener.timer = setTimeout(() => {
            heartbeatFired = true;
            resolve();
          }, this.config.streamHeartbeatMs);
        });
        listener.wake = null;
        clearTimeout(listener.timer);
        listener.timer = null;
      }
    } finally {
      clearTimeout(listener.timer);
      session.streamListeners.delete(listener);
      signal?.removeEventListener("abort", abort);
      // History belongs to the session, not its readers. No per-reader
      // copyback: simultaneous cancellations cannot duplicate output.
    }
  }

  terminalOutput(session) {
    session.outputJournal ??= createTerminalOutput(session.buffer ?? "", this.config.maxBufferBytes);
    return session.outputJournal;
  }

  pendingConfirmationList() {
    return {
      ok: true,
      value: {
        confirmations: [...this.pendingConfirmations.values()]
          .map((item) => this.publicPendingConfirmation(item))
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      }
    };
  }

  batchPlan(request) {
    const decision = assessShellCommand(request.command);
    // Clamp here, not just in the RPC schema: the ssh_batch tool calls this
    // method directly and bypasses zod, so an agent-supplied timeout_ms must
    // still land inside the 1s–120s window.
    const timeoutMs = Math.min(120000, Math.max(1000, request.timeoutMs ?? 30000));
    const task = {
      batchId: randomUUID(),
      command: request.command.trim(),
      timeoutMs,
      dangerous: !decision.ok,
      reason: decision.ok ? null : (decision.category ?? decision.reason),
      createdAt: new Date().toISOString()
    };
    this.batchTasks.set(task.batchId, task);
    return { ok: true, value: { task } };
  }

  batchTaskList() {
    return { ok: true, value: { tasks: [...this.batchTasks.values()] } };
  }

  async batchRun(request) {
    const task = this.batchTasks.get(request.batchId);
    if (!task) return { ok: false, error: fail("batch-missing", `批量任务 "${request.batchId}" 不存在或已执行`) };
    if (request.profileIds.length === 0) return { ok: false, error: fail("batch-no-targets", "未选择任何服务器") };
    this.batchTasks.delete(request.batchId);
    // Fixed worker pool over the target list; results keep the requested order
    // via index-addressed slots.
    const targets = request.profileIds;
    const results = new Array(targets.length);
    let next = 0;
    const worker = async () => {
      while (next < targets.length) {
        const index = next++;
        const profileId = targets[index];
        try {
          const r = await this.runCommandOnProfile(profileId, task.command, task.timeoutMs);
          if (!r.ok) results[index] = { profileId, name: "", host: "", ok: false, exitCode: null, stdout: "", stderr: "", error: r.error.message };
          else results[index] = { profileId, name: r.value.name, host: r.value.host, ok: true, exitCode: r.value.exitCode, stdout: r.value.stdout, stderr: r.value.stderr, error: null };
        } catch (error) {
          results[index] = { profileId, name: "", host: "", ok: false, exitCode: null, stdout: "", stderr: "", error: error.message };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(BATCH_MAX_CONCURRENCY, targets.length) }, () => worker()));
    return { ok: true, value: { results } };
  }

  batchCancel(request) {
    const cancelled = this.batchTasks.delete(request.batchId);
    return { ok: true, value: { cancelled } };
  }

  pendingConfirmationApprove(request) {
    const pending = this.pendingConfirmations.get(request.confirmationId);
    if (!pending) return { ok: false, error: fail("confirmation-missing", "待确认命令不存在或已处理") };
    const session = this.sessions.get(pending.sessionId);
    if (!session || session.exited !== null || session.stream === null) {
      this.removePendingConfirmation(pending.confirmationId);
      return { ok: false, error: fail("confirmation-session-closed", "终端已关闭，无法执行待确认命令") };
    }
    if (pending.prefilled && (!session.inputKnown || session.inputLine !== pending.command)) {
      this.removePendingConfirmation(pending.confirmationId);
      return { ok: false, error: fail("confirmation-modified", "终端命令已变化，待确认项已作废") };
    }
    try {
      this.removePendingConfirmation(pending.confirmationId);
      // Clear any text the operator may have typed, then send the command +
      // Enter.  Without the line-kill the command would concatenate onto
      // unsaved input and produce a garbled, unsafe shell line.
      session.stream.write(`\x15${pending.command}\r`);
      session.inputLine = "";
      session.inputKnown = true;
      return { ok: true, value: { executed: true } };
    } catch (error) {
      return { ok: false, error: fail("confirmation-execute-failed", error.message) };
    }
  }

  pendingConfirmationCancel(request) {
    const pending = this.pendingConfirmations.get(request.confirmationId);
    if (!pending) return { ok: false, error: fail("confirmation-missing", "待确认命令不存在或已处理") };
    const session = this.sessions.get(pending.sessionId);
    this.removePendingConfirmation(pending.confirmationId);
    if (pending.prefilled && session && session.exited === null && session.stream !== null) {
      try { session.stream.write("\x15"); } catch {}
      session.inputLine = "";
      session.inputKnown = true;
    }
    return { ok: true, value: { cancelled: true } };
  }

  /** The one protected line currently visible in a terminal, if any. */
  pendingForSession(sessionId) {
    for (const pending of this.pendingConfirmations.values()) {
      if (pending.sessionId === sessionId && pending.prefilled) return pending;
    }
    return null;
  }

  removePendingConfirmation(confirmationId) {
    this.pendingConfirmations.delete(confirmationId);
  }

  removePendingForSession(sessionId) {
    for (const [confirmationId, pending] of this.pendingConfirmations) {
      if (pending.sessionId === sessionId) this.pendingConfirmations.delete(confirmationId);
    }
  }

  publicPendingConfirmation(pending) {
    return {
      confirmationId: pending.confirmationId,
      connectionId: pending.connectionId,
      sessionId: pending.sessionId,
      ...(pending.name ? { name: pending.name } : {}),
      host: pending.host,
      command: pending.command,
      reason: pending.reason,
      createdAt: pending.createdAt,
      prefilled: pending.prefilled
    };
  }

  async resize(request) {
    const session = this.sessions.get(request.sessionId);
    if (session === void 0) return { ok: false, error: fail("no-session", `session "${request.sessionId}" does not exist`) };
    if (session.stream === null || session.exited !== null) return { ok: false, error: fail("exited", `session "${request.sessionId}" is not alive`) };
    try {
      session.stream.setWindow(request.rows, request.cols);
    } catch (error) {
      return { ok: false, error: fail("resize-failed", error.message) };
    }
    session.cols = request.cols;
    session.rows = request.rows;
    return { ok: true, value: { cols: request.cols, rows: request.rows } };
  }

  async closeSession(request) {
    const session = this.sessions.get(request.sessionId);
    if (session === void 0) return { ok: false, error: fail("no-session", `session "${request.sessionId}" does not exist`) };
    this.sessions.delete(request.sessionId);
    this.removePendingForSession(request.sessionId);
    const conn = this.connections.get(session.connectionId);
    if (conn) conn.sessions.delete(request.sessionId);
    if (session.exited === null && session.stream !== null) {
      try { session.stream.end(); } catch {}
      session.exited = { code: 0 };
    }
    this.rememberExit(request.sessionId, session.exited ?? { code: 0 });
    return { ok: true, value: { closed: true } };
  }

  async disconnect(request) {
    const conn = this.connections.get(request.connectionId);
    if (conn === void 0) return { ok: false, error: fail("no-connection", `connection "${request.connectionId}" does not exist`) };
    // Explicit disconnect: never auto-reconnect, and stop any in-flight one.
    conn.closing = true;
    if (conn.reconnectTimer !== null) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }
    for (const sessionId of [...conn.sessions]) {
      const session = this.sessions.get(sessionId);
      if (session) {
        this.sessions.delete(sessionId);
        this.removePendingForSession(sessionId);
        if (session.exited === null && session.stream !== null) {
          try { session.stream.end(); } catch {}
          session.exited = { code: 0 };
        }
        this.rememberExit(sessionId, session.exited ?? { code: 0 });
      }
    }
    conn.sessions.clear();
    this.connections.delete(request.connectionId);
    if (this.activeConnectionId === request.connectionId) {
      this.activeConnectionId = null;
    }
    try { conn.client.end(); } catch {}
    for (const hop of conn.hops ?? []) { try { hop.end(); } catch {} }
    conn.hops = [];
    return { ok: true, value: { disconnected: true } };
  }

  // ── Database ops (proxied to DbOpsManager) ─────────────────────────────────

  async dbConnect(request) {
    return this.dbOps.connect(request);
  }

  async dbListConnections(request) {
    return this.dbOps.list(request);
  }

  async dbQuery(request) {
    return this.dbOps.query(request);
  }

  async dbExecute(request) {
    return this.dbOps.execute(request);
  }

  async dbListTables(request) {
    return this.dbOps.listTables(request);
  }

  async dbDescribeTable(request) {
    return this.dbOps.describeTable(request);
  }

  async dbRun(request) {
    return this.dbOps.run(request);
  }

  async dbDisconnect(request) {
    return this.dbOps.disconnect(request);
  }

  async dbPreview(request) {
    return this.dbOps.preview(request);
  }

  async dbExplain(request) {
    return this.dbOps.explain(request);
  }

  async dbTxBegin(request) {
    return this.dbOps.dbTxBegin(request);
  }

  async dbTxExecute(request) {
    return this.dbOps.dbTxExecute(request);
  }

  async dbTxCommit(request) {
    return this.dbOps.dbTxCommit(request);
  }

  async dbTxRollback(request) {
    return this.dbOps.dbTxRollback(request);
  }

  // ── Database profile CRUD (durable connections) ────────────────────────────

  requireDbProfileTable() {
    if (this.dbProfileTable === null) throw new Error("DB profile storage is not ready");
    return this.dbProfileTable;
  }

  async dbProfilePublic(dbProfileId, record) {
    const refs = dbProfileCredentialRefs(dbProfileId);
    const cred = await this.ctx.credentials.describe(credentialRef(refs.password));
    const connected = [...this.dbOps.dbConnections.values()].some((c) => c.config.name === record.name);
    return {
      dbProfileId,
      name: record.name,
      type: record.type,
      host: record.host,
      port: record.port,
      database: record.database,
      username: record.username,
      ssl: record.ssl,
      sshProfileId: record.sshProfileId,
      credentialConfigured: cred.configured,
      connected
    };
  }

  async dbProfileList() {
    try {
      const profiles = await Promise.all(
        [...this.requireDbProfileTable().entries()].map(async ([id, rec]) => await this.dbProfilePublic(id, rec))
      );
      profiles.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
      return { ok: true, value: { profiles } };
    } catch (error) {
      return { ok: false, error: fail("db-profile-list-failed", error.message) };
    }
  }

  async dbProfileSave(request) {
    try {
      const table = this.requireDbProfileTable();
      const dbProfileId = request.dbProfileId ?? randomUUID();
      const previous = table.get(dbProfileId);
      if (request.dbProfileId !== undefined && previous === undefined) {
        return { ok: false, error: fail("no-db-profile", `DB profile "${dbProfileId}" does not exist`) };
      }
      const now = new Date().toISOString();
      const record = {
        name: request.name.trim(),
        type: request.type,
        host: request.host.trim(),
        port: request.port,
        database: request.database?.trim() || null,
        username: request.username?.trim() || null,
        ssl: request.ssl ?? "disabled",
        sshProfileId: request.sshProfileId || null,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now
      };
      await table.put(dbProfileId, record);
      // If a password was provided, store it as an encrypted credential.
      if (request.password !== undefined && request.password.length > 0) {
        const refs = dbProfileCredentialRefs(dbProfileId);
        await this.ctx.credentials.set(credentialRef(refs.password), request.password);
      }
      return {
        ok: true,
        value: {
          profile: await this.dbProfilePublic(dbProfileId, record),
          credentialRefs: dbProfileCredentialRefs(dbProfileId)
        }
      };
    } catch (error) {
      return { ok: false, error: fail("db-profile-save-failed", error.message) };
    }
  }

  async dbProfileDelete(request) {
    try {
      const table = this.requireDbProfileTable();
      const record = table.get(request.dbProfileId);
      if (record === undefined) return { ok: true, value: { deleted: false } };
      const refs = dbProfileCredentialRefs(request.dbProfileId);
      await Promise.all(Object.values(refs).map(async (ref) => await this.ctx.credentials.unset(credentialRef(ref))));
      await table.delete(request.dbProfileId);
      return { ok: true, value: { deleted: true } };
    } catch (error) {
      return { ok: false, error: fail("db-profile-delete-failed", error.message) };
    }
  }

  async dbProfileConnect(request) {
    try {
      const record = this.requireDbProfileTable().get(request.dbProfileId);
      if (record === undefined) return { ok: false, error: fail("no-db-profile", `DB profile "${request.dbProfileId}" does not exist`) };
      const refs = dbProfileCredentialRefs(request.dbProfileId);
      const cred = await this.ctx.credentials.resolve(credentialRef(refs.password));
      // Resolve SSH tunnel: if sshProfileId is set, find a live SSH connection
      // for that profile, or connect it first.
      let sshConnectionId = undefined;
      if (record.sshProfileId) {
        const sshConn = [...this.connections.values()].find((c) => c.profileId === record.sshProfileId);
        if (sshConn) {
          sshConnectionId = sshConn.id;
        } else {
          // Auto-connect the SSH profile to establish the tunnel.
          const sshResult = await this.profileConnect({ profileId: record.sshProfileId });
          if (!sshResult.ok) return sshResult;
          sshConnectionId = sshResult.value.connectionId;
        }
      }
      const result = await this.dbOps.connect({
        type: record.type,
        host: record.host,
        port: record.port,
        database: record.database ?? undefined,
        username: record.username ?? undefined,
        password: cred?.value,
        ssl: record.ssl,
        sshConnectionId,
        name: record.name
      });
      if (!result.ok) return result;
      // Tag the db connection with the profile name for connected-status lookup.
      const dbRecord = this.dbOps.dbConnections.get(result.value.dbConnectionId);
      if (dbRecord) dbRecord.config.name = record.name;
      return result;
    } catch (error) {
      return { ok: false, error: fail("db-profile-connect-failed", error.message) };
    }
  }

  // ── Agent-facing helpers (called directly by tools, not over the wire) ────

  /**
   * Run one command over a dedicated exec channel on a connection. The
   * command line and its output are ALSO appended to the connection's shell
   * session buffers (if any), so the panel shows what the agent did.
   */

  /**
   * Run one command over a dedicated exec channel. No policy gate and no
   * terminal mirror: used by the batch channel, where the operator already
   * confirmed the command against a chosen server list. Returns raw output.
   */
  /**
   * Open one non-interactive exec channel and collect stdout/stderr until the
   * channel closes or the timeout fires (then the channel is closed and the
   * timeout flag set). Shared by the batch channel (raw) and the agent
   * ssh_exec path (mirrored into the panel terminal).
   */
  async collectExecOutput(client, command, timeoutMs) {
    const stream = await new Promise((resolve, reject) => {
      client.exec(command, { pty: false }, (error, s) => {
        if (error) reject(error);
        else resolve(s);
      });
    });
    const state = { exitCode: null, stdout: "", stderr: "", truncated: false, timedOut: false };
    const timer = setTimeout(() => {
      state.timedOut = true;
      try { stream.close(); } catch {}
    }, timeoutMs);
    await new Promise((resolve) => {
      stream.on("data", (chunk) => {
        const result = appendCapped(state.stdout, chunk.toString("utf8"), this.config.maxCommandOutputBytes);
        state.stdout = result.text;
        state.truncated ||= result.truncated;
      });
      stream.stderr.on("data", (chunk) => {
        const result = appendCapped(state.stderr, chunk.toString("utf8"), this.config.maxCommandOutputBytes);
        state.stderr = result.text;
        state.truncated ||= result.truncated;
      });
      stream.on("close", (code) => {
        clearTimeout(timer);
        state.exitCode = typeof code === "number" ? code : null;
        resolve();
      });
      stream.on("error", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return state;
  }

  async execRawOnClient(client, command, timeoutMs = 30000) {
    try {
      return { ok: true, value: await this.collectExecOutput(client, command, timeoutMs) };
    } catch (error) {
      return { ok: false, error: fail("exec-failed", error.message) };
    }
  }

  /**
   * One-time probe of the connection's login shell — the binary sshd runs for
   * exec channels — cached on the connection record. `echo $SHELL` is a bare
   * variable expansion valid in every shell family, so the probe itself never
   * breaks fish/csh; unknown or exotic families keep the plain-exec behavior.
   * A transient probe failure clears itself so a later exec can retry.
   */
  resolveLoginShell(conn) {
    if (conn.loginShell !== undefined) return Promise.resolve(conn.loginShell);
    if (conn.loginShellProbe === undefined) {
      conn.loginShellProbe = this.collectExecOutput(conn.client, "echo $SHELL", 10000)
        .then((state) => {
          const name = state.stdout.trim().split("/").pop() ?? "";
          conn.loginShell = name.length > 0 ? name.toLowerCase() : null;
        })
        .catch(() => {
          // Leave loginShell undefined: the next exec re-probes once the
          // transport is healthy again. This call keeps the plain behavior.
          conn.loginShellProbe = undefined;
        });
    }
    return conn.loginShellProbe.then(() => conn.loginShell);
  }

  async execOnConnection(connectionId, command, timeoutMs = 30000, retried = false) {
    const decision = assessShellCommand(command);
    if (!decision.ok) return this.prefillBlockedResult(connectionId, command, decision.category ?? decision.reason);
    const conn = this.connections.get(connectionId);
    if (conn === void 0) return { ok: false, error: fail("no-connection", `connection "${connectionId}" does not exist`) };
    if (!(await this.ensureAlive(conn))) {
      return { ok: false, error: fail("connection-lost", `connection "${connectionId}" is down and could not be re-established`) };
    }
    // An exec channel always starts in the login home directory — the panel's
    // interactive shell may be somewhere else entirely. When the login shell
    // is POSIX-family, prepend the interactive-cwd prologue (see exec-cwd.js)
    // so the command runs where the operator's terminal is, and the resolved
    // directory comes back on a stripped marker line.
    const shell = await this.resolveLoginShell(conn);
    const sent = posixLoginShell(shell) ? buildCwdAwareCommand(command) : command;
    const commandId = randomUUID();
    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();
    let state;
    try {
      state = await this.collectExecOutput(conn.client, sent, timeoutMs);
    } catch (error) {
      // The transport may have died between the liveness check and the exec.
      // Wait for the self-healing reconnect and retry once transparently.
      if (!retried && conn.dead && (await this.ensureAlive(conn))) {
        return this.execOnConnection(connectionId, command, timeoutMs, true);
      }
      return { ok: false, error: fail("exec-failed", error.message) };
    }
    const { cwd, stdout } = extractExecCwd(state.stdout);
    const { stderr } = state;
    if (state.exitCode === 125 && cwd === null && stderr.startsWith(EXEC_CWD_ERROR_PREFIX)) {
      return { ok: false, error: fail("cwd-unavailable", stderr.trim()) };
    }
    // Mirror the command and output into every live shell session of this
    // connection so the panel displays agent-driven commands too. No steady-
    // state label: the `$ ` prefix is the established agent marker and, with
    // the cwd inherited, output is consistent with the visible prompt. A dim
    // warning appears only in the fallback case (cwd undetected — the exec
    // ran from the home directory, so output may contradict the prompt).
    const warning = execEchoWarning(cwd);
    const display = normalizeTerminalEol(`${warning ? `${warning}\n` : ""}$ ${command}\n${stdout}${stderr.length > 0 ? stderr : ""}`)
      .replace(/(?:\r\n)+$/, "");
    for (const sessionId of conn.sessions) {
      const session = this.sessions.get(sessionId);
      if (session && session.exited === null) {
        const prompt = session.lastPrompt ?? this.fallbackPrompt(conn);
        // exec() is a separate non-interactive SSH channel. It never makes
        // the PTY shell emit a prompt, so restore the last real prompt here.
        this.appendSessionOutput(session, `${display}\r\n${prompt}`, { capture: false, observePrompt: false });
      }
    }
    return {
      ok: true,
      value: {
        exitCode: state.exitCode,
        stdout,
        stderr,
        cwd,
        display,
        commandId,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
        truncated: state.truncated,
        timedOut: state.timedOut
      }
    };
  }

  /**
   * Prefill a blocked command into the first live interactive terminal session
   * of a connection WITHOUT submitting it (no Enter). Returns whether the
   * command was actually prefilled (false when no live session is open or the
   * command contains control characters that would be unsafe to send to a PTY).
   * The operator — never the agent — is the one who presses Enter.
   */
  prefillBlockedCommand(connectionId, command, reason = DANGEROUS_DEFAULT_REASON) {
    // Agent tools commonly omit connection_id to mean the selected right-side
    // server. Resolve it here so safety confirmations follow exactly the same
    // current-connection semantics as ssh_exec and the other SFTP tools.
    const effectiveConnectionId = connectionId ?? this.activeConnectionId;
    const conn = this.connections?.get(effectiveConnectionId);
    if (!conn) return { queued: false, prefilled: false };
    for (const sessionId of conn.sessions ?? []) {
      const session = this.sessions.get(sessionId);
      if (session && session.exited === null && session.stream !== null) {
        if (isPrefillable(command)) {
          // The command is queued for confirmation but NOT written to the
          // terminal input line.  This avoids the contradiction of a visible
          // command that Enter cannot submit — the only execution path is the
          // panel's Execute button, which sends the full command + Enter.
          const confirmation = {
            confirmationId: randomUUID(),
            connectionId: effectiveConnectionId,
            sessionId: session.id,
            name: conn.name,
            host: conn.host,
            command,
            reason,
            createdAt: new Date().toISOString(),
            prefilled: false
          };
          this.pendingConfirmations.set(confirmation.confirmationId, confirmation);
          this.appendTerminalNotice(session, `危险命令已被拦截并弹出确认卡片，请在右侧 SSH 面板点击“执行”或“撤销”：${command}`);
          return { queued: true, prefilled: false, confirmationId: confirmation.confirmationId };
        }
        return { queued: false, prefilled: false };
      }
    }
    return { queued: false, prefilled: false };
  }

  /**
   * Build the ssh_exec result for a blocked destructive command: prefilled into
   * the terminal when possible, otherwise a copyable command card.
   */
  prefillBlockedResult(connectionId, command, reason) {
    const pending = this.prefillBlockedCommand(connectionId, command, reason);
    const now = new Date().toISOString();
    return {
      blocked: true,
      value: {
        exitCode: null,
        stdout: "",
        stderr: "",
        cwd: null,
        commandId: "(blocked)",
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        truncated: false,
        timedOut: false,
        blocked: true,
        reason,
        command,
        prefilled: pending.prefilled,
        queued: pending.queued
      }
    };
  }

  /** Send raw input into every live shell session of a connection. */
  writeToConnection(connectionId, input) {
    const conn = this.connections.get(connectionId);
    if (conn === void 0) return { ok: false, error: fail("no-connection", `connection "${connectionId}" does not exist`) };
    let written = 0;
    let blockedReason = null;
    for (const sessionId of conn.sessions) {
      const session = this.sessions.get(sessionId);
      if (session && session.exited === null && session.stream !== null) {
        try {
          const guarded = this.prepareTerminalInput(session, input);
          if (guarded.forwarded) session.stream.write(guarded.forwarded);
          written += guarded.forwarded.length;
          blockedReason ??= guarded.blockedReason;
        } catch {}
      }
    }
    if (blockedReason) return { ok: false, error: fail("unsafe-command", blockedReason) };
    return { ok: true, value: { written } };
  }

  /** Add a local policy notice to the same buffer rendered by the terminal. */
  appendTerminalNotice(session, message) {
    this.appendSessionOutput(session, `\r\n\x1b[33m${POLICY_NOTICE_PREFIX} ${message}\x1b[0m\r\n`);
  }

  /**
   * Preserve normal terminal editing, but submit a line only after host-side
   * policy approval. A denied line is cleared with Ctrl-U before the shell can
   * execute it. History navigation and tab completion fail closed as well.
   */
  prepareTerminalInput(session, text) {
    session.inputRevision = (session.inputRevision ?? 0) + 1;
    const { forwarded, blockedReason } = processTerminalInput(session, text, (line) => assessShellCommand(line));
    if (blockedReason !== null) this.appendTerminalNotice(session, blockedReason);
    return { forwarded, blockedReason };
  }

  /**
   * Keep the local input-line mirror in sync with raw operator input written
   * directly to the PTY (the interactive browser terminal path). The agent's
   * prepareTerminalInput() gate relies on this mirror; without syncing it
   * here, a human-typed destructive line would be invisible to the gate and a
   * later agent-driven Enter could submit it. Mirrors the per-char tracking of
   * prepareTerminalInput but never blocks or rewrites — the operator is trusted
   * on this path, only the mirror is kept honest.
   */
  updateInputMirror(session, text) {
    session.inputRevision = (session.inputRevision ?? 0) + 1;
    if (typeof text !== "string") return;
    if (session.inputLine === undefined) session.inputLine = "";
    if (session.inputKnown === undefined) session.inputKnown = true;
    processTerminalInput(session, text, null);
  }

  /** Current buffered text of a connection's first live shell session. */
  readConnectionOutput(connectionId) {
    const conn = this.connections.get(connectionId);
    if (conn === void 0) return { ok: false, error: fail("no-connection", `connection "${connectionId}" does not exist`) };
    const first = [...conn.sessions].map((id) => this.sessions.get(id)).find((s) => s !== void 0 && s.exited === null);
    if (first === void 0) {
      return { ok: true, value: { data: "", hasSession: false, truncated: false, redacted: false } };
    }
    const redaction = redactForModel(first.captureBuffer);
    return {
      ok: true,
      value: {
        data: redaction.text,
        hasSession: true,
        truncated: Buffer.byteLength(first.captureBuffer, "utf8") >= this.config.maxCaptureBytes,
        redacted: redaction.redacted
      }
    };
  }

  /**
   * Select the connection represented by the right-side terminal. For a
   * single connection, fall back to it so a normal conversational request
   * never has to expose an implementation-only UUID to the user.
   */
  resolveConnection(connectionId) {
    if (connectionId !== undefined) {
      const connection = this.connections.get(connectionId);
      if (connection !== undefined) return { ok: true, connectionId, connection };
      return { ok: false, error: fail("no-connection", `connection "${connectionId}" does not exist`) };
    }
    if (this.activeConnectionId !== null) {
      const connection = this.connections.get(this.activeConnectionId);
      if (connection !== undefined) {
        return { ok: true, connectionId: this.activeConnectionId, connection };
      }
      this.activeConnectionId = null;
    }
    if (this.connections.size === 1) {
      const [resolvedId, connection] = this.connections.entries().next().value;
      return { ok: true, connectionId: resolvedId, connection };
    }
    if (this.connections.size === 0) {
      return { ok: false, error: fail("no-connection", "no active SSH connection; connect a server in the SSH panel first") };
    }
    return { ok: false, error: fail("connection-selection-required", "multiple SSH connections are open; select a server in the SSH panel or provide connection_id") };
  }

  // ── SFTP (file management) ─────────────────────────────────────────────────

  /** Lazily open (or reuse) the sftp subsystem of a connection. */
  async requireSftp(connection, retried = false) {
    if (connection.sftp !== null) return { ok: true, sftp: connection.sftp };
    if (!(await this.ensureAlive(connection))) {
      return { ok: false, error: fail("connection-lost", `connection "${connection.id}" is down and could not be re-established`) };
    }
    try {
      const sftp = await new Promise((resolve, reject) => {
        connection.client.sftp((error, s) => {
          if (error) reject(error);
          else resolve(s);
        });
      });
      connection.sftp = sftp;
      return { ok: true, sftp };
    } catch (error) {
      if (!retried && connection.dead && (await this.ensureAlive(connection))) {
        return this.requireSftp(connection, true);
      }
      return { ok: false, error: fail("sftp-failed", `could not open SFTP subsystem: ${error.message}`) };
    }
  }

  /** List one remote directory: entries with type, size, mtime, and mode. */
  async sftpList(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    const remotePath = request.path || ".";
    try {
      const entries = await new Promise((resolve, reject) => {
        sftp.sftp.readdir(remotePath, (error, list) => {
          if (error) reject(error);
          else resolve(list);
        });
      });
      const items = entries.map((entry) => ({
        name: entry.filename,
        isDirectory: (entry.attrs.mode & 0o170000) === 0o040000,
        size: entry.attrs.size,
        mtime: entry.attrs.mtime * 1000,
        mode: entry.attrs.mode
      }));
      return { ok: true, value: { path: remotePath, entries: items } };
    } catch (error) {
      return { ok: false, error: fail("sftp-list-failed", `${remotePath}: ${error.message}`) };
    }
  }

  /** Stat one remote path. */
  async sftpStat(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    try {
      const attrs = await new Promise((resolve, reject) => {
        sftp.sftp.stat(request.path, (error, a) => {
          if (error) reject(error);
          else resolve(a);
        });
      });
      return {
        ok: true,
        value: {
          path: request.path,
          isDirectory: (attrs.mode & 0o170000) === 0o040000,
          size: attrs.size,
          mtime: attrs.mtime * 1000,
          mode: attrs.mode
        }
      };
    } catch (error) {
      return { ok: false, error: fail("sftp-stat-failed", `${request.path}: ${error.message}`) };
    }
  }

  /** Read a remote file as base64 (bounded; large files spill a hint). */
  async sftpReadFile(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    const maxBytes = request.maxBytes ?? MAX_FILE_READ_BYTES;
    const chunks = [];
    let total = 0;
    try {
      const stream = sftp.sftp.createReadStream(request.path);
      const done = new Promise((resolve, reject) => {
        stream.on("data", (chunk) => {
          total += chunk.length;
          if (total <= maxBytes) chunks.push(chunk);
        });
        stream.on("end", resolve);
        stream.on("error", reject);
      });
      await done;
      const truncated = total > maxBytes;
      const data = Buffer.concat(chunks).toString("base64");
      return { ok: true, value: { path: request.path, data, truncated, bytes: total } };
    } catch (error) {
      return { ok: false, error: fail("sftp-read-failed", `${request.path}: ${error.message}`) };
    }
  }

  /** Write base64 content to a remote file. */
  async sftpWriteFile(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    try {
      const buf = Buffer.from(request.data, "base64");
      await new Promise((resolve, reject) => {
        const stream = sftp.sftp.createWriteStream(request.path);
        stream.on("close", resolve);
        stream.on("error", reject);
        stream.end(buf);
      });
      return { ok: true, value: { path: request.path, bytes: buf.length } };
    } catch (error) {
      return { ok: false, error: fail("sftp-write-failed", `${request.path}: ${error.message}`) };
    }
  }

  // ── Streaming file plane (workbench S6 patch) ──────────────────────────────
  // HTTP byte routes over this service's own connections: callers address an
  // existing connectionId, so profile/credential/connection/host-key lifecycle
  // is fully reused and the ssh2 Client never leaves this class. Errors mirror
  // the typert business envelope ({ok:false,error:{code,message}}) with an HTTP
  // status for the transport-level outcome; success replies are {ok:true,value}.

  /** Route entry: auth fence first, then path/method dispatch. */
  handleStreamRoute(req, res, connection) {
    const rejection = connection.requestRejection(req);
    if (rejection !== void 0) {
      res.writeHead(rejection, { "content-type": "text/plain; charset=utf-8" });
      res.end(rejection === 401 ? "unauthorized" : "forbidden");
      return;
    }
    let url;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      this.streamJson(res, 400, "bad-request", "invalid request URL");
      return;
    }
    const connectionId = url.searchParams.get("connectionId");
    if (connectionId === null || connectionId === "") {
      this.streamJson(res, 400, "bad-request", "connectionId query parameter is required");
      return;
    }
    if (url.pathname === `${STREAM_ROUTE_PREFIX}/file`) {
      if (req.method === "GET") return this.streamGuard(res, this.streamDownloadFile(req, res, url, connectionId));
      if (req.method === "PUT") return this.streamGuard(res, this.streamUploadFile(req, res, url, connectionId));
    } else if (url.pathname === `${STREAM_ROUTE_PREFIX}/archive` && req.method === "GET") {
      return this.streamGuard(res, this.streamDownloadArchive(req, res, url, connectionId));
    }
    this.streamJson(res, 405, "method-not-allowed", `${req.method} ${url.pathname} is not served`, { allow: "GET, PUT" });
  }

  /** Last-resort guard: unexpected throw → 502 envelope (or truncated body). */
  streamGuard(res, promise) {
    promise.catch((error) => {
      this.streamJson(res, 502, "stream-failed", error instanceof Error ? error.message : String(error));
    });
  }

  /** Business-envelope JSON reply (only valid before any body byte is sent). */
  streamJson(res, status, code, message, headers = {}) {
    if (res.destroyed || res.headersSent || res.writableEnded) {
      if (!res.destroyed) res.destroy();
      return;
    }
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify({ ok: false, error: { code, message } }));
  }

  /** resolveConnection/requireSftp failure → 404 (gone) or 502 (transport). */
  streamReplyFailure(res, failure) {
    const code = failure?.error?.code ?? "stream-failed";
    const message = failure?.error?.message ?? "streaming file operation failed";
    this.streamJson(res, code === "no-connection" || code === "connection-lost" ? 404 : 502, code, message);
  }

  /** Connection + live SFTP subsystem, or a mapped error reply and null. */
  async streamPrepareSftp(res, connectionId) {
    const selected = this.resolveConnection(connectionId);
    if (!selected.ok) {
      this.streamReplyFailure(res, selected);
      return null;
    }
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) {
      this.streamReplyFailure(res, sftp);
      return null;
    }
    return { connection: selected.connection, sftp: sftp.sftp };
  }

  /** stat → attrs, or a 404/502 reply and null (not-found by message, sftpList convention). */
  async streamStat(res, sftp, remotePath) {
    try {
      return await new Promise((resolve, reject) => {
        sftp.stat(remotePath, (error, attrs) => (error ? reject(error) : resolve(attrs)));
      });
    } catch (error) {
      this.streamJson(res, /No such file/i.test(error.message) ? 404 : 502, "sftp-stat-failed", `${remotePath}: ${error.message}`);
      return null;
    }
  }

  /**
   * Await the ssh2 stream 'open' event (SFTP ReadStream and WriteStream both
   * emit it) so handle-open failures stay replyable as JSON envelopes.
   * @returns the open error, or null on success.
   */
  streamAwaitOpen(stream) {
    return new Promise((resolve) => {
      let settled = false;
      stream.once("open", () => {
        if (!settled) { settled = true; resolve(null); }
      });
      stream.once("error", (error) => {
        if (!settled) { settled = true; resolve(error); }
      });
    });
  }

  /**
   * Active streaming-upload registry keyed by connectionId. A cancelled PUT can
   * go unobserved by request events (unread body masks the client FIN), so
   * connection teardown sweeps the registry to destroy SFTP write streams and
   * reply 502 — no handler outlives its SSH connection.
   */
  trackStreamUpload(connectionId, entry) {
    this.streamUploads ??= new Map();
    let set = this.streamUploads.get(connectionId);
    if (set === undefined) {
      set = new Set();
      this.streamUploads.set(connectionId, set);
    }
    set.add(entry);
  }

  untrackStreamUpload(connectionId, entry) {
    const set = this.streamUploads?.get(connectionId);
    if (set === undefined) return;
    set.delete(entry);
    if (set.size === 0) this.streamUploads.delete(connectionId);
  }

  sweepStreamUploads(connectionId, reason) {
    const set = this.streamUploads?.get(connectionId);
    if (set === undefined) return;
    this.streamUploads.delete(connectionId);
    for (const entry of [...set]) {
      try {
        entry.cancel(reason);
      } catch {}
    }
  }

  /** GET /ssh-ops/stream/file?connectionId&path — unbounded raw-byte download. */
  async streamDownloadFile(req, res, url, connectionId) {
    const remotePath = url.searchParams.get("path");
    if (remotePath === null || remotePath === "") {
      this.streamJson(res, 400, "bad-path", "path query parameter is required");
      return;
    }
    const prepared = await this.streamPrepareSftp(res, connectionId);
    if (prepared === null) return;
    const attrs = await this.streamStat(res, prepared.sftp, remotePath);
    if (attrs === null) return;
    if ((attrs.mode & 0o170000) === 0o040000) {
      this.streamJson(res, 400, "is-directory", `${remotePath}: directories download through ${STREAM_ROUTE_PREFIX}/archive`);
      return;
    }
    const stream = prepared.sftp.createReadStream(remotePath, { highWaterMark: STREAM_HIGH_WATER_MARK });
    const openError = await this.streamAwaitOpen(stream);
    if (openError !== null) {
      stream.destroy();
      this.streamJson(res, /No such file/i.test(openError.message) ? 404 : 502, "sftp-read-failed", `${remotePath}: ${openError.message}`);
      return;
    }
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(attrs.size),
      "cache-control": "no-store, no-transform"
    });
    let destroyed = false;
    const destroy = () => {
      if (destroyed) return;
      destroyed = true;
      stream.destroy();
    };
    // Client abort (fetch AbortController / socket close) ends the response →
    // stop reading upstream immediately: real mid-flight cancellation.
    res.on("close", destroy);
    stream.on("error", (error) => {
      destroy();
      this.ctx.logger.warn(new Error(`ssh-ops stream download failed: ${remotePath}: ${error.message}`));
      // Headers already out: a truncated body is the only honest failure left.
      if (!res.writableEnded) res.destroy();
    });
    stream.pipe(res);
  }

  /**
   * PUT /ssh-ops/stream/file?connectionId&path[&overwrite=false][&onCancel=keep]
   * — unbounded raw-byte upload with OS-level backpressure. Cancel = request
   * socket closing before the body ends: the SFTP write stream is destroyed
   * (servers drop pending writes when the handle closes) and the partial file
   * is removed by default — deterministic policy; onCancel=keep preserves it.
   */
  async streamUploadFile(req, res, url, connectionId) {
    const remotePath = url.searchParams.get("path");
    if (remotePath === null || remotePath === "") {
      this.streamJson(res, 400, "bad-path", "path query parameter is required");
      return;
    }
    const overwrite = url.searchParams.get("overwrite") !== "false";
    const keepPartial = url.searchParams.get("onCancel") === "keep";
    const prepared = await this.streamPrepareSftp(res, connectionId);
    if (prepared === null) return;
    if (!overwrite) {
      const existing = await new Promise((resolve) => {
        prepared.sftp.stat(remotePath, (error, attrs) => resolve(error ? null : attrs));
      });
      if (existing !== null) {
        this.streamJson(res, 409, "target-exists", `${remotePath}: already exists (overwrite=false)`);
        return;
      }
    }
    const out = prepared.sftp.createWriteStream(remotePath, { highWaterMark: STREAM_HIGH_WATER_MARK });
    const openError = await this.streamAwaitOpen(out);
    if (openError !== null) {
      out.destroy();
      this.streamJson(res, 502, "sftp-write-failed", `${remotePath}: ${openError.message}`);
      return;
    }
    let bytes = 0;
    let ended = false; // request body fully received
    let settled = false; // success reply sent
    let discarded = false; // cancel path taken
    // Zombie-upload backstop 1: idle socket. While the request is paused the
    // server cannot see the client's FIN (unread body bytes precede it), so
    // socket inactivity — not request events — bounds a cancelled upload.
    const socket = req.socket;
    const onIdle = () => {
      discard("socket idle timeout");
      try { res.destroy(); } catch {}
    };
    try {
      socket.setTimeout(STREAM_IDLE_TIMEOUT_MS, onIdle);
    } catch {}
    const finalizeIo = () => {
      try {
        socket.setTimeout(0);
        socket.removeListener("timeout", onIdle);
      } catch {}
      this.untrackStreamUpload(connectionId, registryEntry);
    };
    const discard = (reason) => {
      if (settled || discarded) return;
      discarded = true;
      finalizeIo();
      try { req.pause(); } catch {}
      out.destroy();
      if (!keepPartial) {
        // Deterministic partial policy: remove the half-written file. unlink
        // succeeds while the handle is still open (POSIX); servers drop the
        // pending writes as the handle closes, so the size never grows after.
        // After connection teardown the session is dead and this is a no-op —
        // the consumer-side cleanup (Workbench backend) owns the final delete.
        prepared.sftp.unlink(remotePath, () => {});
      }
      this.streamJson(res, 502, "upload-cancelled", `${remotePath}: ${reason}`);
    };
    // Zombie-upload backstop 2: connection teardown sweeps in-flight uploads
    // (destroy the SFTP write stream + 502 reply), so no paused handler
    // outlives the SSH connection that carried it.
    const registryEntry = { path: remotePath, cancel: (reason) => discard(reason) };
    this.trackStreamUpload(connectionId, registryEntry);
    if (prepared.connection.streamUploadSweepClient !== prepared.connection.client) {
      prepared.connection.streamUploadSweepClient = prepared.connection.client;
      prepared.connection.client.once("close", () => {
        this.sweepStreamUploads(connectionId, "ssh connection closed");
      });
    }
    req.on("aborted", () => discard("client aborted the request"));
    req.on("error", (error) => discard(`request error: ${error.message}`));
    req.on("close", () => {
      if (!ended && !settled) discard("client closed the request early");
    });
    // Full body received but the client vanished before the reply (late
    // abort): still deterministic — cancelled means no file left behind.
    res.on("close", () => {
      if (!settled && !res.writableEnded) discard("client disconnected before completion");
    });
    out.on("error", (error) => {
      if (settled || discarded) return;
      settled = true;
      finalizeIo();
      try { req.destroy(); } catch {}
      this.streamJson(res, 502, "sftp-write-failed", `${remotePath}: ${error.message}`);
    });
    out.on("close", () => {
      if (settled || discarded) return;
      settled = true;
      finalizeIo();
      if (res.destroyed || res.headersSent || res.writableEnded) {
        if (!res.destroyed) res.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, value: { path: remotePath, bytes } }));
    });
    // Manual pump (instead of pipe) to count bytes and keep backpressure:
    // pause the request while the SFTP window is full, resume on drain.
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (!out.write(chunk)) req.pause();
    });
    out.on("drain", () => {
      if (!discarded && !ended) req.resume();
    });
    req.on("end", () => {
      ended = true;
      if (!discarded && !settled) out.end();
    });
  }

  /**
   * GET /ssh-ops/stream/archive?connectionId&path[&format=tar|tar.gz] —
   * folder download as a remote `tar` pipe over an exec channel. tar stores
   * symlinks as link entries (never -h): no recursive following, no directory
   * escape; empty directories and hierarchy are preserved. Non-zero exit or
   * mid-stream failure truncates the chunked response (fail-closed); the
   * stderr tail goes to the host log. Client abort closes the exec channel,
   * and servers kill the tar child on channel close — remote production stops.
   *
   * Path namespace: the SFTP view and the exec shell's filesystem view can
   * differ (chrooted/jailed SFTP servers). A one-shot `[ -d <abs> ]` exec probe
   * decides deterministically: absolute path when it exists in the shell
   * namespace (plain OpenSSH: SFTP paths are real paths), shell-cwd-relative
   * otherwise (jailed servers whose exec cwd is the SFTP root). Note the
   * inherent ambiguity when BOTH views exist (chrooted SFTP + same-named real
   * path): the absolute view wins; exec channels are not jailed anyway.
   * A failed tar with zero stdout still resolves before headers (JSON 502);
   * mid-stream failure truncates the chunked body (fail-closed).
   */
  async streamDownloadArchive(req, res, url, connectionId) {
    const remotePath = url.searchParams.get("path");
    if (remotePath === null || remotePath === "") {
      this.streamJson(res, 400, "bad-path", "path query parameter is required");
      return;
    }
    const format = url.searchParams.get("format") === "tar" ? "tar" : "tar.gz";
    const prepared = await this.streamPrepareSftp(res, connectionId);
    if (prepared === null) return;
    const attrs = await this.streamStat(res, prepared.sftp, remotePath);
    if (attrs === null) return;
    if ((attrs.mode & 0o170000) !== 0o040000) {
      this.streamJson(res, 400, "not-directory", `${remotePath}: archive download requires a directory`);
      return;
    }
    const normalized = remotePath.replace(/\/+$/u, "");
    const name = normalized.slice(normalized.lastIndexOf("/") + 1);
    const parent = normalized.slice(0, normalized.length - name.length) || "/";
    if (name === "" || name === "." || name === "..") {
      this.streamJson(res, 400, "bad-path", `${remotePath}: cannot archive this path`);
      return;
    }
    const relative = normalized.replace(/^\/+/u, "");
    const relParent = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : ".";
    const relName = relative.slice(relative.lastIndexOf("/") + 1);
    // COPYFILE_DISABLE=1 keeps macOS bsdtar from adding AppleDouble (._*)
    // members; a harmless environment prefix on every other platform.
    const build = (par, nm) => `COPYFILE_DISABLE=1 tar -c${format === "tar.gz" ? "z" : ""}f - -C ${shellQuote(par)} ${shellQuote(nm)}`;
    const contentType = format === "tar.gz" ? "application/gzip" : "application/x-tar";
    // Deterministic namespace probe (one-shot exec): does the SFTP-absolute
    // path exist in the shell's filesystem view?
    const absoluteExists = await new Promise((resolve) => {
      prepared.connection.client.exec(`[ -d ${shellQuote(normalized)} ]`, { pty: false }, (error, probe) => {
        if (error) {
          resolve(false);
          return;
        }
        let code = null;
        probe.on("exit", (exitCode) => {
          code = exitCode;
        });
        probe.on("error", () => {});
        probe.on("close", () => resolve(code === 0));
        probe.resume();
      });
    });
    const attempt = absoluteExists
      ? { label: "absolute", command: build(parent, name) }
      : { label: "cwd-relative", command: build(relParent, relName) };
    const outcome = await this.streamArchiveExec(req, res, prepared.connection, attempt.command, remotePath, contentType);
    if (outcome.streamed) return; // headers owned by the attempt (finished, truncated, or client gone)
    this.streamJson(res, 502, "archive-failed", `${remotePath}: remote tar failed (${attempt.label}: exit=${outcome.code === null ? "?" : String(outcome.code)}${outcome.stderr ? ` stderr=${String(outcome.stderr).trim().slice(-300)}` : ""})`);
  }

  /**
   * Run one archive exec attempt. Resolves {streamed:true} once the attempt
   * owned the response (first stdout byte → 200 + manual forwarding), or
   * {streamed:false, code, stderr} when it failed with zero output (headers
   * untouched — caller may try the next candidate or reply a JSON error).
   */
  streamArchiveExec(req, res, connection, command, remotePath, contentType) {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
      connection.client.exec(command, { pty: false }, (error, stream) => {
        if (error) {
          settle({ streamed: false, code: null, stderr: error.message });
          return;
        }
        let stderr = "";
        let exit = null;
        let started = false;
        let broken = false;
        const teardown = () => {
          if (broken) return;
          broken = true;
          try { stream.destroy(); } catch {}
        };
        stream.stderr.on("data", (chunk) => {
          stderr = tailCapped(stderr + Buffer.from(chunk).toString("utf8"), MAX_COMMAND_OUTPUT_BYTES);
        });
        stream.on("exit", (code, signal) => {
          exit = { code, signal: signal ?? null };
        });
        res.on("close", () => {
          if (!res.writableEnded) teardown();
          settle({ streamed: true }); // client gone — nothing left to reply
        });
        stream.on("error", (streamError) => {
          this.ctx.logger.warn(new Error(`ssh-ops archive stream failed: ${remotePath}: ${streamError.message}`));
          teardown();
          if (started && !res.writableEnded) res.destroy();
          settle(started ? { streamed: true } : { streamed: false, code: null, stderr: stderr || streamError.message });
        });
        stream.on("data", (chunk) => {
          if (broken) return;
          if (!started) {
            if (res.destroyed || res.writableEnded) {
              teardown();
              settle({ streamed: true });
              return;
            }
            started = true;
            res.writeHead(200, {
              "content-type": contentType,
              "cache-control": "no-store, no-transform"
            });
            settle({ streamed: true });
          }
          if (!res.write(chunk)) stream.pause();
        });
        res.on("drain", () => {
          if (!broken) stream.resume();
        });
        stream.on("close", () => {
          if (broken) {
            settle({ streamed: true });
            return;
          }
          const code = exit === null ? 0 : exit.code;
          if (!started) {
            settle({ streamed: false, code: exit === null ? null : code, stderr });
            return;
          }
          if (exit !== null && code !== 0) {
            // Truncated chunked body = fail-closed signal for a broken archive.
            this.ctx.logger.warn(new Error(`ssh-ops archive exited ${String(code)}${exit.signal ? ` (${exit.signal})` : ""}: ${remotePath}: ${stderr.trim() || "no stderr"}`));
            broken = true;
            if (!res.writableEnded) res.destroy();
          } else if (!res.writableEnded) {
            res.end();
          }
          settle({ streamed: true });
        });
      });
    });
  }

  /** Open one non-interactive SCP channel on a live SSH connection. */
  async openScpChannel(connection, command) {
    if (!(await this.ensureAlive(connection))) {
      throw new Error(`connection "${connection.id}" is down and could not be re-established`);
    }
    return new Promise((resolve, reject) => {
      connection.client.exec(command, { pty: false }, (error, stream) => {
        if (error) reject(error);
        else {
          // SCP itself reports startup failures (not installed, exec denied)
          // on stderr rather than through the binary protocol channel.
          stream.scpStderr = "";
          stream.stderr?.on("data", (chunk) => {
            stream.scpStderr = tailCapped(stream.scpStderr + Buffer.from(chunk).toString("utf8"), MAX_COMMAND_OUTPUT_BYTES);
          });
          resolve(stream);
        }
      });
    });
  }

  /** Download one file through SCP when the SSH server has no SFTP subsystem. */
  async scpReadFile(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const maxBytes = request.maxBytes ?? MAX_FILE_READ_BYTES;
    let stream;
    try {
      stream = await this.openScpChannel(selected.connection, scpCommand("f", request.path));
      const result = await scpDownload(stream, maxBytes);
      return {
        ok: true,
        value: { path: request.path, data: result.data.toString("base64"), truncated: result.truncated, bytes: result.bytes }
      };
    } catch (error) {
      return { ok: false, error: fail("scp-read-failed", `${request.path}: ${stream?.scpStderr?.trim() || error.message}`) };
    }
  }

  /** Upload one file through SCP when the SSH server has no SFTP subsystem. */
  async scpWriteFile(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    let stream;
    try {
      const data = Buffer.from(request.data, "base64");
      stream = await this.openScpChannel(selected.connection, scpCommand("t", request.path));
      const result = await scpUpload(stream, request.path, data);
      return { ok: true, value: { path: request.path, bytes: result.bytes } };
    } catch (error) {
      return { ok: false, error: fail("scp-write-failed", `${request.path}: ${stream?.scpStderr?.trim() || error.message}`) };
    }
  }

  /** Create a remote directory (mkdir -p semantics via mkdir + stat). */
  async sftpMkdir(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    try {
      await new Promise((resolve, reject) => {
        sftp.sftp.mkdir(request.path, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      return { ok: true, value: { path: request.path } };
    } catch (error) {
      return { ok: false, error: fail("sftp-mkdir-failed", `${request.path}: ${error.message}`) };
    }
  }

  /** Delete a remote file (or empty directory). */
  async sftpDelete(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    try {
      const isDir = await new Promise((resolve, reject) => {
        sftp.sftp.stat(request.path, (error, attrs) => {
          if (error) reject(error);
          else resolve((attrs.mode & 0o170000) === 0o040000);
        });
      });
      await new Promise((resolve, reject) => {
        const fn = isDir ? sftp.sftp.rmdir : sftp.sftp.unlink;
        fn.call(sftp.sftp, request.path, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      return { ok: true, value: { path: request.path, isDirectory: isDir } };
    } catch (error) {
      return { ok: false, error: fail("sftp-delete-failed", `${request.path}: ${error.message}`) };
    }
  }

  /** Rename a remote file or directory. */
  async sftpRename(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    try {
      await new Promise((resolve, reject) => {
        sftp.sftp.rename(request.from, request.to, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      return { ok: true, value: { from: request.from, to: request.to } };
    } catch (error) {
      return { ok: false, error: fail("sftp-rename-failed", `${request.from} -> ${request.to}: ${error.message}`) };
    }
  }

  // ── Port forwarding (tunnels) ──────────────────────────────────────────────

  /**
   * Start a local port forward: the DSH host listens on bindAddr:bindPort and
   * forwards connections through the SSH connection to remoteHost:remotePort
   * (ssh2 Client.forwardOut semantics). Returns the assigned local endpoint.
   */
  async tunnelStartLocal(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const conn = selected.connection;
    if (!(await this.ensureAlive(conn))) {
      return { ok: false, error: fail("connection-lost", `connection "${conn.id}" is down and could not be re-established`) };
    }
    const tunnelId = `tun-${randomUUID().slice(0, 8)}`;
    const bindAddr = request.bindAddr ?? "127.0.0.1";
    const bindPort = request.bindPort ?? 0;
    const net = await import("node:net");
    try {
      const server = net.createServer((socket) => {
        conn.client.forwardOut(bindAddr, bindPort, request.remoteHost, request.remotePort, (error, stream) => {
          if (error) {
            socket.destroy();
            return;
          }
          socket.pipe(stream).pipe(socket);
        });
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(bindPort, bindAddr, () => resolve());
      });
      const address = server.address();
      const actualPort = typeof address === "object" && address !== null ? address.port : bindPort;
      conn.tunnels.set(tunnelId, {
        id: tunnelId,
        kind: "local",
        bindAddr,
        bindPort: actualPort,
        remoteHost: request.remoteHost,
        remotePort: request.remotePort,
        server,
        active: true
      });
      return {
        ok: true,
        value: {
          tunnelId,
          kind: "local",
          bindAddr,
          bindPort: actualPort,
          remoteHost: request.remoteHost,
          remotePort: request.remotePort
        }
      };
    } catch (error) {
      return { ok: false, error: fail("tunnel-start-failed", `local ${bindAddr}:${bindPort} -> ${request.remoteHost}:${request.remotePort}: ${error.message}`) };
    }
  }

  /**
   * Start a remote port forward: connections to remoteHost:remotePort on the
   * server are forwarded back through the SSH connection to bindAddr:bindPort
   * on the DSH host (ssh2 Client.forwardIn). Requires the server's sshd to
   * allow remote forwards (AllowTcpForwarding); typically needs root or a
   * GatewayPorts-capable sshd.
   */
  async tunnelStartRemote(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const conn = selected.connection;
    if (!(await this.ensureAlive(conn))) {
      return { ok: false, error: fail("connection-lost", `connection "${conn.id}" is down and could not be re-established`) };
    }
    const tunnelId = `tun-${randomUUID().slice(0, 8)}`;
    const bindAddr = request.bindAddr ?? "127.0.0.1";
    const bindPort = request.bindPort ?? 0;
    try {
      await new Promise((resolve, reject) => {
        conn.client.forwardIn(bindAddr, bindPort, (error, port) => {
          if (error) reject(error);
          else resolve(port);
        });
      });
      // Bridge every accepted remote connection to the local target.
      const bridge = (info, accept) => {
        if (info.destIP !== bindAddr || info.destPort !== bindPort) return;
        const stream = accept();
        const socket = net.connect(request.targetPort, request.targetHost);
        socket.on("error", () => stream.destroy());
        stream.on("error", () => socket.destroy());
        stream.pipe(socket).pipe(stream);
      };
      conn.client.prependListener("tcp connection", bridge);
      const bridgeInfo = { kind: "remote", bindAddr, bindPort, bridge };
      conn.tunnels.set(tunnelId, {
        id: tunnelId,
        kind: "remote",
        bindAddr,
        bindPort,
        remoteHost: request.remoteHost,
        remotePort: request.remotePort,
        targetHost: request.targetHost,
        targetPort: request.targetPort,
        active: true,
        bridgeInfo
      });
      return {
        ok: true,
        value: {
          tunnelId,
          kind: "remote",
          bindAddr,
          bindPort,
          remoteHost: request.remoteHost,
          remotePort: request.remotePort,
          targetHost: request.targetHost,
          targetPort: request.targetPort
        }
      };
    } catch (error) {
      return { ok: false, error: fail("tunnel-start-failed", `remote ${bindAddr}:${bindPort}: ${error.message}`) };
    }
  }

  /** Stop a tunnel by id. */
  async tunnelStop(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const conn = selected.connection;
    const tunnel = conn.tunnels.get(request.tunnelId);
    if (tunnel === void 0) return { ok: false, error: fail("no-tunnel", `tunnel "${request.tunnelId}" does not exist on this connection`) };
    try {
      if (tunnel.kind === "local") {
        await new Promise((resolve) => tunnel.server.close(() => resolve()));
      } else {
        if (tunnel.bridgeInfo?.bridge) {
          conn.client.removeListener("tcp connection", tunnel.bridgeInfo.bridge);
        }
        await new Promise((resolve) => conn.client.unforwardIn(tunnel.bindAddr, tunnel.bindPort, () => resolve()));
      }
      conn.tunnels.delete(request.tunnelId);
      return { ok: true, value: { tunnelId: request.tunnelId, stopped: true } };
    } catch (error) {
      return { ok: false, error: fail("tunnel-stop-failed", error.message) };
    }
  }

  /** List tunnels on a connection. */
  async tunnelList(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const tunnels = [...selected.connection.tunnels.values()].map((t) => {
      const entry = {
        tunnelId: t.id,
        kind: t.kind,
        bindAddr: t.bindAddr,
        bindPort: t.bindPort,
        remoteHost: t.remoteHost,
        remotePort: t.remotePort,
        active: t.active
      };
      if (t.targetHost !== undefined) entry.targetHost = t.targetHost;
      if (t.targetPort !== undefined) entry.targetPort = t.targetPort;
      return entry;
    });
    return { ok: true, value: { tunnels } };
  }

  // ── SSH config import ──────────────────────────────────────────────────────

  /**
   * Parse the user's ~/.ssh/config and return host entries suitable for
   * saving as profiles. Each Host block becomes one entry with host, port,
   * user, and auth kind (key path is detected but the key content is NOT
   * read — the caller saves the path and the profile connect flow reads it
   * at connect time).
   */
  async sshConfigImport() {
    const { readFile, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const os = await import("node:os");
    const configPath = join(os.default.homedir(), ".ssh", "config");
    if (!existsSync(configPath)) {
      return { ok: false, error: fail("no-ssh-config", `~/.ssh/config not found at ${configPath}`) };
    }
    let content;
    try {
      content = await readFile(configPath, "utf8");
    } catch (error) {
      return { ok: false, error: fail("ssh-config-read-failed", error.message) };
    }
    const hosts = [];
    let current = null;
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("#")) continue;
      const spaceIdx = line.search(/\s/);
      if (spaceIdx === -1) continue;
      const key = line.slice(0, spaceIdx).toLowerCase();
      const value = line.slice(spaceIdx + 1).trim();
      if (key === "host") {
        // Skip wildcards like Host *
        if (value.includes("*")) { current = null; continue; }
        if (current !== null) hosts.push(current);
        current = { name: value, host: value, port: 22, username: "", authKind: "key", identityFile: "", proxyJump: "" };
      } else if (current !== null) {
        if (key === "hostname") current.host = value;
        else if (key === "port") current.port = parseInt(value, 10) || 22;
        else if (key === "user") current.username = value;
        else if (key === "identityfile") current.identityFile = value.replace(/^~/, os.default.homedir());
        else if (key === "proxyjump") current.proxyJump = value;
      }
    }
    if (current !== null) hosts.push(current);
    return { ok: true, value: { hosts } };
  }

  /** Execute a command on the explicit or current SSH connection. */
  async executeCommand(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const result = await this.execOnConnection(selected.connectionId, request.command, request.timeoutMs);
    if (result.blocked) {
      return {
        ok: true,
        value: {
          connectionId: selected.connectionId,
          host: selected.connection.host,
          ...result.value,
          redacted: false
        }
      };
    }
    if (!result.ok) return result;
    const { exitCode, stdout, stderr, cwd, commandId, startedAt, finishedAt, durationMs, truncated, timedOut } = result.value;
    const safeStdout = redactForModel(stdout);
    const safeStderr = redactForModel(stderr);
    return {
      ok: true,
      value: {
        connectionId: selected.connectionId,
        host: selected.connection.host,
        exitCode,
        stdout: safeStdout.text,
        stderr: safeStderr.text,
        cwd,
        commandId,
        startedAt,
        finishedAt,
        durationMs,
        truncated,
        timedOut,
        redacted: safeStdout.redacted || safeStderr.redacted
      }
    };
  }

  /** Read terminal output from the explicit or current SSH connection. */
  readCurrentConnection(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const result = this.readConnectionOutput(selected.connectionId);
    if (!result.ok) return result;
    return {
      ok: true,
      value: {
        connectionId: selected.connectionId,
        host: selected.connection.host,
        ...result.value
      }
    };
  }

  /**
   * Make sure the target connection has a live PTY session so agent input can
   * actually be submitted. With multiple open connections and no terminal open
   * on the target yet, a plain write would otherwise drop the input (0 bytes
   * written). Resolves the connection by id or the active one, then opens a
   * session lazily when none is live.
   */
  async ensureSessionForWrite(connectionId) {
    const selected = this.resolveConnection(connectionId);
    if (!selected.ok) return selected;
    const live = [...selected.connection.sessions].some((sessionId) => {
      const session = this.sessions.get(sessionId);
      return session !== void 0 && session.exited === null && session.stream !== null;
    });
    if (live) return { ok: true, connectionId: selected.connectionId };
    const opened = await this.openSession({ connectionId: selected.connectionId, cols: 100, rows: 30 });
    if (!opened.ok) return opened;
    return { ok: true, connectionId: selected.connectionId };
  }

  /** Send tool input to the explicit or current SSH connection. */
  writeCurrentConnection(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    return this.writeToConnection(selected.connectionId, request.input);
  }

  /** Disconnect the explicit or current SSH connection. */
  async disconnectCurrentConnection(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    return this.disconnect({ connectionId: selected.connectionId });
  }

  /** Append transport data and retain a bounded, explicit-read capture. */
  appendSessionOutput(session, text, { capture = true, observePrompt = true } = {}) {
    this.terminalOutput(session).append(text);
    // Legacy poll readers retain their independent destructive buffer.
    session.buffer = tailCapped((session.buffer ?? "") + text, this.config.maxBufferBytes);
    if (capture) {
      session.captureBuffer = tailCapped((session.captureBuffer ?? "") + text, this.config.maxCaptureBytes);
    }
    if (observePrompt) {
      const prompt = promptFromTerminalData(text);
      if (prompt !== null) session.lastPrompt = prompt;
    }
    this.wakeWaiters(session, null);
    this.notifyStreamListeners(session, text);
  }

  fallbackPrompt(connection) {
    return `${connection.username}@${connection.host}:~${connection.username === "root" ? "#" : "$"} `;
  }

  // ── Agent tools ────────────────────────────────────────────────────────────

  registerTools(ctx) {
    // Tool bodies live in src/tools/*; each register function binds this
    // service instance via closure (defineTool invokes execute as a bare
    // function, so the tools reach service methods through this argument).
    registerSshSessionTools(ctx, this);
    registerSftpTools(ctx, this);
    registerTunnelTools(ctx, this);
    registerBatchTools(ctx, this);
    registerDbTools(ctx, this);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  recordExit(session, exit) {
    if (session.exited !== null) return;
    session.exited = exit;
    this.removePendingForSession(session.id);
    // A naturally-exited shell must no longer count as an open terminal:
    // drop it from the connection's live-session set so list() reports only
    // live PTYs and the panel can offer to open a fresh one on that tab.
    if (session.connectionId !== undefined) {
      const conn = this.connections.get(session.connectionId);
      if (conn !== undefined) conn.sessions.delete(session.id);
    }
    this.wakeWaiters(session, exit);
    this.notifyStreamListeners(session, "");
  }

  rememberExit(id, exit) {
    if (this.exitedSessions.size >= MAX_EXIT_TOMBSTONES) {
      const oldest = this.exitedSessions.keys().next().value;
      if (oldest !== void 0) this.exitedSessions.delete(oldest);
    }
    this.exitedSessions.set(id, exit);
  }

  wakeWaiters(session, exit) {
    if (session.waiters.length === 0) return;
    const cursorWaiters = session.waiters.filter((waiter) => waiter.cursor);
    session.waiters = session.waiters.filter((waiter) => !waiter.cursor);
    for (const waiter of cursorWaiters) waiter.resolve();
    if (session.waiters.length === 0) return;
    session.waiters.shift().resolve({
      ok: true,
      value: { data: this.drain(session), exit }
    });
    if (exit !== null) {
      for (const rest of session.waiters.splice(0)) {
        rest.resolve({ ok: true, value: { data: "", exit } });
      }
    }
  }

  /** Feed appended output to stream-push consumers; every listener sees every item. */
  notifyStreamListeners(session, _text) {
    if (session.streamListeners === undefined) return;
    for (const listener of session.streamListeners) {
      listener.wake?.();
    }
  }

  drain(session) {
    const pending = session.buffer;
    session.buffer = "";
    return encodeData(pending);
  }
}
