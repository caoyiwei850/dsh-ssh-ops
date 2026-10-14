// #32 regression net: a failed forward must cost one socket, never the host
// process. Covers the synchronous forwardOut throw ('Not connected' on a
// dead ssh2 client), unhandled socket/channel 'error' (ECONNRESET), late
// callbacks for already-destroyed sockets, and the tunnel-listener teardown
// on transport loss / explicit disconnect. Uses prototype stubs and real
// loopback net servers — no ssh2 transport involved.
import assert from "node:assert/strict";
import net from "node:net";
import { readFileSync } from "node:fs";
import SshOpsService from "../src/index.js";

/** Real listeners started across sections; closed in the finally below. */
const openServers = [];
const services = [];

function makeService() {
  const service = Object.create(SshOpsService.prototype);
  service.config = { maxBufferBytes: 65536, maxCaptureBytes: 65536 };
  service.connections = new Map();
  service.sessions = new Map();
  service.exitedSessions = new Map();
  service.activeConnectionId = null;
  service.scheduleReconnect = () => {};
  services.push(service);
  return service;
}

function fakeConn(service, client, { dead = false, closing = false } = {}) {
  const conn = {
    id: "c1", profileId: null, client,
    name: null, host: "10.0.0.5", username: "root",
    connectConfig: { host: "10.0.0.5", port: 22 },
    sessions: new Set(), sftp: null, tunnels: new Map(),
    hops: [], dead, closing,
    reconnectTimer: null
  };
  service.connections.set("c1", conn);
  service.resolveConnection = () => ({ ok: true, connection: conn });
  return conn;
}

/** A stand-in accepted socket: destroy flag + pipe passthrough. */
function fakeSocket() {
  const socket = new net.Socket({ allowHalfOpen: false });
  // Never bound to a port: only the destroy bookkeeping is under test.
  return Object.assign(socket, { destroyed: false, _piped: [], pipe(dest) { socket._piped.push(dest); return dest; }, destroy() { socket.destroyed = true; } });
}
function fakeChannel() {
  const channel = new net.Socket();
  return Object.assign(channel, { destroyed: false, _piped: [], pipe(dest) { channel._piped.push(dest); return dest; }, destroy() { channel.destroyed = true; } });
}

async function startLocal(service, client, overrides = {}) {
  const result = await service.tunnelStartLocal({
    connectionId: "c1", bindAddr: "127.0.0.1", bindPort: 0,
    remoteHost: "10.9.9.9", remotePort: 5432, ...overrides
  });
  assert.equal(result.ok, true, result.error?.message);
  const tunnel = service.connections.get("c1").tunnels.get(result.value.tunnelId);
  openServers.push(tunnel.server);
  return result.value;
}

/** Drive the real createServer connection callback with a stand-in socket. */
function fireAccept(server, socket) {
  server.emit("connection", socket);
}

try {
// ── 1. ssh2's synchronous 'Not connected' throw must not escape the accept callback ──
{
  const service = makeService();
  let forwardCalls = 0;
  fakeConn(service, {
    forwardOut() { forwardCalls += 1; throw new Error("Not connected"); }
  });
  await startLocal(service);
  const server = service.connections.get("c1").tunnels.values().next().value.server;

  const socket = fakeSocket();
  assert.doesNotThrow(() => fireAccept(server, socket), "the synchronous throw is contained (#32 host crash)");
  assert.equal(socket.destroyed, true, "the accepted socket is destroyed");
  assert.equal(forwardCalls, 1);
}

// ── 2. a dead/closing connection refuses accepts before touching the client ──
{
  const service = makeService();
  let forwardCalls = 0;
  const conn = fakeConn(service, { forwardOut() { forwardCalls += 1; throw new Error("Not connected"); } });
  await startLocal(service);
  const server = conn.tunnels.values().next().value.server;

  for (const state of [{ dead: true }, { closing: true }]) {
    Object.assign(conn, { dead: false, closing: false }, state);
    const socket = fakeSocket();
    fireAccept(server, socket);
    assert.equal(socket.destroyed, true, `${JSON.stringify(state)} accept is refused`);
  }
  assert.equal(forwardCalls, 0, "forwardOut is never called on a dead connection");
}

// ── 3. callback error, late channel, and both error directions ──
{
  const service = makeService();
  const pending = [];
  fakeConn(service, { forwardOut(_a, _b, _c, _d, cb) { pending.push(cb); } });
  await startLocal(service);
  const server = service.connections.get("c1").tunnels.values().next().value.server;

  // Callback reports an error: socket destroyed, nothing piped.
  {
    const socket = fakeSocket();
    fireAccept(server, socket);
    pending.shift()(new Error("connect failed"));
    assert.equal(socket.destroyed, true, "callback error destroys the socket");
  }

  // A channel arriving for an already-gone socket is discarded, not piped.
  {
    const socket = fakeSocket();
    fireAccept(server, socket);
    socket.destroy();
    const channel = fakeChannel();
    pending.shift()(null, channel);
    assert.equal(channel.destroyed, true, "late channel for a dead socket is destroyed");
    assert.deepEqual(channel._piped, [], "late channel is never piped");
  }

  // Channel 'error' (SSH side reset) tears down the local socket.
  {
    const socket = fakeSocket();
    fireAccept(server, socket);
    const channel = fakeChannel();
    pending.shift()(null, channel);
    assert.deepEqual(socket._piped, [channel], "healthy path pipes both ways");
    channel.emit("error", new Error("read ECONNRESET"));
    assert.equal(socket.destroyed, true, "channel error destroys the local socket (#32)");
  }

  // Local socket 'error' (the Windows RST case) tears down the channel.
  {
    const socket = fakeSocket();
    fireAccept(server, socket);
    const channel = fakeChannel();
    pending.shift()(null, channel);
    socket.emit("error", new Error("read ECONNRESET"));
    assert.equal(channel.destroyed, true, "socket error destroys the channel (#32)");
  }
}

// ── 4. listener teardown on transport loss and explicit disconnect ──
{
  const service = makeService();
  const closed = [];
  const dbClosed = [];
  service.dbOps = { closeForSshConnection: (connectionId) => dbClosed.push(connectionId) };
  const fakeServer = (kind) => ({
    kind,
    close(cb) { closed.push(kind); cb?.(); },
    on() {}
  });
  const client = new net.Socket();
  const conn = fakeConn(service, client);
  conn.tunnels.set("t1", { id: "t1", kind: "local", active: true, server: fakeServer("local") });
  conn.tunnels.set("t2", { id: "t2", kind: "dynamic", active: true, server: fakeServer("dynamic") });

  service.handleTransportLoss(conn, client, null);
  assert.deepEqual(closed.sort(), ["dynamic", "local"], "transport loss closes every tunnel listener");
  assert.equal(conn.tunnels.size, 0, "tunnel records are cleared");
  assert.deepEqual(dbClosed, ["c1"], "transport loss also retires DB tunnels routed through this SSH connection");

  conn.tunnels.set("t3", { id: "t3", kind: "local", active: true, server: fakeServer("local-2") });
  const gone = await service.disconnect({ connectionId: "c1" });
  assert.equal(gone.ok, true);
  assert.deepEqual(closed, ["dynamic", "local", "local-2"], "explicit disconnect closes remaining listeners");
  assert.deepEqual(dbClosed, ["c1", "c1"], "explicit disconnect also retires DB tunnels routed through this SSH connection");
  assert.equal(service.connections.has("c1"), false);
}

// ── 5. dynamic SOCKS5: the wrapped forwardOut turns the synchronous throw into a SOCKS failure reply ──
async function readExactly(stream, bytes) {
  const chunks = [];
  let total = 0;
  while (total < bytes) {
    const got = await new Promise((resolve, reject) => {
      stream.once("data", resolve);
      stream.once("error", reject);
      stream.once("close", () => reject(new Error("socket closed while reading")));
    });
    chunks.push(got);
    total += got.length;
  }
  return Buffer.concat(chunks);
}

{
  const service = makeService();
  fakeConn(service, {
    forwardOut() { throw new Error("Not connected"); }
  });
  const started = await service.tunnelStartDynamic({ connectionId: "c1", bindAddr: "127.0.0.1", bindPort: 0 });
  assert.equal(started.ok, true, started.error?.message);

  const client = net.connect(started.value.bindPort, "127.0.0.1");
  await new Promise((resolve, reject) => { client.once("connect", resolve); client.once("error", reject); });
  client.write(Buffer.from([0x05, 0x01, 0x00]));
  const method = await readExactly(client, 2);
  assert.equal(method[1], 0x00, "no-auth accepted");
  const name = Buffer.from("db.internal", "utf8");
  client.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]), name, Buffer.from([0x01, 0xbb])]));
  const reply = await readExactly(client, 10);
  assert.notEqual(reply[1], 0x00, "the failed forward is reported as a SOCKS failure, not a crash");
  client.destroy();
}

// ── 6. SshTunnels list rendering must not shadow the i18n t() (#32 't2 is not a function') ──
{
  const source = readFileSync(new URL("../src/client/SshTunnels.jsx", import.meta.url), "utf8");
  assert.ok(!/\.map\(\(t\)/.test(source), "tunnel list map parameter must not be named t (shadows i18n t)");
  assert.ok(source.includes('tunnel.kind === "dynamic" ? t("动态 SOCKS5")'), "kind labels still go through the translator");
  assert.ok(source.includes("t(`活动连接 ${tunnel.connections}`)"), "connection-count labels still go through the translator");
}

} finally {
  const servers = [...openServers];
  for (const service of services) {
    for (const conn of service.connections.values()) {
      for (const tunnel of conn.tunnels.values()) tunnel.server && servers.push(tunnel.server);
    }
  }
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(() => resolve()))));
}
console.log("tunnel crash net: sync throw, RST both ways, late callbacks, teardown, SOCKS5 wrapper, list shadowing: passed");
