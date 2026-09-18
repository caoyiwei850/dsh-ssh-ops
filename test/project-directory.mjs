import assert from "node:assert/strict";
import SshOpsService, { profileDomainSpec } from "../src/index.js";
import { profileInfoSchema, profileSaveRequestSchema } from "../src/schemas.js";

const identity = {
  name: "production app", host: "192.0.2.10", port: 22, username: "ops",
  authKind: "key", hostKeyMode: "accept-new"
};

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

function makeService(table) {
  const service = Object.create(SshOpsService.prototype);
  service.config = { maxBufferBytes: 65536, maxCaptureBytes: 65536 };
  service.connections = new Map();
  service.ctx = { credentials: { async describe() { return { configured: false }; } } };
  service.requireProfileTable = () => table;
  return service;
}

/** What the boot path does: validate a stored record against the domain schema. */
function reparseStoredRecord(table, profileId) {
  return profileDomainSpec.tables.profiles.valueSchema.parse(table.get(profileId));
}

assert.equal(profileSaveRequestSchema.parse({ ...identity, defaultProjectPath: "/srv/apps/api" }).defaultProjectPath, "/srv/apps/api");
assert.equal(profileSaveRequestSchema.parse({ ...identity, defaultProjectPath: null }).defaultProjectPath, null);
for (const path of ["relative/project", "/srv/app\nnext", ""]) {
  assert.equal(profileSaveRequestSchema.safeParse({ ...identity, defaultProjectPath: path }).success, false, `reject unsafe project path ${JSON.stringify(path)}`);
}

assert.equal(profileInfoSchema.parse({
  ...identity,
  profileId: "00000000-0000-4000-8000-000000000001",
  groupId: null, groupName: null, credentialConfigured: true, passphraseConfigured: false,
  connected: false, credentialId: null, credentialName: null, proxyJump: [],
  defaultProjectPath: "/srv/apps/api"
}).defaultProjectPath, "/srv/apps/api");

// ── every stored record must survive the boot-time schema check ──
//
// DSH validates each stored record against the domain's schema when it reopens
// the domain, and a failure there aborts the whole profile instead of just this
// plugin — so whatever profileSave writes has to parse back. Regression: an
// unset project directory was persisted as `null` while the record schema only
// accepted `string | undefined`, which made the host unbootable after any save.
{
  const table = fakeTable();
  const service = makeService(table);

  const saved = await service.profileSave(identity);
  assert.equal(saved.ok, true);
  const { profileId } = saved.value.profile;
  assert.equal(table.get(profileId).defaultProjectPath, null, "an unset project directory is stored as null");
  assert.equal(reparseStoredRecord(table, profileId).defaultProjectPath, null);

  const withPath = await service.profileSave({ ...identity, profileId, defaultProjectPath: "/srv/apps/api" });
  assert.equal(withPath.ok, true);
  assert.equal(reparseStoredRecord(table, profileId).defaultProjectPath, "/srv/apps/api");

  const cleared = await service.profileSave({ ...identity, profileId, defaultProjectPath: null });
  assert.equal(cleared.ok, true);
  assert.equal(reparseStoredRecord(table, profileId).defaultProjectPath, null, "an explicit null clears the entry and still round-trips");
}
