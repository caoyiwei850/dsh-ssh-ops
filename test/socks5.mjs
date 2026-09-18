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
  { cmd: 0x01, host: "127.0.0.1", port: 8080 }
);
{
  const name = Buffer.from("db.internal", "utf8");
  const frame = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]), name, Buffer.from([0x01, 0xbb])]);
  assert.deepEqual(parseRequest(frame), { cmd: 0x01, host: "db.internal", port: 443 });
}
{
  // 2001:db8::1
  const frame = Buffer.from([0x05, 0x01, 0x00, 0x04, 0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0x00, 0x16]);
  assert.deepEqual(parseRequest(frame), { cmd: 0x01, host: "2001:db8:0:0:0:0:0:1", port: 22 });
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

await close(proxy);
await close(echo);
console.log("socks5: greeting/request parsing, reply mapping and end-to-end forwarding all passed");
