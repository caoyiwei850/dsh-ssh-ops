import assert from "node:assert/strict";
import { startAgentConnectionPoll } from "../src/client/agent-connection-poll.js";

let tick;
let delay;
let cleared = false;
const announced = [];
const stop = startAgentConnectionPoll(
  { list: async () => ({ connections: [{ connectionId: "agent-1", agentRevealId: "request-1" }] }) },
  (connections) => announced.push(connections),
  {
    setInterval: (callback, ms) => { tick = callback; delay = ms; return 7; },
    clearInterval: (id) => { assert.equal(id, 7); cleared = true; }
  }
);
assert.equal(delay, 2500, "the poll starts when the plugin applies");
await tick();
assert.deepEqual(announced, [[{ connectionId: "agent-1", agentRevealId: "request-1" }]]);
stop();
assert.equal(cleared, true, "unload clears the active timer");
await tick();
assert.equal(announced.length, 1, "a queued tick after unload does nothing");

console.log("agent connection poll: starts, announces, and stops cleanly");
