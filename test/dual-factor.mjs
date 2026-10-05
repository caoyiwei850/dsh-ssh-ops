// Dual-factor authentication (password + key on the SAME connection) for
// devices configured with `AuthenticationMethods password,publickey` or the
// reverse — e.g. firewalls and switches that reject single-factor logins.
// Covers: wire schema (backwards compatible), the auth handler's restart on
// USERAUTH_FAILURE partial success, credential resolution from the primary +
// secondary slots, and the ssh2 connectConfig assembly.
import assert from "node:assert/strict";
import { test } from "node:test";
import SshOpsService from "../src/index.js";
import { authSchema, credentialListResultSchema, profileSaveResultSchema } from "../src/schemas.js";
import { createAuthTracker, makeAuthHandler } from "../src/ssh-auth.js";

// ── wire schema ──────────────────────────────────────────────────────────────

test("auth schema still accepts legacy single-factor shapes", () => {
  assert.equal(authSchema.safeParse({ kind: "password", password: "p" }).success, true);
  assert.equal(authSchema.safeParse({ kind: "key", privateKey: "k" }).success, true);
  assert.equal(authSchema.safeParse({ kind: "key", privateKey: "k", passphrase: "pp" }).success, true);
});

test("auth schema accepts an opposite-kind secondary factor and rejects same-kind", () => {
  assert.equal(authSchema.safeParse({ kind: "password", password: "p", secondary: { kind: "key", privateKey: "k" } }).success, true);
  assert.equal(authSchema.safeParse({ kind: "password", password: "p", secondary: { kind: "key", privateKey: "k", passphrase: "pp" } }).success, true);
  assert.equal(authSchema.safeParse({ kind: "key", privateKey: "k", secondary: { kind: "password", password: "p" } }).success, true);
  // Same-kind secondary is a configuration error, not silently ignored.
  assert.equal(authSchema.safeParse({ kind: "password", password: "p", secondary: { kind: "password", password: "p2" } }).success, false);
  assert.equal(authSchema.safeParse({ kind: "key", privateKey: "k", secondary: { kind: "key", privateKey: "k2" } }).success, false);
});

test("info result schemas accept the secondaryConfigured field", () => {
  const credential = {
    ok: true,
    value: { credentials: [{ credentialId: "11111111-1111-4111-8111-111111111111", name: "c", authKind: "password", credentialConfigured: true, passphraseConfigured: false, secondaryConfigured: true }] }
  };
  assert.equal(credentialListResultSchema.safeParse(credential).success, true);
  const profile = {
    ok: true,
    value: {
      profile: {
        profileId: "22222222-2222-4222-8222-222222222222", groupId: null, groupName: null,
        name: "n", host: "h", port: 22, username: "u", authKind: "key",
        credentialConfigured: true, passphraseConfigured: false, secondaryConfigured: false,
        connected: false, credentialId: null, credentialName: null, proxyJump: [], defaultProjectPath: null
      },
      credentialRefs: { password: "a", privateKey: "b", passphrase: "c" }
    }
  };
  assert.equal(profileSaveResultSchema.safeParse(profile).success, true);
});

// ── auth handler: restart on partial success ────────────────────────────────

test("handler restarts after partial success so the second factor is offered", () => {
  const tracker = createAuthTracker();
  const handler = makeAuthHandler(tracker, { hasPassword: true, hasPrivateKey: true, tryKeyboard: false });
  const calls = [];
  // Server order: publickey,password — password attempts are rejected until
  // the key factor completes, then a partial-success failure arrives.
  calls.push(handler(["password", "publickey"], false, () => {})); // none → rejected
  calls.push(handler(["password", "publickey"], false, () => {})); // password → not yet allowed
  calls.push(handler(["password"], true, () => {}));               // publickey → partial success, restart
  calls.push(handler(["password"], false, () => {}));              // password (second factor attempt)
  assert.deepEqual(calls, ["none", "password", "password", "publickey"]);
  // Without the restart the handler would have returned `false` here and the
  // connection would fail even though both credentials are configured.
  const tracker2 = createAuthTracker();
  const handler2 = makeAuthHandler(tracker2, { hasPassword: true, hasPrivateKey: true, tryKeyboard: false });
  const seq = [];
  let next;
  for (let i = 0; i < 8; i += 1) {
    next = handler2(i === 2 ? ["password"] : ["password", "publickey"], i === 2, () => {});
    seq.push(next);
    if (next === false) break;
  }
  assert.deepEqual(seq, ["none", "password", "password", "publickey", false]);
  assert.equal(tracker2.partialSuccesses, 1);
});

test("partial-success restart is bounded against a nonconformant server", () => {
  const tracker = createAuthTracker();
  const handler = makeAuthHandler(tracker, { hasPassword: true, hasPrivateKey: true, tryKeyboard: false });
  // A server that keeps reporting the same factor as a fresh partial success
  // must not keep the handler walking forever.
  let calls = 0;
  for (;;) {
    const next = handler(["password", "publickey"], true, () => {});
    calls += 1;
    if (next === false) break;
    assert.ok(calls < 20, "handler must terminate");
  }
});

// ── credential resolution + connectConfig assembly ──────────────────────────

function makeService() {
  const service = Object.create(SshOpsService.prototype);
  service.connections = new Map();
  const store = new Map();
  const key = (ref) => (typeof ref === "string" ? ref : JSON.stringify(ref));
  service.ctx = {
    credentials: {
      async describe(ref) { return { configured: store.has(key(ref)) }; },
      async resolve(ref) { return store.has(key(ref)) ? { value: store.get(key(ref)) } : undefined; },
      async set(ref, value) { store.set(key(ref), value); },
      async unset(ref) { store.delete(key(ref)); }
    }
  };
  service.store = store;
  return service;
}

test("resolveCredentialAuth assembles password primary + key secondary", async () => {
  const service = makeService();
  const refs = { password: "P", privateKey: "K", passphrase: "PP" };
  await service.ctx.credentials.set("P", "secret");
  await service.ctx.credentials.set("K", "key-pem");
  await service.ctx.credentials.set("PP", "key-pass");
  const auth = await service.resolveCredentialAuth(refs, "password");
  assert.deepEqual(auth, { kind: "password", password: "secret", secondary: { kind: "key", privateKey: "key-pem", passphrase: "key-pass" } });
});

test("resolveCredentialAuth assembles key primary + password secondary", async () => {
  const service = makeService();
  const refs = { password: "P", privateKey: "K", passphrase: "PP" };
  await service.ctx.credentials.set("K", "key-pem");
  await service.ctx.credentials.set("P", "secret");
  const auth = await service.resolveCredentialAuth(refs, "key");
  assert.deepEqual(auth, { kind: "key", privateKey: "key-pem", secondary: { kind: "password", password: "secret" } });
});

test("resolveCredentialAuth stays single-factor when the secondary slot is empty", async () => {
  const service = makeService();
  const refs = { password: "P", privateKey: "K", passphrase: "PP" };
  await service.ctx.credentials.set("P", "secret");
  const auth = await service.resolveCredentialAuth(refs, "password");
  assert.deepEqual(auth, { kind: "password", password: "secret" });
  // A missing primary still reports undefined (caller turns that into
  // credential-missing).
  assert.equal(await service.resolveCredentialAuth(refs, "key"), undefined);
});

test("connectInternal applies both factors to the ssh2 connect config", async () => {
  const service = makeService();
  // Stub the transport: we only assert the config assembly here.
  service.connectClient = async () => ({ ok: true });
  service.attachTransportHandlers = () => {};
  const { connectionId } = (await service.connectInternal({
    host: "fw.example", username: "admin",
    auth: { kind: "password", password: "secret", secondary: { kind: "key", privateKey: "key-pem", passphrase: "pp" } }
  })).value;
  const record = service.connections.get(connectionId);
  assert.equal(record.connectConfig.password, "secret");
  assert.equal(record.connectConfig.privateKey, "key-pem");
  assert.equal(record.connectConfig.passphrase, "pp");
  // And the reverse direction: key primary + password secondary.
  const { connectionId: id2 } = (await service.connectInternal({
    host: "sw.example", username: "admin",
    auth: { kind: "key", privateKey: "key-pem", secondary: { kind: "password", password: "secret" } }
  })).value;
  const record2 = service.connections.get(id2);
  assert.equal(record2.connectConfig.privateKey, "key-pem");
  assert.equal(record2.connectConfig.password, "secret");
});
