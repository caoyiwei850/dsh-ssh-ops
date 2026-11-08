import { randomUUID } from "node:crypto";
import { z } from "zod";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { profileSaveRequestSchema } from "./schemas.js";
import { knownHostKey } from "./hostkey.js";

const uuid = z.string().uuid();
const secretsSchema = z.object({
  password: z.string().max(1024 * 1024).optional(),
  privateKey: z.string().max(1024 * 1024).optional(),
  passphrase: z.string().max(1024 * 1024).optional()
}).strict();
const savedSchema = z.object({
  version: z.literal(1),
  knownHosts: z.array(z.object({ host: z.string().min(1).max(255), port: z.number().int().min(1).max(65535), algorithm: z.string().min(1).max(200), fingerprint: z.string().min(1).max(200), firstSeenAt: z.string().max(80), lastSeenAt: z.string().max(80) }).strict()).max(10000),
  groups: z.array(z.object({ id: uuid, name: z.string().min(1).max(80) }).strict()).max(5000),
  credentials: z.array(z.object({ id: uuid, name: z.string().min(1).max(120), authKind: z.enum(["key", "password"]), secrets: secretsSchema }).strict()).max(5000),
  profiles: z.array(z.object({ id: uuid, record: profileSaveRequestSchema, secrets: secretsSchema, jumps: z.array(secretsSchema).max(8) }).strict()).max(5000)
}).strict();

function refs(id, shared = false, jump) {
  const stem = id.replaceAll("-", "").toUpperCase();
  const prefix = `DSH_SSH_OPS_${shared ? "SHARED_" : ""}${stem}${jump === undefined ? "" : `_JUMP_${jump}`}`;
  return { password: `${prefix}_PASSWORD`, privateKey: `${prefix}_PRIVATE_KEY`, passphrase: `${prefix}_PASSPHRASE` };
}

async function readSecrets(credentials, names) {
  const out = {};
  for (const [key, name] of Object.entries(names)) {
    const described = await credentials.describe(credentialRef(name));
    const result = await credentials.resolve(credentialRef(name));
    if (described?.configured && result?.value === undefined) throw new Error("A configured credential could not be read");
    if (result?.value !== undefined) {
      if (typeof result.value !== "string") throw new Error("Unsupported credential value");
      out[key] = result.value;
    }
  }
  return out;
}

export async function collectResourceBackup(service) {
  const knownHosts = [...service.requireKnownHostTable().entries()].map(([, item]) => item);
  const groups = [...service.requireGroupTable().entries()].map(([id, item]) => ({ id, name: item.name }));
  const credentials = [];
  for (const [id, item] of service.requireCredentialTable().entries()) {
    credentials.push({ id, name: item.name, authKind: item.authKind, secrets: await readSecrets(service.ctx.credentials, refs(id, true)) });
  }
  const profiles = [];
  for (const [id, record] of service.requireProfileTable().entries()) {
    const jumps = [];
    for (let index = 0; index < (record.proxyJump?.length ?? 0); index++) jumps.push(await readSecrets(service.ctx.credentials, refs(id, false, index)));
    profiles.push({ id, record: profileSaveRequestSchema.parse(record), secrets: await readSecrets(service.ctx.credentials, refs(id)), jumps });
  }
  return validateBackup(savedSchema.parse({ version: 1, knownHosts, groups, credentials, profiles }));
}

function unique(items) { return new Set(items.map((item) => item.id)).size === items.length; }

function validateBackup(data) {
  if (!unique(data.groups) || !unique(data.credentials) || !unique(data.profiles)) throw new Error("Backup contains duplicate identifiers");
  const groupIds = new Set(data.groups.map((item) => item.id));
  const credentialIds = new Set(data.credentials.map((item) => item.id));
  const profileIds = new Set(data.profiles.map((item) => item.id));
  const credentialsById = new Map(data.credentials.map((item) => [item.id, item]));
  const sortedGroups = [...data.groups].sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN", { sensitivity: "accent" }));
  for (let index = 1; index < sortedGroups.length; index++) {
    if (sortedGroups[index - 1].name.localeCompare(sortedGroups[index].name, "zh-Hans-CN", { sensitivity: "accent" }) === 0) throw new Error("Backup contains duplicate group names");
  }
  for (const { id, record, jumps } of data.profiles) {
    if (record.groupId && !groupIds.has(record.groupId)) throw new Error("Backup references a missing group");
    if (record.credentialId && !credentialIds.has(record.credentialId)) throw new Error("Backup references a missing credential");
    if (record.credentialId && credentialsById.get(record.credentialId).authKind !== record.authKind) throw new Error("Backup credential type does not match server");
    if (jumps.length !== (record.proxyJump?.length ?? 0)) throw new Error("Backup has invalid jump credentials");
    const seen = new Set();
    for (const hop of record.proxyJump ?? []) {
      if (hop.profileId && (!profileIds.has(hop.profileId) || hop.profileId === id)) throw new Error("Backup references an invalid jump server");
      if (hop.profileId && seen.has(hop.profileId)) throw new Error("Backup repeats a jump server");
      if (hop.profileId) seen.add(hop.profileId);
      if (hop.credentialId && !credentialIds.has(hop.credentialId)) throw new Error("Backup references a missing jump credential");
    }
  }
  const seenHosts = new Set();
  for (const host of data.knownHosts) {
    const key = knownHostKey(host.host, host.port);
    if (seenHosts.has(key)) throw new Error("Backup repeats a known host");
    seenHosts.add(key);
  }
  return data;
}

/** Validate the entire archive before writing; remap IDs and roll back new records on failure. */
export async function restoreResourceBackup(service, input) {
  const data = validateBackup(savedSchema.parse(input));
  const groups = service.requireGroupTable(), credentials = service.requireCredentialTable(), profiles = service.requireProfileTable(), knownHosts = service.requireKnownHostTable();
  for (const host of data.knownHosts) {
    const key = knownHostKey(host.host, host.port), existing = knownHosts.get(key);
    if (existing && (existing.fingerprint !== host.fingerprint || existing.algorithm !== host.algorithm)) throw new Error("Backup host fingerprint conflicts with an existing trusted host");
  }
  const maps = { groups: new Map(), credentials: new Map(), profiles: new Map() };
  for (const item of data.groups) {
    const same = [...groups.entries()].find(([, record]) => record.name.localeCompare(item.name, "zh-Hans-CN", { sensitivity: "accent" }) === 0);
    maps.groups.set(item.id, same?.[0] ?? randomUUID());
  }
  for (const item of data.credentials) maps.credentials.set(item.id, randomUUID());
  for (const item of data.profiles) maps.profiles.set(item.id, randomUUID());
  const created = [], writtenRefs = [];
  const now = new Date().toISOString();
  const saveSecrets = async (names, values) => {
    for (const [key, value] of Object.entries(values)) {
      const ref = credentialRef(names[key]);
      writtenRefs.push(ref);
      const result = await service.ctx.credentials.set(ref, value);
      if (result?.ok === false) throw new Error("Credential write failed");
    }
  };
  try {
    for (const host of data.knownHosts) {
      const id = knownHostKey(host.host, host.port);
      if (knownHosts.get(id) !== undefined) continue;
      created.push([knownHosts, id]); await knownHosts.put(id, host);
    }
    for (const item of data.groups) {
      const id = maps.groups.get(item.id);
      if (groups.get(id) !== undefined) continue;
      created.push([groups, id]); await groups.put(id, { name: item.name, createdAt: now, updatedAt: now });
    }
    for (const item of data.credentials) {
      const id = maps.credentials.get(item.id);
      created.push([credentials, id]); await credentials.put(id, { name: item.name, authKind: item.authKind, createdAt: now, updatedAt: now });
      await saveSecrets(refs(id, true), item.secrets);
    }
    for (const item of data.profiles) {
      const id = maps.profiles.get(item.id), record = item.record;
      const proxyJump = (record.proxyJump ?? []).map((hop) => hop.profileId
        ? { profileId: maps.profiles.get(hop.profileId) }
        : { ...hop, ...(hop.credentialId ? { credentialId: maps.credentials.get(hop.credentialId) } : {}) });
      const restored = { ...record, groupId: record.groupId ? maps.groups.get(record.groupId) : null, credentialId: record.credentialId ? maps.credentials.get(record.credentialId) : null, proxyJump, createdAt: now, updatedAt: now };
      created.push([profiles, id]); await profiles.put(id, restored);
      await saveSecrets(refs(id), item.secrets);
      for (let index = 0; index < item.jumps.length; index++) await saveSecrets(refs(id, false, index), item.jumps[index]);
    }
    return { profiles: data.profiles.length, groups: data.groups.length, credentials: data.credentials.length };
  } catch {
    const failures = [];
    for (const ref of writtenRefs.reverse()) { try { const result = await service.ctx.credentials.unset(ref); if (result?.ok === false) failures.push("credential"); } catch { failures.push("credential"); } }
    for (const [table, id] of created.reverse()) { try { await table.delete(id); } catch { failures.push("record"); } }
    if (failures.length) throw new Error("Import failed and rollback was incomplete; inspect SSH resources and credentials");
    throw new Error("Import failed; new records were rolled back");
  }
}
