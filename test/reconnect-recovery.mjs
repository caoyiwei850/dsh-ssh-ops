import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ssh2 from "ssh2";
import SshOpsService from "../src/index.js";

function fixture(connectClient) {
  const service = Object.create(SshOpsService.prototype);
  service.connectClient = connectClient;
  service.attachTransportHandlers = () => {};
  const conn = { dead: true, closing: false, reconnectAttempts: 0, reconnectTimer: null,
    reconnectWaiters: [], tunnels: new Map(), hops: [], client: { end() {} } };
  return { service, conn };
}

test("connection list distinguishes a lost transport from a live one", async () => {
  const { service, conn } = fixture(async () => ({ ok: true }));
  Object.assign(conn, { host: "example", port: 22, username: "user", sessions: new Set() });
  service.connections = new Map([["c1", conn]]);
  service.activeConnectionId = null;
  service.agentAutoConnect = false;
  assert.equal((await service.list()).value.connections[0].connected, false);
  conn.dead = false;
  assert.equal((await service.list()).value.connections[0].connected, true);
});

test("an unexpected initial connection failure leaves no phantom connection", async () => {
  const service = Object.create(SshOpsService.prototype);
  service.connections = new Map();
  service.connectClient = async () => { throw new TypeError("Client is not a constructor"); };
  const result = await service.connectInternal({ host: "example", port: 22, username: "user", auth: { password: "test" }, retries: 0 });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /Client is not a constructor/);
  assert.equal(service.connections.size, 0);
});

test("unexpected reconnect rejection is contained, stops retrying and wakes waiters", async () => {
  let calls = 0;
  let ended = 0;
  const { service, conn } = fixture(async () => { calls += 1; throw new RangeError("proxy recursion"); });
  conn.client.end = () => { ended += 1; };
  const waiting = service.ensureAlive(conn, 3000);
  service.scheduleReconnect(conn);
  assert.equal(await waiting, false);
  assert.equal(conn.dead, true);
  assert.equal(conn.reconnectTimer, null);
  assert.equal(conn.reconnectWaiters.length, 0);
  assert.equal(calls, 1);
  assert.equal(ended, 1);
});

test("host-key rejection stops reconnect and wakes waiters without accepting the key", async () => {
  const { service, conn } = fixture(async () => ({ ok: false, error: { code: "host-key-mismatch" } }));
  const waiting = service.ensureAlive(conn, 3000);
  service.scheduleReconnect(conn);
  assert.equal(await waiting, false);
  assert.equal(conn.dead, true);
  assert.equal(conn.reconnectTimer, null);
});

test("successful reconnect wakes waiters; timed-out waiters are removed", async () => {
  const { service, conn } = fixture(async () => { conn.dead = false; return { ok: true }; });
  assert.equal(await service.ensureAlive(conn, 5), false);
  assert.equal(conn.reconnectWaiters.length, 0);
  const waiting = service.ensureAlive(conn, 3000);
  service.scheduleReconnect(conn);
  assert.equal(await waiting, true);
  assert.equal(conn.reconnectWaiters.length, 0);
});

test("SSH client is read from the CommonJS default export", () => {
  assert.equal(typeof ssh2.Client, "function");
  const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  assert.match(source, /import ssh2 from ["']ssh2["']/);
  assert.doesNotMatch(source, /import\s*\{\s*Client\s*\}\s*from\s*["']ssh2["']/);
});

test("transport loss finalizes the terminal log and delivers the reason to reattached streams", async () => {
  const { service, conn } = fixture(async () => ({ ok: true }));
  conn.id = "c1";
  conn.dead = false;
  conn.sessions = new Set(["s1"]);
  service.sessions = new Map([["s1", { id: "s1", connectionId: "c1", exited: null, waiters: [], streamListeners: new Set() }]]);
  service.connections = new Map([["c1", conn]]);
  service.exitedSessions = new Map();
  service.scheduleReconnect = () => {};
  service.log = () => {};
  let logEnd;
  service.sessionLogStore = () => ({ async end(id, details) { logEnd = { id, ...details }; } });
  service.handleTransportLoss(conn, conn.client, Object.assign(new Error("socket lost"), { code: "ECONNRESET" }));
  assert.deepEqual(logEnd, { id: "s1", exitCode: 1, reason: "transport-lost" });
  const item = await service.terminalStream({ sessionId: "s1" }).next();
  assert.deepEqual(item.value.value.exit, { code: 1, reason: "transport-lost" });
});
