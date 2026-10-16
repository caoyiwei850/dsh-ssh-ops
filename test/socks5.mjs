// SOCKS5 dynamic forwarding: greeting/request parsing, reply framing, and a
// real round trip through the proxy into an upstream echo server for IPv4,
// domain and IPv6-preference paths, plus every refusal branch.
import assert from "node:assert/strict";
import net from "node:net";
import { SOCKS_REPLY, attachSocks5, parseGreeting, parseRequest, replyBytes, replyCodeForError } from "../src/socks5.js";

// ── greeting parsing ────────────────────────────────────────────────────────
assert.equal(parseGreeting(Buffer.from([0x05])), null, "one byte is not enough");
assert.deepEqual(parseGreeting(Buffer.from([0x05, 0x01, 0x00])), { ok: true, wantsNoAuth: true });
assert.deepEqual(parseGreeting(Buffer.from([0x05, 0x02, 0x02, 0x00])), { ok: true, wantsNoAuth: true });
assert.deepEqual(parseGreeting(Buffer.from([0x05, 0x01, 0x02])), { ok: true, wantsNoAuth: false });
assert.deepEqual(parseGreeting(Buffer.from([0x04, 0x01, 0x00])), { ok: false, reason: "unsupported SOCKS version 4" });
assert.equal(parseGreeting(Buffer.from([0x05, 0x02, 0x00])), null, "a declared method count needs its bytes");

// ── request parsing ─────────────────────────────────────────────────────────
assert.equal(parseRequest(Buffer.from([0x05, 0x01, 0x00])), null);
assert.deepEqual(
  parseRequest(Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, 0x1f, 0x90])),
  { cmd: 0x01, host: "127.0.0.1", port: 8080, bytes: 10 }
);
{
  const name = Buffer.from("db.internal", "utf8");
  const frame = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]), name, Buffer.from([0x01, 0xbb])]);
  assert.deepEqual(parseRequest(frame), { cmd: 0x01, host: "db.internal", port: 443, bytes: 18 });
}
{
  // 2001:db8::1
  const frame = Buffer.from([0x05, 0x01, 0x00, 0x04, 0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0x00, 0x16]);
  assert.deepEqual(parseRequest(frame), { cmd: 0x01, host: "2001:db8:0:0:0:0:0:1", port: 22, bytes: 22 });
}
assert.deepEqual(parseRequest(Buffer.from([0x05, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0])), { cmd: 0x02, unsupportedCommand: true });
assert.equal(parseRequest(Buffer.from([0x05, 0x01, 0x00, 0x09, 0, 0, 0, 0, 0, 0])).ok, false);

// ── reply framing ───────────────────────────────────────────────────────────
assert.deepEqual([...replyBytes(SOCKS_REPLY.SUCCEEDED)], [0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
assert.equal(replyCodeForError(new Error("connect ECONNREFUSED 127.0.0.1:1")), SOCKS_REPLY.CONNECTION_REFUSED);
assert.equal(replyCodeForError(new Error("Network is unreachable")), SOCKS_REPLY.NETWORK_UNREACHABLE);
assert.equal(replyCodeForError(new Error("getaddrinfo ENOTFOUND nope")), SOCKS_REPLY.HOST_UNREACHABLE);
assert.equal(replyCodeForError(new Error("admin prohibited")), SOCKS_REPLY.GENERAL_FAILURE);

// ── end to end through the proxy ────────────────────────────────────────────
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(() => resolve()));

/** Read exactly n bytes, then hand them to the caller. */
function readExactly(socket, n) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= n) {
        socket.removeListener("data", onData);
        resolve(buffer.subarray(0, n));
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("closed before enough bytes arrived")));
  });
}

const echo = net.createServer((socket) => socket.pipe(socket));
const echoPort = await listen(echo);

let forwardCalls = 0;
const proxy = net.createServer((socket) => {
  attachSocks5(socket, {
    forwardOut: (host, port, callback) => {
      forwardCalls += 1;
      const upstream = net.connect(port, host);
      upstream.once("connect", () => callback(null, upstream));
      upstream.once("error", (error) => callback(error));
    }
  });
});
const proxyPort = await listen(proxy);

/** Speak SOCKS5 to the proxy and return the connected socket. */
async function openThroughProxy({ atyp = 0x03, host = "localhost", port = echoPort, cmd = 0x01, greeting = [0x05, 0x01, 0x00] }) {
  const client = net.connect(proxyPort, "127.0.0.1");
  await new Promise((resolve, reject) => { client.once("connect", resolve); client.once("error", reject); });
  client.write(Buffer.from(greeting));
  const method = await readExactly(client, 2);
  if (method[0] === 0x05 && method[1] === 0xff) return { client, refused: "no-acceptable-methods" };
  const name = Buffer.from(host, "utf8");
  const request = atyp === 0x03
    ? Buffer.concat([Buffer.from([0x05, cmd, 0x00, 0x03, name.length]), name, Buffer.from([(port >> 8) & 0xff, port & 0xff])])
    : Buffer.from([0x05, cmd, 0x00, atyp, 127, 0, 0, 1, (port >> 8) & 0xff, port & 0xff]);
  client.write(request);
  const reply = await readExactly(client, 10);
  return { client, method: method[1], reply: reply[1] };
}

// Domain-address CONNECT: bytes must reach the echo server and come back.
{
  const { client, reply } = await openThroughProxy({ atyp: 0x03, host: "localhost" });
  assert.equal(reply, SOCKS_REPLY.SUCCEEDED);
  client.write("hello socks");
  const echoed = await readExactly(client, 11);
  assert.equal(echoed.toString("utf8"), "hello socks", "payload round-trips through the forwarded channel");
  client.destroy();
}

// IPv4-address CONNECT works too.
{
  const { client, reply } = await openThroughProxy({ atyp: 0x01 });
  assert.equal(reply, SOCKS_REPLY.SUCCEEDED);
  client.destroy();
}

// Unsupported command (BIND) is refused with 0x07, not silently accepted.
{
  const { reply } = await openThroughProxy({ cmd: 0x02 });
  assert.equal(reply, SOCKS_REPLY.COMMAND_NOT_SUPPORTED);
}

// A client offering only a method we do not implement gets 0x05 0xFF.
{
  const { refused } = await openThroughProxy({ greeting: [0x05, 0x01, 0x02] });
  assert.equal(refused, "no-acceptable-methods");
}

// A refused upstream maps onto the connection-refused reply code.
{
  const deadPort = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
  const { reply } = await openThroughProxy({ atyp: 0x01, port: deadPort });
  assert.equal(reply, SOCKS_REPLY.CONNECTION_REFUSED);
}

assert.ok(forwardCalls >= 3, `each accepted client opens its own channel (saw ${forwardCalls})`);

// ── pipelined payload: bytes sent with the CONNECT frame reach the upstream ──
{
  const c = net.connect(proxyPort, "127.0.0.1");
  await new Promise((r) => c.once("connect", r));
  c.write(Buffer.from([0x05, 0x01, 0x00]));
  await readExactly(c, 2);
  const name = Buffer.from("localhost");
  const request = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]), name, Buffer.from([(echoPort >> 8) & 0xff, echoPort & 0xff])]);
  const payload = Buffer.from("PIPELINED-PAYLOAD");
  c.write(Buffer.concat([request, payload]));   // one segment, no reply wait
  await readExactly(c, 10);                     // the CONNECT reply
  const echoed = await Promise.race([
    readExactly(c, payload.length),
    new Promise((resolve) => setTimeout(() => resolve(null), 1000))
  ]);
  assert.equal(echoed === null ? "(dropped)" : echoed.toString("utf8"), "PIPELINED-PAYLOAD",
    "payload pipelined with CONNECT must not be dropped");
  c.destroy();
}

// ── handshake-window payload: arrives after the request, before the channel ──
{
  // A slow forwardOut holds the channel closed; anything the client sends in
  // that window must be buffered and flushed once the stream resolves — the
  // parser fix must not trade the drop for a new loss.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = net.createServer((socket) => {
    attachSocks5(socket, {
      forwardOut: (host, port, cb) => {
        gate.then(() => {
          const up = net.connect(port, host);
          up.once("connect", () => cb(null, up));
          up.once("error", cb);
        });
      }
    });
  });
  const slowPort = await listen(slow);
  const c = net.connect(slowPort, "127.0.0.1");
  await new Promise((r) => c.once("connect", r));
  c.write(Buffer.from([0x05, 0x01, 0x00]));
  await readExactly(c, 2);
  const name = Buffer.from("localhost");
  const request = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]), name, Buffer.from([(echoPort >> 8) & 0xff, echoPort & 0xff])]);
  const payload = Buffer.from("WINDOW-PAYLOAD");
  c.write(request);
  c.write(payload);          // lands while the channel is still opening
  await new Promise((r) => setTimeout(r, 30));
  release();
  await readExactly(c, 10);  // reply
  const echoed = await Promise.race([
    readExactly(c, payload.length),
    new Promise((resolve) => setTimeout(() => resolve(null), 1000))
  ]);
  assert.equal(echoed === null ? "(dropped)" : echoed.toString("utf8"), "WINDOW-PAYLOAD",
    "payload arriving during the channel-opening window must be flushed, not lost");
  c.destroy();
  await close(slow);
}

// ── bulk transfer: the parser must retire once the channel opens ───────────
{
  const MIB = 1024 * 1024;
  const total = 64;
  let accepted = null;
  const observer = net.createServer((socket) => {
    accepted = socket;
    attachSocks5(socket, {
      forwardOut: (host, port, callback) => {
        const upstream = net.connect(port, host);
        upstream.once("connect", () => callback(null, upstream));
        upstream.once("error", callback);
      }
    });
  });
  const observerPort = await listen(observer);
  const c = net.connect(observerPort, "127.0.0.1");
  await new Promise((r) => c.once("connect", r));
  c.write(Buffer.from([0x05, 0x01, 0x00]));
  await readExactly(c, 2);
  const name = Buffer.from("localhost");
  c.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]), name, Buffer.from([(echoPort >> 8) & 0xff, echoPort & 0xff])]));
  await readExactly(c, 10);
  // The data path is pipe()'s alone now: the handshake parser must have been
  // removed. (Two 'data' listeners was the memory leak — every tunnelled byte
  // was concatenated into the parse buffer; one is the fix.) Deterministic,
  // unlike measuring external memory, which only drops after a GC.
  assert.equal(accepted.listenerCount("data"), 1,
    "after the channel opens, pipe() must be the only data listener (parser retired)");
  let received = 0;
  const drained = new Promise((resolve) => {
    const on = (data) => { received += data.length; if (received >= total * MIB) { c.removeListener("data", on); resolve(); } };
    c.on("data", on);
  });
  const chunk = Buffer.alloc(MIB, 0x41);
  for (let i = 0; i < total; i++) {
    c.write(chunk);
    await new Promise((r) => setImmediate(r));   // let the echo drain between writes
  }
  await drained;
  c.destroy();
  await close(observer);
  console.log(`bulk: ${total} MiB round-tripped through the tunnel (parser retired, data path is pipe's)`);
}

// ── close counting: exactly one onClose per served socket ───────────────────
{
  let active = 0;
  let closes = 0;
  const counted = net.createServer((socket) => {
    active += 1;
    attachSocks5(socket, {
      forwardOut: (host, port, callback) => {
        const upstream = net.connect(port, host);
        upstream.once("connect", () => callback(null, upstream));
        upstream.once("error", callback);
      },
      onClose: () => { closes += 1; active = Math.max(0, active - 1); }
    });
  });
  const countedPort = await listen(counted);
  const openOne = async () => {
    const c = net.connect(countedPort, "127.0.0.1");
    await new Promise((r) => c.once("connect", r));
    c.write(Buffer.from([0x05, 0x01, 0x00]));
    await readExactly(c, 2);
    const name = Buffer.from("localhost");
    c.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]), name, Buffer.from([(echoPort >> 8) & 0xff, echoPort & 0xff])]));
    await readExactly(c, 10);
    return c;
  };
  const a = await openOne();
  const b = await openOne();
  assert.equal(active, 2, "two live clients counted");
  a.destroy();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(closes, 1, "closing one client notifies onClose exactly once");
  assert.equal(active, 1, "closing one of two clients leaves one live connection");
  b.destroy();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(active, 0, "the last close drains the counter");
  await close(counted);
}

await close(proxy);
await close(echo);
console.log("socks5: greeting/request parsing, reply mapping and end-to-end forwarding all passed");
