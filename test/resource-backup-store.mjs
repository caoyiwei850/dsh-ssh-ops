import { test } from "node:test";
import assert from "node:assert/strict";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { collectResourceBackup, restoreResourceBackup } from "../src/resource-backup-store.js";
import { encryptResourceBackup, decryptResourceBackup } from "../src/resource-backup-crypto.js";
import SshOpsService, { profileDomainSpec, credentialDomainSpec, knownHostDomainSpec } from "../src/index.js";
import { resourceBackupExportResultSchema, resourceBackupImportResultSchema } from "../src/schemas.js";

function table(values = []) {
  const data = new Map(values);
  return { get: (id) => data.get(id), put: async (id, value) => data.set(id, value), delete: async (id) => data.delete(id), entries: () => [...data.entries()] };
}
function service() {
  const groups = table(), credentials = table(), profiles = table(), knownHosts = table(), secrets = new Map();
  const key = (ref) => typeof ref === "string" ? ref : JSON.stringify(ref);
  return { groups, credentials, profiles, knownHosts, secrets,
    requireGroupTable: () => groups, requireCredentialTable: () => credentials, requireProfileTable: () => profiles,
    requireKnownHostTable: () => knownHosts,
    ctx: { credentials: { describe: async (ref) => ({ configured: secrets.has(key(ref)) }), resolve: async (ref) => secrets.has(key(ref)) ? { value: secrets.get(key(ref)) } : undefined,
      set: async (ref, value) => secrets.set(key(ref), value), unset: async (ref) => secrets.delete(key(ref)) } }
  };
}
const group = "11111111-1111-4111-8111-111111111111";
const shared = "22222222-2222-4222-8222-222222222222";
const first = "33333333-3333-4333-8333-333333333333";
const second = "44444444-4444-4444-8444-444444444444";
const refName = (id, sharedPrefix = "") => `DSH_SSH_OPS_${sharedPrefix}${id.replaceAll("-", "").toUpperCase()}_PASSWORD`;

async function source() {
  const s = service();
  await s.groups.put(group, { name: "Servers" });
  await s.knownHosts.put("host-a:22", { host: "host-a", port: 22, algorithm: "ssh-ed25519", fingerprint: "SHA256:example", firstSeenAt: "2026-01-01", lastSeenAt: "2026-01-01" });
  await s.credentials.put(shared, { name: "Shared", authKind: "password" });
  await s.ctx.credentials.set(credentialRef(refName(shared, "SHARED_")), "secret-shared");
  await s.profiles.put(first, { name: "Jump", host: "host-a", port: 22, username: "ops", authKind: "password", groupId: group, credentialId: shared, proxyJump: [] });
  await s.profiles.put(second, { name: "App", host: "host-b", port: 2200, username: "root", authKind: "password", groupId: group, proxyJump: [{ profileId: first }, { host: "legacy-hop", port: 22, username: "ops", authKind: "password" }], defaultProjectPath: "/srv/app", agentForward: true });
  await s.ctx.credentials.set(credentialRef(refName(second)), "secret-own");
  const stem = `DSH_SSH_OPS_${second.replaceAll("-", "").toUpperCase()}`;
  await s.ctx.credentials.set(credentialRef(`${stem}_PRIVATE_KEY`), "test-private-key");
  await s.ctx.credentials.set(credentialRef(`${stem}_PASSPHRASE`), "key-passphrase");
  await s.ctx.credentials.set(credentialRef(`${stem}_JUMP_1_PASSWORD`), "legacy-hop-password");
  return s;
}

test("encrypted backup restores groups, credentials and jump references without replacing existing resources", async () => {
  const input = await collectResourceBackup(await source());
  const archive = await encryptResourceBackup(input, "long secure passphrase");
  const restored = await decryptResourceBackup(archive, "long secure passphrase");
  const dest = service();
  await dest.groups.put("55555555-5555-4555-8555-555555555555", { name: "Servers", createdAt: "2026-01-01", updatedAt: "2026-01-01" });
  const result = await restoreResourceBackup(dest, restored);
  assert.deepEqual(result, { profiles: 2, groups: 1, credentials: 1 });
  assert.equal(dest.groups.entries().length, 1);
  assert.equal(dest.knownHosts.get("host-a:22").fingerprint, "SHA256:example");
  const records = dest.profiles.entries();
  const jump = records.find(([, value]) => value.name === "Jump");
  const app = records.find(([, value]) => value.name === "App");
  assert.equal(app[1].proxyJump[0].profileId, jump[0]);
  assert.equal(app[1].defaultProjectPath, "/srv/app");
  assert.equal(app[1].agentForward, true);
  assert.equal(profileDomainSpec.tables.profiles.valueSchema.parse(app[1]).agentForward, true);
  for (const [, item] of dest.groups.entries()) profileDomainSpec.tables.groups.valueSchema.parse(item);
  for (const [, item] of dest.credentials.entries()) credentialDomainSpec.tables.credentials.valueSchema.parse(item);
  for (const [, item] of dest.knownHosts.entries()) knownHostDomainSpec.tables.known_hosts.valueSchema.parse(item);
  assert.equal((await dest.ctx.credentials.resolve(credentialRef(refName(app[0])))).value, "secret-own");
  const stem = `DSH_SSH_OPS_${app[0].replaceAll("-", "").toUpperCase()}`;
  assert.equal((await dest.ctx.credentials.resolve(credentialRef(`${stem}_PRIVATE_KEY`))).value, "test-private-key");
  assert.equal((await dest.ctx.credentials.resolve(credentialRef(`${stem}_PASSPHRASE`))).value, "key-passphrase");
  assert.equal((await dest.ctx.credentials.resolve(credentialRef(`${stem}_JUMP_1_PASSWORD`))).value, "legacy-hop-password");
  assert.equal((await dest.ctx.credentials.resolve(credentialRef(refName(jump[1].credentialId, "SHARED_")))).value, "secret-shared");
});

test("invalid references cause no writes and a credential failure rolls back new records", async () => {
  const data = await collectResourceBackup(await source());
  const broken = structuredClone(data);
  broken.profiles[1].record.proxyJump[0].profileId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const dest = service();
  await assert.rejects(restoreResourceBackup(dest, broken), /invalid jump server/);
  assert.equal(dest.groups.entries().length, 0);
  dest.ctx.credentials.set = async () => { throw Error("synthetic provider failure"); };
  await assert.rejects(restoreResourceBackup(dest, data), /rolled back/);
  assert.equal(dest.groups.entries().length, 0);
  assert.equal(dest.credentials.entries().length, 0);
  assert.equal(dest.profiles.entries().length, 0);
  assert.equal(dest.knownHosts.entries().length, 0);
});

test("conflicting trusted host fingerprint prevents import before writing", async () => {
  const data = await collectResourceBackup(await source());
  const dest = service();
  await dest.knownHosts.put("host-a:22", { fingerprint: "SHA256:other", algorithm: "ssh-ed25519" });
  await assert.rejects(restoreResourceBackup(dest, data), /fingerprint conflicts/);
  assert.equal(dest.profiles.entries().length, 0);
  assert.equal(dest.knownHosts.get("host-a:22").fingerprint, "SHA256:other");
});

test("a credential provider that returns a failure envelope triggers rollback", async () => {
  const data = await collectResourceBackup(await source());
  const dest = service();
  dest.ctx.credentials.set = async () => ({ ok: false });
  await assert.rejects(restoreResourceBackup(dest, data), /rolled back/);
  assert.equal(dest.groups.entries().length, 0);
  assert.equal(dest.credentials.entries().length, 0);
  assert.equal(dest.profiles.entries().length, 0);
  assert.equal(dest.knownHosts.entries().length, 0);
});

test("export refuses a configured credential that cannot be read", async () => {
  const s = await source();
  const originalResolve = s.ctx.credentials.resolve;
  s.ctx.credentials.resolve = async (ref) => ref === credentialRef(refName(second)) ? undefined : originalResolve(ref);
  await assert.rejects(collectResourceBackup(s), /could not be read/);
});

test("operator RPC returns encrypted data and wrong password never changes storage", async () => {
  const original = await source();
  const exported = await SshOpsService.prototype.resourceBackupExport.call(original, { password: "long secure passphrase" });
  assert.equal(exported.ok, true);
  assert.equal(resourceBackupExportResultSchema.safeParse(exported).success, true);
  assert.equal(exported.value.archive.includes("secret-own"), false);
  const target = service();
  const failed = await SshOpsService.prototype.resourceBackupImport.call(target, { password: "incorrect password!", archive: exported.value.archive });
  assert.equal(failed.ok, false);
  assert.equal(target.profiles.entries().length, 0);
  const imported = await SshOpsService.prototype.resourceBackupImport.call(target, { password: "long secure passphrase", archive: exported.value.archive });
  assert.equal(imported.ok, true);
  assert.equal(resourceBackupImportResultSchema.safeParse(imported).success, true);
  assert.equal(target.profiles.entries().length, 2);
});
