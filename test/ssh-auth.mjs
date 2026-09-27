import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAuthTracker,
  makeAuthHandler,
  classifyConnectFailure,
  formatConnectFailure,
  wasAuthCut,
  CONNECT_FAILURE_STAGES
} from "../src/ssh-auth.js";

function authError(message, level) {
  const err = new Error(message);
  if (level) err.level = level;
  return err;
}

test("auth handler walks ssh2's default order and records attempts", () => {
  const tracker = createAuthTracker();
  const handler = makeAuthHandler(tracker, { hasPassword: true, hasPrivateKey: true, tryKeyboard: true });
  const calls = [];
  // ssh2 calls the handler repeatedly; the callback receives the next method.
  for (let i = 0; i < 5; i += 1) {
    const next = handler(["password", "keyboard-interactive"], false, () => {});
    calls.push(next);
    if (next === false) break;
  }
  assert.deepEqual(calls, ["none", "password", "publickey", "keyboard-interactive", false]);
  assert.deepEqual(tracker.attempts, ["none", "password", "publickey", "keyboard-interactive"]);
  // The server's remaining-methods list from the last USERAUTH_FAILURE is kept.
  assert.deepEqual(tracker.lastMethodsLeft, ["password", "keyboard-interactive"]);
  assert.equal(tracker.sawFailure, true);
});

test("auth handler only offers configured credentials", () => {
  const tracker = createAuthTracker();
  const handler = makeAuthHandler(tracker, { hasPassword: false, hasPrivateKey: true, tryKeyboard: false });
  const calls = [];
  for (;;) {
    const next = handler(undefined, false, () => {});
    calls.push(next);
    if (next === false) break;
  }
  assert.deepEqual(calls, ["none", "publickey", false]);
});

test("auth rejection is classified with server-allowed detail", () => {
  const tracker = createAuthTracker();
  tracker.attempts.push("none", "password");
  tracker.lastMethodsLeft = ["keyboard-interactive"];
  tracker.sawFailure = true;
  const diagnosis = classifyConnectFailure(
    authError("All configured authentication methods failed", "client-authentication"),
    tracker,
    { hasPassword: true, hasPrivateKey: false, tryKeyboard: true }
  );
  assert.equal(diagnosis.stage, CONNECT_FAILURE_STAGES.AUTH);
  assert.equal(diagnosis.reason, "auth-rejected");
  assert.match(diagnosis.message, /tried: none, password/);
  assert.ok(diagnosis.hints.some((h) => h.includes("server still accepts: keyboard-interactive")));
  assert.ok(diagnosis.hints.some((h) => h.includes("MFA")));
  const text = formatConnectFailure(diagnosis, "admin@10.0.0.1:22");
  assert.match(text, /^admin@10\.0\.0\.1:22: /);
  assert.match(text, /Likely causes/);
});

test("transport cut with no auth evidence stays a network failure", () => {
  const diagnosis = classifyConnectFailure(
    authError("connection closed before handshake completed"),
    createAuthTracker(),
    { hasPassword: true }
  );
  assert.equal(diagnosis.stage, CONNECT_FAILURE_STAGES.TRANSPORT);
  assert.ok(diagnosis.hints.length > 0);
});

test("wasAuthCut triggers only after auth actually started", () => {
  const fresh = createAuthTracker();
  assert.equal(wasAuthCut(fresh, authError("connection closed before handshake completed")), false);

  const midKbd = createAuthTracker();
  midKbd.kbdSeen = true;
  assert.equal(wasAuthCut(midKbd, authError("connection closed before handshake completed")), true);
  assert.equal(wasAuthCut(midKbd, authError("read ECONNRESET")), true);
  assert.equal(wasAuthCut(midKbd, authError("All configured authentication methods failed", "client-authentication")), false);

  const afterFailure = createAuthTracker();
  afterFailure.attempts.push("none", "password");
  assert.equal(wasAuthCut(afterFailure, authError("connection closed before handshake completed")), true);
});

test("protocol failures map to their device hint", () => {
  const diagnosis = classifyConnectFailure(
    authError("Handshake failed: signature verification failed", "handshake"),
    createAuthTracker(),
    {}
  );
  assert.equal(diagnosis.stage, CONNECT_FAILURE_STAGES.PROTOCOL);
  assert.ok(diagnosis.hints[0].includes("off-spec") || diagnosis.hints[0].includes("key changed"));

  const kex = classifyConnectFailure(
    authError("Protocol negotiation with the server failed: no matching key exchange method", "handshake"),
    createAuthTracker(),
    {}
  );
  assert.ok(kex.hints[0].includes("legacy"));
});

test("unknown errors pass through without throwing", () => {
  const diagnosis = classifyConnectFailure(new Error("getaddrinfo ENOTFOUND x"), createAuthTracker(), {});
  assert.equal(diagnosis.stage, CONNECT_FAILURE_STAGES.UNKNOWN);
  assert.equal(diagnosis.message, "getaddrinfo ENOTFOUND x");
  assert.equal(classifyConnectFailure(undefined, undefined, {}).stage, CONNECT_FAILURE_STAGES.UNKNOWN);
});
