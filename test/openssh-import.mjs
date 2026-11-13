import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scanOpenSshConfig } from "../src/openssh-import.js";
import SshOpsService from "../src/index.js";
import { openSshImportRequestSchema, openSshImportResultSchema } from "../src/schemas.js";

test("OpenSSH import previews inherited settings, keeps all jumps and skips duplicates on retry", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-openssh-"));
  const envKey = process.platform === "win32" ? "USERPROFILE" : "HOME";
  const previous = process.env[envKey];
  process.env[envKey] = home;
  t.after(async () => {
    if (previous === undefined) delete process.env[envKey];
    else process.env[envKey] = previous;
    await rm(home, { recursive: true, force: true });
  });
  const ssh = join(home, ".ssh");
  await mkdir(join(ssh, "conf.d"), { recursive: true });
  await writeFile(join(ssh, "conf.d", "jumps.conf"), "Host a b\n  HostName %h.example.test\n");
  const path = join(ssh, "config");
  const config = [
    "Include conf.d/*.conf",
    "Host app",
    "  ProxyJump a,b",
    "Host orphan",
    "  ProxyJump missing",
    "Host cycle-a",
    "  ProxyJump cycle-b",
    "Host cycle-b",
    "  ProxyJump cycle-a",
    "Host * !orphan",
    "  User deploy",
    "  Port 2222"
  ].join("\n");
  await writeFile(path, config);
  const profiles = new Map();
  const service = {
    requireProfileTable: () => profiles,
    async profileSave(profile) {
      profiles.set(profile.name, profile);
      return { ok: true, value: { profile: { profileId: profile.name } } };
    }
  };
  const call = async (input) => openSshImportResultSchema.parse(await SshOpsService.prototype.openSshImport.call(service, openSshImportRequestSchema.parse(input)));
  const { value: { preview } } = await call({});
  const app = preview.entries.find((entry) => entry.name === "app");
  assert.equal(app.username, "deploy");
  assert.equal(app.port, 2222);
  assert.deepEqual(app.hops, ["a", "b"]);
  const request = { selection: { fingerprint: preview.fingerprint, groupId: null, names: ["app", "a", "b", "orphan", "cycle-a", "cycle-b"] } };
  await writeFile(path, config.replace("2222", "2223"));
  assert.equal((await call(request)).ok, false);
  assert.equal(profiles.size, 0);
  await writeFile(path, config);
  const result = (await call(request)).value.imported;
  assert.equal(result.created, 3);
  assert.deepEqual(result.details, [
    { name: "orphan", reason: "missing", items: ["missing"] },
    { name: "cycle-a", reason: "cycle", items: ["cycle-b"] },
    { name: "cycle-b", reason: "cycle", items: ["cycle-a"] }
  ]);
  assert.deepEqual(profiles.get("app").proxyJump, [{ profileId: "a" }, { profileId: "b" }]);
  assert.equal((await call(request)).value.imported.created, 0);
  assert.equal(profiles.size, 3);

  await writeFile(path, Array.from({ length: 500 }, (_, index) => `Host server-${index}`).join("\n"));
  const entries = await scanOpenSshConfig({ home });
  assert.equal(entries.length, 500);
  assert.ok(openSshImportRequestSchema.safeParse({ selection: { fingerprint: preview.fingerprint, groupId: null, names: entries.map((entry) => entry.name) } }).success);
  await writeFile(path, "Match exec \"never execute this\"\nHost example");
  await assert.rejects(scanOpenSshConfig({ home }), /Match/);
});
