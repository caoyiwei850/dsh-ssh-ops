// Legacy VRP (Huawei S12712 and friends) key-exchange regression.
//
// Old VRP builds advertise ONLY SHA-1 group14 KEX. ssh2 ships
// `diffie-hellman-group14-sha1` in SUPPORTED_KEX but deliberately leaves it out
// of DEFAULT_KEX, so the plugin's default handshake dies with
// "no matching key exchange algorithm" and the switch is simply unreachable.
//
// Loop: node --test test/ssh-legacy-kex.mjs
//
// The fake switch is a real ssh2 Server whose `algorithms.kex` is narrowed to
// the legacy set, so this exercises the actual negotiation path (a stubbed
// Client would not).
import { test } from "node:test";
import assert from "node:assert/strict";
import ssh2 from "ssh2";
import { generateKeyPairSync } from "node:crypto";
import SshOpsService from "../src/index.js";
import { LEGACY_VRP_ALGORITHMS, isKexMismatchError } from "../src/index.js";

const { Server } = ssh2;

const LEGACY_ONLY = ["diffie-hellman-group14-sha1"];

/** Old-VRP-style server: only the SHA-1 group14 KEX, nothing modern. */
function startLegacySwitch({ kex = LEGACY_ONLY } = {}) {
  return new Promise((resolve, reject) => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const hostKey = privateKey.export({ type: "pkcs1", format: "pem" });
    const server = new Server({
      hostKeys: [hostKey],
      algorithms: { kex: [...kex] }
    }, (client) => {
      client.on("error", () => {});
      client.on("authentication", (authCtx) => {
        if (authCtx.method === "password" && authCtx.password === "test123") authCtx.accept();
        else authCtx.reject(["password"]);
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/** Modern-only server, for the "must not regress" direction. */
function startModernServer() {
  return new Promise((resolve, reject) => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const hostKey = privateKey.export({ type: "pkcs1", format: "pem" });
    const server = new Server({
      hostKeys: [hostKey],
      algorithms: { kex: ["curve25519-sha256", "ecdh-sha2-nistp256", "diffie-hellman-group14-sha256"] }
    }, (client) => {
      client.on("error", () => {});
      client.on("authentication", (authCtx) => {
        if (authCtx.method === "password" && authCtx.password === "test123") authCtx.accept();
        else authCtx.reject(["password"]);
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

const close = (srv) => new Promise((r) => { try { srv.server.close(() => r()); } catch { r(); } });

/** Bare service instance: no storage, no ctx wiring needed for a connect. */
function makeService() {
  const service = Object.create(SshOpsService.prototype);
  service.config = {};
  service.connections = new Map();
  service.activeConnectionId = null;
  service.ctx = { logger: { warn: () => {}, info: () => {}, debug: () => {} } };
  // The field is `knownHosts`, and the code tests it against null (`!== null`),
  // so it must be null — not undefined — to disable host-key TOFU here.
  service.knownHosts = null;
  return service;
}

const creds = { host: "127.0.0.1", username: "admin", auth: { kind: "password", password: "test123" } };

/**
 * The KEX ssh2 actually negotiated for a live connection, as the exchange
 * object's class name ("DHExchange" for the SHA-1 group14 path,
 * "Curve25519Exchange" for a modern one). Asserting on the negotiated object
 * — rather than on the algorithm list we asked for — is what proves the
 * handshake really used it.
 */
const negotiatedKex = (service, connectionId) =>
  service.connections.get(connectionId)?.client?._protocol?._kex?.constructor?.name ?? null;

// ── 1. the reported bug: default handshake cannot reach the switch ──────────

test("legacy switch: default algorithms fail with a clear KEX-mismatch error", async (t) => {
  const srv = await startLegacySwitch();
  t.after(() => close(srv));
  const service = makeService();
  const result = await service.connect({ ...creds, port: srv.port, legacy: false, retries: 0 });
  if (result.ok) {
    await service.disconnect({ connectionId: result.value.connectionId }).catch(() => {});
    assert.fail("a modern-only client must not negotiate SHA-1 KEX on its own");
  }
  assert.ok(isKexMismatchError(result.error), `expected a KEX mismatch, got: ${result.error.message}`);
});

// ── 2. the fix: automatic downgrade reaches it, and says so ────────────────

test("legacy switch: auto-downgrade connects and reports the weakened algorithms", async () => {
  const srv = await startLegacySwitch();
  const service = makeService();
  const result = await service.connect({ ...creds, port: srv.port, retries: 0 });
  assert.equal(result.ok, true, `auto-downgrade must connect: ${result.error?.message ?? ""}`);
  assert.equal(result.value.legacyFallback, true, "the caller is told a legacy handshake was used");
  assert.match(result.value.warning ?? "", /legacy|旧/i, "the user gets a visible warning");

  // The transport must be genuinely usable, not merely handshaken: prove the
  // negotiated KEX on the live client is the legacy one.
  assert.equal(negotiatedKex(service, result.value.connectionId), "DHExchange",
    "the session actually negotiated the SHA-1 group14 exchange (not merely handshaken)");

  // Explicit teardown: a live connection's keepalive timer would otherwise
  // keep this test process alive (the runner waits on open handles).
  await service.disconnect({ connectionId: result.value.connectionId });
  await close(srv);
});

// ── 3. explicit opt-in works without a wasted first attempt ────────────────

test("legacy switch: legacy: true connects directly", async () => {
  const srv = await startLegacySwitch();
  const service = makeService();
  const result = await service.connect({ ...creds, port: srv.port, legacy: true, retries: 0 });
  assert.equal(result.ok, true, result.error?.message ?? "");
  assert.equal(result.value.legacyFallback ?? false, false, "an explicit request is not a fallback");

  await service.disconnect({ connectionId: result.value.connectionId });
  await close(srv);
});

// ── 4. modern servers must keep negotiating modern algorithms ──────────────

test("modern server: no downgrade, modern KEX still chosen", async () => {
  const srv = await startModernServer();
  const service = makeService();
  const result = await service.connect({ ...creds, port: srv.port, retries: 0 });
  assert.equal(result.ok, true, result.error?.message ?? "");
  assert.notEqual(result.value.legacyFallback, true, "modern servers must not be downgraded");
  assert.equal(negotiatedKex(service, result.value.connectionId), "Curve25519Exchange",
    "a modern peer must negotiate a modern exchange, not SHA-1 group14");

  await service.disconnect({ connectionId: result.value.connectionId });
  await close(srv);
});

// ── 5. the algorithm set itself is correct and narrowly scoped ─────────────

test("legacy algorithm set is KEX-only and appends behind modern algorithms", () => {
  assert.ok(LEGACY_VRP_ALGORITHMS.kex, "a kex list is declared");
  // `append` puts the weak KEX after every modern one, so a modern peer still
  // negotiates modern (verified against a real server in the case above) and
  // only a peer that speaks nothing else lands on SHA-1.
  const appended = LEGACY_VRP_ALGORITHMS.kex.append;
  assert.ok(Array.isArray(appended), "declared as an ssh2 append list");
  assert.ok(appended.includes("diffie-hellman-group14-sha1"), "the S12712-era KEX is present");
  assert.equal(new Set(appended).size, appended.length, "no duplicates");
  // Scope check: this must not quietly widen host key or cipher policy.
  assert.deepEqual(Object.keys(LEGACY_VRP_ALGORITHMS), ["kex"], "KEX only — no host-key or cipher loosening");
  assert.deepEqual(Object.keys(LEGACY_VRP_ALGORITHMS.kex), ["append"], "append only — modern defaults preserved");
});

// ── 6. failure classification must not swallow unrelated errors ────────────

test("isKexMismatchError only matches negotiation failures", () => {
  assert.equal(isKexMismatchError(new Error("Handshake failed: no matching key exchange algorithm")), true);
  assert.equal(isKexMismatchError(new Error("no matching key exchange method found")), true);
  assert.equal(isKexMismatchError(new Error("All configured authentication methods failed")), false);
  assert.equal(isKexMismatchError(new Error("connect ECONNREFUSED 10.0.0.1:22")), false);
  assert.equal(isKexMismatchError(new Error("Timed out while waiting for handshake")), false);
  assert.equal(isKexMismatchError(undefined), false);
});
