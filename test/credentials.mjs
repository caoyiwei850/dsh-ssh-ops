// Credential chain: profileSave → credentialRefs → resolve/unset via the host
// credentials service (the "save and connect" path), with the credentials
// provider mocked out. No ssh2 transport, no real credential store.
import assert from "node:assert/strict";
import SshOpsService from "../src/index.js";

function makeService() {
  const service = Object.create(SshOpsService.prototype);
  service.config = { maxBufferBytes: 65536, maxCaptureBytes: 65536 };
  service.connections = new Map();
  /** credential store keyed by the (branded) credential ref value */
  const store = new Map();
  const key = (ref) => (typeof ref === "string" ? ref : JSON.stringify(ref));
  service.ctx = {
    credentials: {
      async describe(ref) { return { configured: store.has(key(ref)) }; },
      async resolve(ref) { return store.has(key(ref)) ? { value: store.get(key(ref)) } : undefined; },
      async set(ref, value) { store.set(key(ref), value); },
      async unset(ref) { store.delete(key(ref)); },
      unsetCalls: [] 
    }
  };
  // record unset calls for the delete assertions
  const rawUnset = service.ctx.credentials.unset;
  service.ctx.credentials.unset = async (ref) => { service.ctx.credentials.unsetCalls.push(key(ref)); return rawUnset(ref); };
  service.unsetCalls = service.ctx.credentials.unsetCalls;
  service.store = store;
  service.storeKey = key;
  return service;
}

function fakeTable(entries = []) {
  const map = new Map(entries);
  return {
    get: (id) => map.get(id),
    put: (id, record) => { map.set(id, record); },
    delete: (id) => { map.delete(id); },
    entries: () => [...map.entries()],
    size: () => map.size
  };
}

// ── profileSave: fresh save returns non-secret record + derived refs ──
{
  const service = makeService();
  const table = fakeTable();
  service.requireProfileTable = () => table;

  const saved = await service.profileSave({
    name: "  web-1  ", host: " 10.0.0.5 ", username: "root", authKind: "password"
  });
  assert.equal(saved.ok, true);
  const { profile, credentialRefs } = saved.value;
  assert.equal(profile.name, "web-1", "name is trimmed");
  assert.equal(profile.host, "10.0.0.5");
  assert.equal(profile.port, 22, "port defaults to 22");
  // The saved record itself must never carry secret material.
  assert.deepEqual(
    Object.keys(table.entries()[0][1]).sort(),
    ["authKind", "createdAt", "groupId", "host", "hostKeyMode", "name", "port", "updatedAt", "username"].sort(),
    "stored record holds config only, no password/privateKey field"
  );
  const stem = profile.profileId.replaceAll("-", "").toUpperCase();
  assert.deepEqual(credentialRefs, {
    password: `DSH_SSH_OPS_${stem}_PASSWORD`,
    privateKey: `DSH_SSH_OPS_${stem}_PRIVATE_KEY`,
    passphrase: `DSH_SSH_OPS_${stem}_PASSPHRASE`
  });
  assert.equal(profile.credentialConfigured, false, "nothing configured yet");

  // Saving over a non-existent profileId is rejected.
  const stale = await service.profileSave({ profileId: "ghost", name: "x", host: "h", username: "u", authKind: "password" });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, "no-profile");
}

// ── save and connect: password profile resolves the saved secret ──
{
  const service = makeService();
  const table = fakeTable();
  service.requireProfileTable = () => table;
  const saved = await service.profileSave({ name: "web-1", host: "10.0.0.5", username: "root", authKind: "password" });
  const profileId = saved.value.profile.profileId;

  await service.ctx.credentials.set(service.storeKey(saved.value.credentialRefs.password), "s3cret");

  let captured = null;
  service.connectInternal = async (request, refProfileId) => {
    captured = { request, refProfileId };
    return { ok: true, value: { connectionId: "new" } };
  };
  const connected = await service.profileConnect({ profileId });
  assert.equal(connected.ok, true);
  assert.equal(captured.refProfileId, profileId);
  assert.equal(captured.request.auth.kind, "password");
  assert.equal(captured.request.auth.password, "s3cret", "resolved secret flows into the connect request");
  assert.equal(captured.request.host, "10.0.0.5");
  assert.equal(captured.request.name, "web-1");
}

// ── save and connect: key profile resolves key + optional passphrase ──
{
  const service = makeService();
  const table = fakeTable();
  service.requireProfileTable = () => table;
  const saved = await service.profileSave({ name: "k8s", host: "10.0.0.9", username: "ops", authKind: "key" });
  const profileId = saved.value.profile.profileId;
  await service.ctx.credentials.set(service.storeKey(saved.value.credentialRefs.privateKey), "-----BEGIN");
  await service.ctx.credentials.set(service.storeKey(saved.value.credentialRefs.passphrase), "hunter2");

  let captured = null;
  service.connectInternal = async (request) => { captured = request; return { ok: true, value: {} }; };
  const connected = await service.profileConnect({ profileId });
  assert.equal(connected.ok, true);
  assert.deepEqual(captured.auth, { kind: "key", privateKey: "-----BEGIN", passphrase: "hunter2" });
}

// ── connect without a saved secret: explicit credential-missing, no connect ──
{
  const service = makeService();
  const table = fakeTable();
  service.requireProfileTable = () => table;
  const saved = await service.profileSave({ name: "empty", host: "h", username: "u", authKind: "password" });
  let called = false;
  service.connectInternal = async () => { called = true; return { ok: true, value: {} }; };
  const result = await service.profileConnect({ profileId: saved.value.profile.profileId });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "credential-missing");
  assert.equal(called, false, "a missing secret must never reach connectInternal");
}

// ── profileDelete: clears exactly this profile's three refs ──
{
  const service = makeService();
  const table = fakeTable();
  service.requireProfileTable = () => table;
  const saved = await service.profileSave({ name: "gone", host: "h", username: "u", authKind: "key" });
  table.put(saved.value.profile.profileId, { authKind: "key" });
  await service.ctx.credentials.set(service.storeKey(saved.value.credentialRefs.password), "a");
  await service.ctx.credentials.set(service.storeKey(saved.value.credentialRefs.privateKey), "b");
  await service.ctx.credentials.set(service.storeKey(saved.value.credentialRefs.passphrase), "c");

  const deleted = await service.profileDelete({ profileId: saved.value.profile.profileId });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.value.deleted, true);
  assert.equal(table.size(), 0);
  assert.equal(service.unsetCalls.length, 3, "all three refs are unset");
  assert.equal(service.store.size, 0);
  // Other profiles' refs are untouched by construction (names derive from id).
  assert.ok(service.unsetCalls.every((ref) => ref.includes(saved.value.profile.profileId.replaceAll("-", "").toUpperCase())));

  // Deleting a missing profile is a clean no-op.
  const again = await service.profileDelete({ profileId: "nope" });
  assert.equal(again.ok, true);
  assert.equal(again.value.deleted, false);
}

// ── profilePublic: configured flags reflect the store, not the panel ──
{
  const service = makeService();
  const table = fakeTable();
  service.requireProfileTable = () => table;
  const saved = await service.profileSave({ name: "p", host: "h", username: "u", authKind: "password" });
  assert.equal(saved.value.profile.credentialConfigured, false);
  await service.ctx.credentials.set(service.storeKey(saved.value.credentialRefs.password), "pw");
  const listed = await service.profileList();
  assert.equal(listed.ok, true);
  assert.equal(listed.value.profiles[0].credentialConfigured, true);
  assert.equal(listed.value.profiles[0].passphraseConfigured, false);
}

console.log("credentials: save→refs→resolve→unset chain: all cases passed");
