// terminalStream host generator: buffered-output handover, live push, idle
// keepalive heartbeat, exit termination, abort cleanup, and per-listener
// isolation. Uses the prototype stub — no ssh2 transport.
import assert from "node:assert/strict";
import SshOpsService from "../src/index.js";

function makeService(heartbeatMs = 40) {
  const service = Object.create(SshOpsService.prototype);
  service.config = { streamHeartbeatMs: heartbeatMs };
  service.connections = new Map();
  service.sessions = new Map();
  service.exitedSessions = new Map();
  service.pendingConfirmations = new Map();
  return service;
}

function attachSession(service, sessionId) {
  const session = {
    id: sessionId,
    connectionId: "c1",
    buffer: "",
    captureBuffer: "",
    waiters: [],
    streamListeners: new Set(),
    exited: null,
    stream: { write() {} }
  };
  const conn = { id: "c1", sessions: new Set([sessionId]) };
  service.sessions.set(sessionId, session);
  service.connections.set("c1", conn);
  return session;
}

function decodeItem(item) {
  assert.equal(item.ok, true, JSON.stringify(item));
  return {
    data: item.value.data ? Buffer.from(item.value.data, "base64").toString("utf8") : "",
    exit: item.value.exit
  };
}

// ── missing session yields one error envelope and ends ──
{
  const service = makeService();
  const gen = service.terminalStream({ sessionId: "ghost" });
  const first = await gen.next();
  assert.equal(first.value.ok, false);
  assert.equal(first.value.error.code, "no-session");
  assert.equal((await gen.next()).done, true);
}

// ── buffered output is handed over on attach, then live push flows ──
{
  const service = makeService();
  const session = attachSession(service, "s1");
  session.buffer = "MOTD\r\n"; // arrived before the client subscribed

  const gen = service.terminalStream({ sessionId: "s1" });
  const first = await gen.next();
  assert.deepEqual(decodeItem(first.value), { data: "MOTD\r\n", exit: null });

  // Live output lands on the next tick.
  const pending = gen.next();
  await new Promise((resolve) => setTimeout(resolve, 5));
  service.appendSessionOutput(session, "hello\r\n");
  const second = await pending;
  assert.deepEqual(decodeItem(second.value), { data: "hello\r\n", exit: null });

  await gen.return();
}

// ── idle terminal emits keepalive heartbeats so the client can tell
//    quiet-but-alive from a dead mux ──
{
  const service = makeService(20);
  attachSession(service, "s1");
  const gen = service.terminalStream({ sessionId: "s1" });
  const first = await gen.next();
  assert.deepEqual(decodeItem(first.value), { data: "", exit: null }, "heartbeat item on an idle terminal");
  await gen.return();
}

// ── session exit terminates the stream with the exit item ──
{
  const service = makeService(20);
  const session = attachSession(service, "s1");
  const gen = service.terminalStream({ sessionId: "s1" });
  await gen.next(); // heartbeat

  const pending = gen.next();
  session.exited = { code: 0 };
  service.notifyStreamListeners(session, "");
  const final = await pending;
  assert.deepEqual(decodeItem(final.value), { data: "", exit: { code: 0 } });
  assert.equal((await gen.next()).done, true);
  assert.equal(session.streamListeners.size, 0, "listener removed after exit");
}

// ── client abort stops the generator and cleans up the listener ──
{
  const service = makeService(20);
  const session = attachSession(service, "s1");
  const controller = new AbortController();
  const gen = service.terminalStream({ sessionId: "s1" }, controller.signal);
  await gen.next();
  controller.abort();
  const stopped = await gen.next();
  assert.equal(stopped.done, true, "abort ends the stream");
  assert.equal(session.streamListeners.size, 0);
}

// ── output survives abort in the shared journal; readers never copy it back ──
{
  const service = makeService(20);
  const session = attachSession(service, "s1");
  const controller = new AbortController();
  const gen = service.terminalStream({ sessionId: "s1" }, controller.signal);
  await gen.next(); // heartbeat establishes the listener

  // Output lands while the client is waiting, then the view disappears.
  const pending = gen.next();
  await new Promise((resolve) => setTimeout(resolve, 5));
  service.appendSessionOutput(session, "lost-without-handback\r\n");
  assert.equal(session.buffer, "lost-without-handback\r\n", "legacy poll buffer remains independent");
  controller.abort();
  await pending;

  assert.equal(session.streamListeners.size, 0, "listener removed");
  assert.equal(service.terminalOutput(session).read().data, "lost-without-handback\r\n", "journal retains the event once");

  // The next attach replays exactly that output, once — no duplication.
  const next = service.terminalStream({ sessionId: "s1" });
  const first = await next.next();
  assert.deepEqual(decodeItem(first.value), { data: "lost-without-handback\r\n", exit: null });
  assert.equal(session.buffer, "lost-without-handback\r\n", "stream attach does not consume the legacy poll buffer");
  await next.return();
}

// ── normal delivery never duplicates: yielded data does not return to the buffer ──
{
  const service = makeService(20);
  const session = attachSession(service, "s1");
  const controller = new AbortController();
  const gen = service.terminalStream({ sessionId: "s1" }, controller.signal);
  await gen.next();
  const pending = gen.next();
  await new Promise((resolve) => setTimeout(resolve, 5));
  service.appendSessionOutput(session, "delivered\r\n");
  const item = await pending;
  assert.equal(decodeItem(item.value).data, "delivered\r\n");
  controller.abort();
  await gen.next();
  assert.equal(service.terminalOutput(session).read(item.value.value.offset).data, "", "resume offset skips consumed output");
}

// ── two concurrent consumers each receive the full output ──
{
  const service = makeService(20);
  const session = attachSession(service, "s1");
  const genA = service.terminalStream({ sessionId: "s1" });
  const genB = service.terminalStream({ sessionId: "s1" });
  await genA.next();
  await genB.next();

  const pendingA = genA.next();
  const pendingB = genB.next();
  await new Promise((resolve) => setTimeout(resolve, 5));
  service.appendSessionOutput(session, "broadcast");
  const [a, b] = await Promise.all([pendingA, pendingB]);
  assert.equal(decodeItem(a.value).data, "broadcast");
  assert.equal(decodeItem(b.value).data, "broadcast", "listeners are independent, not competing like waiters");
  await genA.return();
  await genB.return();
}

console.log("terminal stream: handover, push, heartbeat, exit, abort, multi-listener: all cases passed");
