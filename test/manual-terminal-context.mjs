import assert from "node:assert/strict";
import SshOpsService from "../src/index.js";
import { registerSshSessionTools } from "../src/tools/ssh-session.js";

function makeService() {
  const service = Object.create(SshOpsService.prototype);
  service.config = { maxBufferBytes: 1024 };
  service.sessions = new Map();
  service.connections = new Map([[
    "conn-a",
    { id: "conn-a", name: "staging", host: "192.0.2.20", port: 22, sessions: new Set(["shell-a"]) }
  ]]);
  service.sessions.set("shell-a", {
    id: "shell-a",
    connectionId: "conn-a",
    buffer: "",
    openedAt: "2026-09-14T00:00:00.000Z",
    openedBy: "panel",
    exited: null,
    stream: {},
    waiters: [],
    streamListeners: new Set()
  });
  return service;
}

// An agent can identify the human-operated terminal without receiving output.
{
  const service = makeService();
  service.appendSessionOutput(service.sessions.get("shell-a"), "deploy started\n");
  const listed = service.listTerminalContexts();
  assert.deepEqual(listed, {
    ok: true,
    value: {
      sessions: [{
        sessionId: "shell-a",
        connectionId: "conn-a",
        name: "staging",
        host: "192.0.2.20",
        port: 22,
        openedAt: "2026-09-14T00:00:00.000Z",
        openedBy: "panel",
        alive: true,
        historyStart: 0,
        historyEnd: 15
      }]
    }
  });
}

// Incremental context reads use a byte limit, redact secrets, and do not drain
// the terminal journal that the UI and existing readers use.
{
  const service = makeService();
  const session = service.sessions.get("shell-a");
  service.appendSessionOutput(session, "first line\nPASSWORD=secret-value\nlast line\n");
  const before = service.terminalOutput(session).read().data;
  const first = service.readTerminalContext({ sessionId: "shell-a", after: 0, maxBytes: 24 });
  assert.equal(first.ok, true);
  assert.equal(first.value.redacted, true);
  assert.doesNotMatch(first.value.data, /secret-value/);
  assert.equal(first.value.hasMore, true);
  assert.equal(service.terminalOutput(session).read().data, before, "context reading must not consume UI history");

  const next = service.readTerminalContext({ sessionId: "shell-a", after: first.value.nextOffset, maxBytes: 96 });
  assert.equal(next.ok, true);
  assert.match(next.value.data, /last line/);
  assert.equal(next.value.hasMore, false);
}

// Reading terminal context is deliberately approval-gated at tool execution.
{
  const registrations = [];
  let beforeExecute;
  registerSshSessionTools({
    tools: { register: (tool) => registrations.push(tool) },
    on: (event, handler) => { if (event === "tools/pre-execute") beforeExecute = handler; }
  }, makeService());
  assert.ok(registrations.some((tool) => tool.name === "ssh_terminal_sessions"));
  assert.ok(registrations.some((tool) => tool.name === "ssh_terminal_context"));
  assert.deepEqual(beforeExecute?.({ name: "ssh_terminal_context" }), {
    kind: "ask",
    reason: "Agent requests recent manual SSH terminal activity, which may contain sensitive output."
  });
}

console.log("manual terminal context: session discovery, bounded redacted history, approval gate: passed");
