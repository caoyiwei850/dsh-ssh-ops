import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanSshConfig, keyIsEncrypted } from "../src/ssh-config.js";
import SshOpsService, { profileDomainSpec } from "../src/index.js";

const SSH_IDENTIFIER = "-----BEGIN OPENSSH PRIVATE KEY-----\n";

function encryptedKey() {
  const body = Buffer.from("openssh-key-v1\0" + "aes256-ctr" + "bcrypt" + "salt").toString("base64");
  return SSH_IDENTIFIER + body + "\n-----END OPENSSH PRIVATE KEY-----\n";
}
function plainKey() {
  const body = Buffer.from("openssh-key-v1\0none\0unencrypted").toString("base64");
  return SSH_IDENTIFIER + body + "\n-----END OPENSSH PRIVATE KEY-----\n";
}

function table(values = []) {
  const data = new Map(values);
  return {
    get: (id) => data.get(id),
    put: async (id, value) => data.set(id, value),
    delete: async (id) => data.delete(id),
    entries: () => [...data.entries()],
    values: () => [...data.values()]
  };
}

function service(profiles = table(), groups = table()) {
  const secrets = new Map();
  const key = (ref) => typeof ref === "string" ? ref : JSON.stringify(ref);
  return {
    profiles, groups, secrets,
    requireProfileTable: () => profiles,
    requireGroupTable: () => groups,
    ctx: {
      credentials: {
        set: async (ref, value) => { secrets.set(key(ref), value); }
      }
    }
  };
}

async function home(files) {
  const root = await mkdtemp(join(tmpdir(), "ssh-config-test-"));
  await mkdir(join(root, ".ssh"), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(root, ".ssh", name), text, "utf8");
  }
  return root;
}

test("scan: parses concrete hosts, skips wildcards, resolves identity paths", async () => {
  const root = await home({
    config: [
      "Host alpha",
      "  HostName 10.0.0.1",
      "  User deploy",
      "  Port 2222",
      "  IdentityFile ~/.ssh/id_alpha",
      "",
      "Host beta",
      "  HostName beta.example.com",
      "  ProxyJump alpha",
      "",
      "Host *.internal",
      "  User root",
      ""
    ].join("\n")
  });
  try {
    const scan = await scanSshConfig({ home: root, localUser: "fallback" });
    assert.equal(scan.exists, true);
    assert.deepEqual(scan.entries.map((entry) => entry.name), ["alpha", "beta"]);
    const [alpha, beta] = scan.entries;
    assert.equal(alpha.host, "10.0.0.1");
    assert.equal(alpha.port, 2222);
    assert.equal(alpha.username, "deploy");
    assert.equal(alpha.identityFilePath, join(root, ".ssh", "id_alpha"));
    assert.equal(alpha.keyExists, false);
    assert.equal(beta.username, "fallback");
    assert.equal(beta.port, 22);
    assert.equal(beta.proxyJump, "alpha");
    assert.deepEqual(scan.warnings, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("scan: expands Include and keeps the first value per host", async () => {
  const root = await home({
    config: ["Host main", "  HostName main.example.com", "Include conf.d/*", "Host after", "  HostName after.example.com"].join("\n"),
    "ignored.txt": "Host notconfig"
  });
  await mkdir(join(root, ".ssh", "conf.d"), { recursive: true });
  await writeFile(join(root, ".ssh", "conf.d", "a"), "Host included\n  HostName first.example.com\n  Port 2200\n  Port 2300\n", "utf8");
  try {
    const scan = await scanSshConfig({ home: root, localUser: "tester" });
    assert.deepEqual(scan.entries.map((entry) => entry.name), ["main", "included", "after"]);
    assert.equal(scan.entries[1].host, "first.example.com");
    assert.equal(scan.entries[1].port, 2200);
    assert.deepEqual(scan.warnings, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("scan: a missing config is reported without throwing", async () => {
  const root = await mkdtemp(join(tmpdir(), "ssh-config-test-"));
  try {
    const scan = await scanSshConfig({ home: root, localUser: "tester" });
    assert.equal(scan.exists, false);
    assert.deepEqual(scan.entries, []);
    assert.match(scan.path, /\.ssh/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("keyIsEncrypted: PEM Proc-Type and bcrypt KDF container", () => {
  assert.equal(keyIsEncrypted("-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n"), true);
  assert.equal(keyIsEncrypted(encryptedKey()), true);
  assert.equal(keyIsEncrypted(plainKey()), false);
  assert.equal(keyIsEncrypted("not a key"), false);
});

test("import: creates profiles, stores keys, links ProxyJump, reports duplicates", async () => {
  const root = await home({ "id_plain": plainKey(), "id_locked": encryptedKey() });
  const profiles = table([["existing", { name: "dup", host: "h", port: 22, username: "u", authKind: "password", proxyJump: [] }]]);
  const groups = table();
  const s = service(profiles, groups);
  try {
    const envelope = await SshOpsService.prototype.sshConfigImport.call(s, {
      group: "生产环境",
      hosts: [
        { name: "dup", host: "dup.example.com", port: 22, username: "root", authKind: "password", importKey: false },
        { name: "jump", host: "jump.example.com", port: 22, username: "root", authKind: "key", identityFilePath: join(root, ".ssh", "id_plain"), importKey: true },
        { name: "app", host: "app.example.com", port: 2222, username: "deploy", authKind: "key", identityFilePath: join(root, ".ssh", "id_locked"), proxyJump: "jump", importKey: true },
        { name: "orphan", host: "orphan.example.com", port: 22, username: "root", authKind: "password", proxyJump: "missing", importKey: false }
      ]
    });

    assert.equal(envelope.ok, true, JSON.stringify(envelope));
    const result = envelope.value;
    assert.equal(result.created, 3);
    assert.deepEqual(result.skipped, ["dup"]);
    assert.equal(result.groups, 1);
    assert.equal(result.keysImported, 2);
    assert.deepEqual(result.passphraseRequired, ["app"]);
    assert.deepEqual(result.keyFailures, []);
    assert.equal(result.jumpLinked, 1);
    assert.deepEqual(result.jumpUnresolved, ["orphan"]);

    const created = [...profiles.entries()]
      .filter(([id]) => id !== "existing")
      .map(([, record]) => record);
    const byName = new Map(created.map((record) => [record.name, record]));
    assert.equal(byName.size, 3);
    const jumpId = [...profiles.entries()].find(([, record]) => record.name === "jump")[0];
    assert.deepEqual(byName.get("app").proxyJump, [{ profileId: jumpId }]);
    assert.deepEqual(byName.get("orphan").proxyJump, []);
    assert.equal(byName.get("app").groupId, [...groups.entries()][0][0]);
    assert.equal([...groups.entries()][0][1].name, "生产环境");
    assert.equal([...s.secrets.values()].length, 2);
    assert.ok([...s.secrets.values()].every((text) => text.includes("OPENSSH PRIVATE KEY")));
    assert.equal(profileDomainSpec !== undefined, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("import: rejects key material that is not a private key", async () => {
  const root = await home({ "notes.txt": "hello" });
  const profiles = table();
  const s = service(profiles, table());
  try {
    const envelope = await SshOpsService.prototype.sshConfigImport.call(s, {
      hosts: [{ name: "bad", host: "bad.example.com", port: 22, username: "root", authKind: "key", identityFilePath: join(root, ".ssh", "notes.txt"), importKey: true }]
    });
    assert.equal(envelope.ok, true, JSON.stringify(envelope));
    const result = envelope.value;
    assert.equal(result.created, 1);
    assert.equal(result.keysImported, 0);
    assert.equal(result.keyFailures.length, 1);
    assert.equal(result.keyFailures[0].name, "bad");
  } finally { await rm(root, { recursive: true, force: true }); }
});
