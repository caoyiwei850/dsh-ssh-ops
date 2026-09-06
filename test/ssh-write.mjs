// ssh_write chain: press_enter semantics, connection_id targeting, the
// terminal input policy gate, and lazy session opening (0.2.19 feature set,
// previously untested). Runs the real service methods over a prototype stub —
// no ssh2 transport involved.
import assert from "node:assert/strict";
import SshOpsService from "../src/index.js";

function makeService() {
  const service = Object.create(SshOpsService.prototype);
  service.config = { maxBufferBytes: 65536, maxCaptureBytes: 65536 };
  service.connections = new Map();
  service.sessions = new Map();
  service.activeConnectionId = null;
  return service;
}

/** A live session whose stream records every write. */
function attachSession(service, connectionId, sessionId = "s1") {
  const writes = [];
  const session = {
    id: sessionId,
    exited: null,
    stream: { write(chunk) { writes.push(chunk); } },
    buffer: "",
    captureBuffer: "",
    inputLine: "",
    inputKnown: true,
    waiters: []
  };
  const conn = {
    id: connectionId,
    host: connectionId,
    username: "root",
    sessions: new Set([sessionId]),
    sftp: null,
    dead: false,
    closing: false
  };
  service.connections.set(connectionId, conn);
  service.sessions.set(sessionId, session);
  return { conn, session, writes };
}

function joined(writes) {
  return writes.join("");
}

// ── writeToConnection: forwarding, Enter guard, mirror reset ──
{
  const service = makeService();
  const { session, writes } = attachSession(service, "c1");
  service.activeConnectionId = "c1";

  const safe = service.writeToConnection("c1", "ls -la\r");
  assert.equal(safe.ok, true);
  assert.equal(safe.value.written, "ls -la\r".length);
  assert.equal(joined(writes), "ls -la\r");
  assert.equal(session.inputLine, "", "Enter clears the input mirror");

  const dangerous = service.writeToConnection("c1", "rm -rf /tmp/x\r");
  assert.equal(dangerous.ok, false);
  assert.equal(dangerous.error.code, "unsafe-command");
  // The Enter keystroke itself must never reach the shell: the tail is the
  // Ctrl-U line kill, not a carriage return.
  assert.ok(!joined(writes).endsWith("\r"), "blocked Enter is replaced with Ctrl-U");
  assert.equal(session.inputLine, "");
  assert.ok(session.captureBuffer.includes("安全策略"), "policy notice lands in the terminal buffer");

  // Ctrl-C clears the mirror so a previously blocked line cannot be submitted
  // by a later Enter.
  const before = session.inputKnown;
  service.writeToConnection("c1", "\x03");
  assert.equal(session.inputKnown, true);
  assert.equal(session.inputLine, "");
  assert.ok(before);
}

// ── writeCurrentConnection: active vs explicit targeting ──
{
  const service = makeService();
  const a = attachSession(service, "conn-a", "sa");
  const b = attachSession(service, "conn-b", "sb");
  service.activeConnectionId = "conn-a";

  const explicit = service.writeCurrentConnection({ connectionId: "conn-b", input: "hostname\r" });
  assert.equal(explicit.ok, true);
  assert.equal(joined(b.writes), "hostname\r", "explicit connection_id targets that server");
  assert.equal(joined(a.writes), "", "other connection is untouched");

  const active = service.writeCurrentConnection({ input: "whoami\r" });
  assert.equal(active.ok, true);
  assert.equal(joined(a.writes), "whoami\r", "no connection_id falls back to the active connection");
  assert.equal(joined(b.writes), "hostname\r");

  const missing = service.writeCurrentConnection({ connectionId: "nope", input: "x" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "no-connection");

  // Multiple open connections and no active id → the tool must not guess.
  service.activeConnectionId = null;
  const ambiguous = service.writeCurrentConnection({ input: "id\r" });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.error.code, "connection-selection-required");
}

// ── ensureSessionForWrite: live reuse vs lazy open ──
{
  const service = makeService();
  attachSession(service, "c1");
  service.activeConnectionId = "c1";
  const reused = await service.ensureSessionForWrite("c1");
  assert.equal(reused.ok, true);
  assert.equal(reused.connectionId, "c1");

  // Dead session (exited) is not live: a lazy open must happen instead of a
  // silent 0-byte write.
  const { conn } = attachSession(service, "c2", "s2");
  service.sessions.get("s2").exited = { code: 0 };
  conn.sessions.clear();
  let openCalls = 0;
  service.openSession = async (request) => {
    openCalls += 1;
    assert.equal(request.connectionId, "c2");
    return { ok: true, value: { sessionId: "opened" } };
  };
  const opened = await service.ensureSessionForWrite("c2");
  assert.equal(opened.ok, true);
  assert.equal(openCalls, 1, "a connection without a live session opens one lazily");
}

// ── tool-level ssh_write: press_enter default and explicit false ──
{
  const service = makeService();
  const { writes } = attachSession(service, "c1");
  service.activeConnectionId = "c1";
  const registered = [];
  service.registerTools({ tools: { register: (def) => registered.push(def) }, effect: () => {} });
  const sshWrite = registered.find((def) => def.name === "ssh_write");
  assert.ok(sshWrite, "ssh_write tool is registered");

  const withEnter = await sshWrite.execute({ input: "ls -la" });
  assert.deepEqual(withEnter, { written: "ls -la\r".length }, "press_enter defaults to true and appends \\r");
  assert.ok(joined(writes).endsWith("\r"));

  const raw = await sshWrite.execute({ input: "y", press_enter: false });
  assert.equal(raw.written, 1, "press_enter=false sends raw input only");

  // Input already ending in a newline is not double-submitted.
  const trailing = await sshWrite.execute({ input: "echo hi\n" });
  assert.equal(trailing.written, "echo hi\n".length);
}

// ── policy gate edge cases: tab/escape poison the mirror, long lines fail closed ──
{
  const service = makeService();
  attachSession(service, "c1");
  service.activeConnectionId = "c1";

  // Tab completion changes the remote line without a trustworthy local copy:
  // the next Enter must be blocked even though the typed text looks safe.
  const tabbed = service.writeToConnection("c1", "cat /etc/pass\x1b[1~wd\r");
  // (escape sequence contains \x1b → mirror poisoned; final Enter blocked)
  assert.equal(tabbed.ok, false);
  assert.equal(tabbed.error.code, "unsafe-command");

  // Ctrl-C after poisoning restores a known-empty line: Enter passes again.
  service.writeToConnection("c1", "\x03");
  const recovered = service.writeToConnection("c1", "free -h\r");
  assert.equal(recovered.ok, true);

  // Overlong input exceeds the mirror cap and fails closed.
  const huge = service.writeToConnection("c1", "x".repeat(9000) + "\r");
  assert.equal(huge.ok, false);
  assert.equal(huge.error.code, "unsafe-command");
}

console.log("ssh_write: targeting, press_enter, policy gate: all cases passed");
