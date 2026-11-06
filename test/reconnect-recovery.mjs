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
