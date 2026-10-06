// Boot-time contract for the remaining authoritative config domains:
// whatever the credential, DB-profile and known-host write paths persist has
// to parse back through the schema DSH re-validates when it reopens the
// domain. A mismatch there aborts the whole domain at boot instead of just
// this plugin (regression class of #20, where profileSave wrote
// `defaultProjectPath: null` that the record schema rejected).
//
// Credentials and DB profiles are driven through their real save methods on a
// partially-constructed service (same style as test/project-directory.mjs);
// known hosts are driven through the real KnownHosts writer (src/hostkey.js).
import assert from "node:assert/strict";
import SshOpsService, {
  credentialDomainSpec,
  dbProfileDomainSpec,
  knownHostDomainSpec,
  loadSettingsRecord,
  settingsDomainSpec,
} from "../src/index.js";
import { KnownHosts } from "../src/hostkey.js";

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

/** Service shell carrying only what the three save paths touch. */
function makeService({ credentials, dbProfiles }) {
  const service = Object.create(SshOpsService.prototype);
  service.config = { maxBufferBytes: 65536, maxCaptureBytes: 65536 };
  service.connections = new Map();
  service.ctx = {
    credentials: {
      async describe() { return { configured: false }; },
      async set() {},
      async unset() {}
    }
  };
  service.dbOps = { dbConnections: new Map() };
  service.requireCredentialTable = () => credentials;
  service.requireDbProfileTable = () => dbProfiles;
  return service;
}

// ── credentials ─────────────────────────────────────────────────────────────
{
  const credentials = fakeTable();
  const service = makeService({ credentials, dbProfiles: fakeTable() });

  const created = await service.credentialSave({ name: "prod key", authKind: "key" });
  assert.equal(created.ok, true);
  const credentialId = created.value.credential.credentialId;
  assert.deepEqual(
    credentialDomainSpec.tables.credentials.valueSchema.parse(credentials.get(credentialId)),
    credentials.get(credentialId),
    "a freshly saved credential round-trips through the boot-time schema"
  );

  const renamed = await service.credentialSave({ credentialId, name: "prod key (rotated)", authKind: "key" });
  assert.equal(renamed.ok, true);
  credentialDomainSpec.tables.credentials.valueSchema.parse(credentials.get(credentialId));
  assert.equal(credentials.get(credentialId).name, "prod key (rotated)");

  const saved = await service.credentialSave({ name: "  padded  ", authKind: "password" });
  assert.equal(saved.ok, true);
  const stored = credentials.get(saved.value.credential.credentialId);
  assert.equal(stored.name, "padded", "surrounding whitespace is trimmed before persisting");
  credentialDomainSpec.tables.credentials.valueSchema.parse(stored);
}

// ── db profiles ─────────────────────────────────────────────────────────────
{
  const dbProfiles = fakeTable();
  const service = makeService({ credentials: fakeTable(), dbProfiles });

  // Minimal request: every optional field is absent, so the written record is
  // the "everything unset" shape — the exact class that #20 was about.
  const minimal = await service.dbProfileSave({ name: "local", type: "mysql", host: "127.0.0.1", port: 3306 });
  assert.equal(minimal.ok, true);
  const minimalId = minimal.value.profile.dbProfileId;
  const minimalRecord = dbProfiles.get(minimalId);
  assert.equal(minimalRecord.database, null);
  assert.equal(minimalRecord.username, null);
  assert.equal(minimalRecord.sshProfileId, null);
  assert.deepEqual(
    dbProfileDomainSpec.tables.profiles.valueSchema.parse(minimalRecord),
    minimalRecord,
    "an all-null DB profile round-trips through the boot-time schema"
  );

  // Fully-populated request, plus an update that clears the optionals again.
  const sshProfileId = "00000000-0000-4000-8000-000000000002";
  const full = await service.dbProfileSave({
    dbProfileId: minimalId, name: "local pg", type: "postgresql", host: " 10.0.0.8 ",
    port: 5432, database: " appdb ", username: " reader ", ssl: "preferred",
    sshProfileId, password: "secret"
  });
  assert.equal(full.ok, true);
  const fullRecord = dbProfiles.get(minimalId);
  assert.equal(fullRecord.host, "10.0.0.8", "host is trimmed");
  assert.equal(fullRecord.database, "appdb");
  assert.equal(fullRecord.sshProfileId, sshProfileId);
  assert.equal(fullRecord.ssl, "preferred");
  dbProfileDomainSpec.tables.profiles.valueSchema.parse(fullRecord);

  const cleared = await service.dbProfileSave({
    dbProfileId: minimalId, name: "local pg", type: "postgresql", host: "10.0.0.8", port: 5432,
    database: "", username: "", sshProfileId: null
  });
  assert.equal(cleared.ok, true);
  const clearedRecord = dbProfiles.get(minimalId);
  assert.equal(clearedRecord.database, null, "an empty database clears to null");
  assert.equal(clearedRecord.username, null);
  assert.equal(clearedRecord.sshProfileId, null);
  dbProfileDomainSpec.tables.profiles.valueSchema.parse(clearedRecord);
}

// ── known hosts ─────────────────────────────────────────────────────────────
{
  const table = fakeTable();
  const knownHosts = new KnownHosts(table);

  await knownHosts.record("192.0.2.10", 22, { fingerprint: "SHA256:abc", algorithm: "ssh-ed25519" });
  const firstSeenAt = table.get("192.0.2.10:22").firstSeenAt;
  await knownHosts.record("192.0.2.10", 22, { fingerprint: "SHA256:def", algorithm: "ssh-ed25519" });
  await knownHosts.record("192.0.2.11", undefined, { fingerprint: "SHA256:ghi", algorithm: "ssh-rsa" });

  assert.equal(table.size(), 2, "a re-observed host updates in place instead of duplicating");
  for (const [key, record] of table.entries()) {
    const parsed = knownHostDomainSpec.tables.known_hosts.valueSchema.parse(record);
    assert.deepEqual(parsed, record, `known-host record ${key} round-trips through the boot-time schema`);
  }
  const updated = table.get("192.0.2.10:22");
  assert.equal(updated.fingerprint, "SHA256:def");
  assert.equal(updated.firstSeenAt, firstSeenAt, "firstSeenAt is preserved across re-records");
  assert.equal(table.get("192.0.2.11:22").port, 22, "a missing port defaults to 22 in the stored record");

  await knownHosts.forget("192.0.2.11", undefined);
  assert.equal(table.size(), 1);
}

// ── settings: autoApplySystemLanguage pin round-trips and is reported ────────
{
  const settings = fakeTable();
  const service = Object.create(SshOpsService.prototype);
  service.settingsTable = settings;
  service.language = null;
  service.autoApplySystemLanguage = true;

  // The pin is an operator edit of ssh_ops_settings.json; the boot-time schema
  // must keep it (a stripped flag would silently re-enable auto-follow and the
  // stored language would be overwritten again on the next load).
  const pinnedSource = { language: "en", autoApplySystemLanguage: false };
  const pinned = settingsDomainSpec.tables.settings.valueSchema.parse(pinnedSource);
  assert.equal(pinned.language, "en");
  assert.equal(pinned.autoApplySystemLanguage, false, "the pin survives schema parsing");

  // A later languageSave spreads the previous record, so the pin must not be
  // dropped when the browser half writes a language value back.
  settings.put("main", pinned);
  await service.languageSave({ language: "en" });
  const after = settings.get("main");
  assert.equal(after.language, "en");
  assert.equal(after.autoApplySystemLanguage, false, "languageSave preserves an existing pin");

  // languageGet reports the pin; matching host state is what the boot path
  // would have loaded from this record.
  service.language = after.language;
  service.autoApplySystemLanguage = after.autoApplySystemLanguage !== false;
  const got = await service.languageGet();
  assert.equal(got.ok, true);
  assert.equal(got.value.language, "en");
  assert.equal(got.value.autoApplySystemLanguage, false, "languageGet exposes the pin");

  // Absent flag (fresh install / older file) means the safe default: follow
  // the host, i.e. the browser half keeps writing its resolved language back.
  const fresh = settingsDomainSpec.tables.settings.valueSchema.parse({});
  assert.equal(fresh.autoApplySystemLanguage, undefined, "an old record has no flag");
  assert.equal(loadSettingsRecord(fresh).autoApplySystemLanguage, true, "absent flag = auto-apply stays on");
  assert.equal(loadSettingsRecord(fresh).language, null, "no language stored when the record has none");
  assert.equal(loadSettingsRecord(pinnedSource).autoApplySystemLanguage, false, "the pin reads as false");
  assert.equal(loadSettingsRecord(pinnedSource).language, "en");
}

// ── settings: the default flag is materialized into the record on first boot ─
{
  const settings = fakeTable();
  // A record written by an older build: no flag. The boot path must persist
  // the explicit "true" so the operator sees the knob in ssh_ops_settings.json
  // and can flip it; without this the file would keep a hidden default.
  settings.put("main", { language: "zh", updatedAt: "2026-10-06T00:00:00.000Z" });

  const record = settings.get("main");
  const loaded = loadSettingsRecord(record);
  assert.equal(loaded.autoApplySystemLanguage, true, "the default reads as true");

  // What the boot path persists when the flag was absent.
  const materialized = settingsDomainSpec.tables.settings.valueSchema.parse({
    ...record,
    autoApplySystemLanguage: true
  });
  assert.equal(materialized.autoApplySystemLanguage, true, "the materialized default survives schema parsing");
  assert.equal(materialized.language, "zh", "the stored language is kept when materializing");
}

console.log("domain records: credential, DB-profile and known-host writes round-trip through their boot-time schemas; settings language pin round-trips and is reported");
