import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAgentForwarding } from "../src/ssh-agent.js";
import { createAuthTracker, makeAuthHandler } from "../src/ssh-auth.js";

test("disabled forwarding leaves the connect config untouched", () => {
  const config = { host: "h", username: "u" };
  assert.deepEqual(applyAgentForwarding(config, false, {}), { ok: true });
  assert.deepEqual(applyAgentForwarding(config, undefined, { SSH_AUTH_SOCK: "/sock" }), { ok: true });
  assert.equal("agent" in config, false);
  assert.equal("agentForward" in config, false);
});

test("enabled forwarding with a local agent wires agent + agentForward", () => {
  const config = { host: "h", username: "u" };
  const applied = applyAgentForwarding(config, true, { SSH_AUTH_SOCK: "/tmp/agent.sock" });
  assert.equal(applied.ok, true);
  assert.equal(config.agent, "/tmp/agent.sock");
  assert.equal(config.agentForward, true);
});

test("enabled forwarding without a local agent fails fast without mutating the config", () => {
  const config = { host: "h", username: "u" };
  const applied = applyAgentForwarding(config, true, {});
  assert.equal(applied.ok, false);
  assert.equal(applied.error.code, "agent-unavailable");
  assert.match(applied.error.message, /SSH_AUTH_SOCK/);
  assert.equal("agent" in config, false);

  // An empty-string socket counts as absent (some CI environments export it).
  const empty = { host: "h" };
  assert.equal(applyAgentForwarding(empty, true, { SSH_AUTH_SOCK: "" }).ok, false);
});

test("the default env is process.env (a set SSH_AUTH_SOCK is picked up)", () => {
  const previous = process.env.SSH_AUTH_SOCK;
  try {
    process.env.SSH_AUTH_SOCK = "/tmp/test-agent.sock";
    const config = {};
    assert.equal(applyAgentForwarding(config, true).ok, true);
    assert.equal(config.agent, "/tmp/test-agent.sock");
  } finally {
    if (previous === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = previous;
  }
});

test("auth handler offers the agent method only when an agent is available", () => {
  const withAgent = createAuthTracker();
  const handler = makeAuthHandler(withAgent, { hasPassword: false, hasPrivateKey: false, hasAgent: true, tryKeyboard: false });
  const offered = [];
  for (;;) {
    const next = handler(undefined, false, () => {});
    if (next === false) break;
    offered.push(next);
  }
  assert.deepEqual(offered, ["none", "agent"]);

  const withoutAgent = createAuthTracker();
  const keyOnly = makeAuthHandler(withoutAgent, { hasPassword: false, hasPrivateKey: true, hasAgent: false, tryKeyboard: false });
  const order = [];
  for (;;) {
    const next = keyOnly(undefined, false, () => {});
    if (next === false) break;
    order.push(next);
  }
  // Mirrors ssh2's own authsAllowed order: publickey before agent, agent
  // before keyboard-interactive.
  assert.deepEqual(order, ["none", "publickey"]);
  assert.equal(order.includes("agent"), false);
});

test("full method order keeps ssh2's authsAllowed sequence with the agent slotted in", () => {
  const tracker = createAuthTracker();
  const handler = makeAuthHandler(tracker, { hasPassword: true, hasPrivateKey: true, hasAgent: true, tryKeyboard: true });
  const order = [];
  for (;;) {
    const next = handler(undefined, false, () => {});
    if (next === false) break;
    order.push(next);
  }
  assert.deepEqual(order, ["none", "password", "publickey", "agent", "keyboard-interactive"]);
});
