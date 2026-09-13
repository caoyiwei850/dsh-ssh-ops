// Which connection the agent operates on. The agent omits connection_id and the
// host resolves it to the ACTIVE connection, so the panel's "click a pane to
// hand the agent that pane" gesture has to be able to move that binding — and a
// failed move must never silently leave the agent pointing at nothing.
import assert from "node:assert/strict";
import SshOpsService from "../src/index.js";

function connection(id, overrides = {}) {
  return { id, host: "10.0.0.5", port: 22, username: "root", dead: false, closing: false, connecting: false, sessions: new Set(), ...overrides };
}

function makeService(records) {
  const service = Object.create(SshOpsService.prototype);
  service.connections = new Map(records);
  service.activeConnectionId = null;
  return service;
}

// ── a click binds the agent to that pane's connection ──
{
  const service = makeService([["a", connection("a")], ["b", connection("b")]]);
  service.activeConnectionId = "a";
  const result = await service.selectConnection({ connectionId: "b" });
  assert.equal(result.ok, true);
  assert.equal(result.value.activeConnectionId, "b");
  assert.equal(service.activeConnectionId, "b", "the agent's next tool call targets the clicked pane");
}

// ── re-binding to the pane already bound is a harmless no-op ──
{
  const service = makeService([["a", connection("a")]]);
  service.activeConnectionId = "a";
  const result = await service.selectConnection({ connectionId: "a" });
  assert.equal(result.ok, true);
  assert.equal(service.activeConnectionId, "a");
}

// ── an unknown connection is refused, and the old binding survives ──
// Clearing it on a typo would leave the agent with no target at all while the
// operator believes it is still on the server shown in the pane.
{
  const service = makeService([["a", connection("a")]]);
  service.activeConnectionId = "a";
  const result = await service.selectConnection({ connectionId: "gone" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "no-connection");
  assert.equal(service.activeConnectionId, "a", "a failed switch must not clear the binding");
}

// ── a dead or closing connection can never become the agent's target ──
{
  const dead = makeService([["d", connection("d", { dead: true })]]);
  dead.activeConnectionId = "a";
  const deadResult = await dead.selectConnection({ connectionId: "d" });
  assert.equal(deadResult.ok, false);
  assert.equal(deadResult.error.code, "connection-lost");
  assert.equal(dead.activeConnectionId, "a", "an unreachable pane must not steal the binding");

  const closing = makeService([["c", connection("c", { closing: true })]]);
  const closingResult = await closing.selectConnection({ connectionId: "c" });
  assert.equal(closingResult.ok, false);
  assert.equal(closingResult.error.code, "connection-lost");
}

// ── selecting does not disturb the connection itself ──
{
  const record = connection("a");
  const service = makeService([["a", record]]);
  await service.selectConnection({ connectionId: "a" });
  assert.equal(record.dead, false);
  assert.equal(record.closing, false);
  assert.equal(service.connections.size, 1, "selection never creates or drops a transport");
}

console.log("active connection: click-to-bind semantics passed");
