// #33: network-CLI execution path. Pure prompt/strip helpers, the PTY
// orchestration over a scripted device stream, the execOnConnection fallback
// routing, and the P0 guarantee that a stalled exec channel settles locally
// instead of hanging the caller forever.
import assert from "node:assert/strict";
import SshOpsService from "../src/index.js";
import { extractCliPrompt, promptReturned, cliPageRequested, stripCliOutput, sanitizeCliCommand, stripAnsiCodes } from "../src/network-cli.js";

// ── pure helpers ────────────────────────────────────────────────────────────
{
  assert.equal(stripAnsiCodes("\x1b[33mwarn\x1b[0m tail"), "warn tail");
  assert.equal(extractCliPrompt("Info: max VTY users is 10.\r\n<S12712>"), "<S12712>");
  assert.equal(extractCliPrompt("\r\n[S12712-GigabitEthernet0/0/1]"), "[S12712-GigabitEthernet0/0/1]");
  assert.equal(extractCliPrompt("Router> "), "Router>");
  assert.equal(extractCliPrompt("Router(config-if)#"), "Router(config-if)#");
  assert.equal(extractCliPrompt("display clock"), null, "plain output is not a prompt");
  assert.equal(extractCliPrompt(""), null);
  assert.equal(extractCliPrompt("noise\n\x1b[32m<S12712>\x1b[0m"), "<S12712>", "ANSI-wrapped prompt is recognised");
  assert.equal(promptReturned("<S12712>display clock\r\n2026-10-15 12:00:00\r\n<S12712>", "<S12712>"), true);
  assert.equal(promptReturned("<S12712>display clock\r\n2026-10-15 12:00:00", "<S12712>"), false, "unterminated output is not completion");
  assert.equal(cliPageRequested("  20, 30, 40:\r\n---- More ----"), true);
  assert.equal(cliPageRequested("plain output"), false);

  const full = "<S12712>display clock\r\n2026-10-15 12:00:00\r\n<S12712>";
  assert.equal(stripCliOutput(full, "<S12712>", "display clock"), "2026-10-15 12:00:00");
  const partial = stripCliOutput("<S12712>display log\r\nlong output so far", "<S12712>", "display log", { timedOut: true });
  assert.equal(partial, "long output so far", "timed-out output keeps its tail");

  assert.equal(sanitizeCliCommand("display clock").ok, true);
  assert.equal(sanitizeCliCommand("  display clock  ").value, "display clock");
  assert.equal(sanitizeCliCommand("display clock\r\nreboot").ok, false, "newline injection rejected");
  assert.equal(sanitizeCliCommand("").ok, false);
  assert.equal(sanitizeCliCommand("x".repeat(513)).ok, false);
}

// ── service stubs ───────────────────────────────────────────────────────────
function makeService() {
  const service = Object.create(SshOpsService.prototype);
  service.config = { maxBufferBytes: 65536, maxCaptureBytes: 65536, maxCommandOutputBytes: 65536 };
  service.connections = new Map();
  service.sessions = new Map();
  service.exitedSessions = new Map();
  return service;
}

/** A device stream: `script(writtenSoFar, chunk)` returns what the device emits. */
function fakeDeviceStream(script) {
  const writes = [];
  const listeners = new Map();
  return {
    writes,
    on(event, fn) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); },
    removeListener(event, fn) { const list = listeners.get(event) ?? []; const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); },
    write(chunk) {
      writes.push(chunk);
      const out = script(writes.join(""), chunk);
      if (out) for (const fn of [...(listeners.get("data") ?? [])]) fn(Buffer.from(out));
    }
  };
}

function makeSession(bufferTail) {
  const session = {
    id: "s1", exited: null, stream: null,
    buffer: bufferTail, inputLine: "", inputKnown: true
  };
  return session;
}

function fakeConn(sessions = []) {
  const conn = { id: "c1", sessions: new Set(sessions.map((s) => s.id)), cliBusy: false };
  return conn;
}

const VRP_TAIL = "Info: The max number of VTY users is 10.\r\n<S12712>";

// ── cliExecOnSession: the happy path ────────────────────────────────────────
{
  const service = makeService();
  const stream = fakeDeviceStream((written) => {
    if (!written.includes("display clock")) return null;
    return "display clock\r\n2026-10-15 12:00:00 Wednesday\r\n<S12712>";
  });
  const session = makeSession(VRP_TAIL);
  session.stream = stream;
  const conn = fakeConn([session]);
  service.sessions.set(session.id, session);

  const result = await service.cliExecOnSession(conn, session, "display clock", 5000);
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.value.stdout, "2026-10-15 12:00:00 Wednesday", "echoed line and returned prompt are stripped");
  assert.equal(result.value.exitCode, null, "network CLI has no POSIX exit code");
  assert.equal(result.value.cwd, null);
  assert.equal(result.value.timedOut, false);
  assert.deepEqual(stream.writes[0], "\x15display clock\r", "the line is cleared then submitted");
  assert.equal(conn.cliBusy, false, "the busy flag is released");
}

// ── paging: the device stops at ---- More ----, a space advances it ─────────
{
  const service = makeService();
  let pages = 0;
  const stream = fakeDeviceStream((written, chunk) => {
    if (chunk === " ") {
      if (pages === 1) { pages = 2; return "\r\npage two\r\n<S12712>"; }
      return null;
    }
    if (!written.includes("display log")) return null;
    if (pages === 0) { pages = 1; return "display log\r\npage one\r\n---- More ----"; }
    return null;
  });
  const session = makeSession(VRP_TAIL);
  session.stream = stream;
  const conn = fakeConn([session]);
  service.sessions.set(session.id, session);

  const result = await service.cliExecOnSession(conn, session, "display log", 5000);
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.value.stdout, "page one\npage two");
  assert.equal(stream.writes.filter((w) => w === " ").length, 1, "exactly one paging space was sent");
}

// ── timeout: the device never returns the prompt ────────────────────────────
{
  const service = makeService();
  const stream = fakeDeviceStream((written) => (written.includes("display log") ? "display log\r\nstill scrolling" : null));
  const session = makeSession(VRP_TAIL);
  session.stream = stream;
  const conn = fakeConn([session]);
  service.sessions.set(session.id, session);

  const result = await service.cliExecOnSession(conn, session, "display log", 300);
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.value.timedOut, true);
  assert.match(result.value.stdout, /still scrolling/, "partial output is preserved for diagnosis");
}

// ── output cap: a flooding device cannot pour unbounded bytes at the agent ──
{
  const service = makeService();
  service.config.maxCommandOutputBytes = 1024;
  const flood = "x".repeat(64 * 1024);
  const stream = fakeDeviceStream((written) => (written.includes("display huge") ? `display huge\r\n${flood}\r\n<S12712>` : null));
  const session = makeSession(VRP_TAIL);
  session.stream = stream;
  const conn = fakeConn([session]);
  service.sessions.set(session.id, session);

  const result = await service.cliExecOnSession(conn, session, "display huge", 5000);
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.value.truncated, true, "dropped bytes are reported, not hidden");
  assert.ok(
    Buffer.byteLength(result.value.stdout, "utf8") <= 1024,
    `stdout stays inside maxCommandOutputBytes (saw ${Buffer.byteLength(result.value.stdout, "utf8")})`
  );
  assert.equal(stream.writes.filter((w) => w === " ").length, 0, "the retained tail still recognises the prompt: no paging loop");
}

// ── guards: busy mutex, unknown prompt, no terminal ─────────────────────────
{
  const service = makeService();
  const stream = fakeDeviceStream(() => null);
  const session = makeSession(VRP_TAIL);
  session.stream = stream;
  const conn = fakeConn([session]);
  service.sessions.set(session.id, session);

  conn.cliBusy = true;
  const busy = await service.cliExecOnSession(conn, session, "display clock");
  assert.equal(busy.error.code, "cli-busy");
  conn.cliBusy = false;

  const bare = makeSession("random scrolling output\r\nnothing prompt-like");
  bare.stream = fakeDeviceStream(() => null);
  const noPrompt = await service.cliExecOnSession(conn, bare, "display clock");
  assert.equal(noPrompt.error.code, "cli-prompt-unrecognized", "refuse rather than guess (#33 expectation 4)");

  const lonely = fakeConn([]);
  const noTerminal = await service.cliExecOnConnection(lonely, "display clock");
  assert.equal(noTerminal.error.code, "cli-no-terminal");
  assert.match(noTerminal.error.message, /打开该设备的终端/, "the error tells the operator what to do (#33 P1)");
}

// ── routing: execStalled short-circuits exec; first stall falls through ─────
{
  const service = makeService();
  const conn = fakeConn([]);
  service.connections.set("c1", conn);
  service.resolveLoginShell = async () => null;

  conn.execStalled = true;
  let execTried = 0;
  service.runPreparedExec = async () => { execTried += 1; return { ok: true, value: {} }; };
  service.cliExecOnConnection = async () => ({ ok: true, value: { stdout: "via cli", timedOut: false } });
  const routed = await service.execOnConnection("c1", "display clock");
  assert.equal(routed.value.stdout, "via cli", "a stalled connection goes straight to the terminal path");
  assert.equal(execTried, 0, "the exec channel is not re-tried on a stalled connection");

  conn.execStalled = false;
  service.runPreparedExec = async () => ({ ok: true, value: { exitCode: 0, stdout: "posix output", stderr: "", cwd: "/x", commandId: "c", startedAt: "", finishedAt: "", durationMs: 1, truncated: false, timedOut: false } });
  const posix = await service.execOnConnection("c1", "ls");
  assert.equal(posix.value.stdout, "posix output", "healthy exec is untouched");
  assert.equal(conn.execStalled, false, "healthy exec does not mark the connection");

  service.runPreparedExec = async () => ({ ok: true, value: { exitCode: null, stdout: "", stderr: "", cwd: null, commandId: "c", startedAt: "", finishedAt: "", durationMs: 5000, truncated: false, timedOut: true } });
  let cliCalled = 0;
  service.cliExecOnConnection = async () => { cliCalled += 1; return { ok: true, value: { stdout: "via cli", timedOut: false } }; };
  // A device signature: the login-shell probe came back empty, so the exec
  // channel opened without ever answering.
  conn.loginShell = null;
  const fellThrough = await service.execOnConnection("c1", "display clock");
  assert.equal(fellThrough.value.stdout, "via cli", "a first-contact stall falls through to the terminal path in the same call");
  assert.equal(conn.execStalled, true, "the stall is remembered for later calls");
  assert.equal(cliCalled, 1);

  // The SAME silent timeout on a host whose login shell answered is not a
  // device: it is a slow, quiet command (`sleep 45`, a build that prints
  // nothing), and the caller must get its honest timeout result. Reacting to
  // the timeout alone downgraded healthy connections for the rest of their
  // life — every later ssh_exec failed with "network CLI prompt unrecognised".
  conn.execStalled = false;
  conn.loginShell = "bash";
  cliCalled = 0;
  const healthy = await service.execOnConnection("c1", "sleep 45");
  assert.equal(healthy.ok, true, "the honest timeout result comes back");
  assert.equal(healthy.value.timedOut, true);
  assert.equal(cliCalled, 0, "no terminal detour on a POSIX host");
  assert.equal(conn.execStalled, false, "a healthy host is never marked as a device");

  // A stale flag does not outlive the proof that exec works: a known POSIX
  // login shell is never diverted, and the exec that settles clears the flag.
  conn.execStalled = true;
  conn.loginShell = "bash";
  service.runPreparedExec = async () => ({ ok: true, value: { exitCode: 0, stdout: "recovered", stderr: "", cwd: "/x", commandId: "c", startedAt: "", finishedAt: "", durationMs: 1, truncated: false, timedOut: false } });
  const recovered = await service.execOnConnection("c1", "echo ok");
  assert.equal(recovered.value.stdout, "recovered", "a known POSIX shell is never diverted to the terminal");
  assert.equal(conn.execStalled, false, "a successful exec clears the remembered stall");

  // The deny-list still gates the CLI path: destructive commands never type.
  service.cliExecOnConnection = async () => { throw new Error("must not be called"); };
  const blocked = await service.execOnConnection("c1", "rm -rf /tmp/x");
  assert.equal(blocked.blocked, true, "deny-list runs before any routing");
}

// ── P0: a stalled exec channel settles locally on timeout, never hangs ──────
{
  const service = makeService();
  let closed = false;
  const stream = {
    on() {},
    stderr: { on() {} },
    close() { closed = true; }
  };
  const client = { exec: (cmd, opts, cb) => cb(null, stream) };
  const state = await service.collectExecOutput(client, "echo $SHELL", 50);
  assert.equal(state.timedOut, true, "the deadline resolves the call locally (#33)");
  assert.equal(closed, true, "the channel close is still attempted");
}

console.log("network cli: prompts, stripping, paging, guards, routing, P0 settle: passed");
