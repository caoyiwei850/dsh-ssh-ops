/**
 * Client-side data-path regression tests. These run in Node against the real
 * client modules (no DOM needed): the SshApi base64 byte codec that carries
 * SFTP file contents, and the PEM private-key pre-flight validator.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SshApi } from "../src/client/api.js";
import { privateKeyProblem, isEncryptedPrivateKey } from "../src/client/pemkey.js";

// ── SshApi: shared-credential RPC wrappers stay available to settings UI ───
{
  const calls = [];
  const api = new SshApi(() => ({
    credentialList: async (arg) => { calls.push(["list", arg]); return { ok: true, value: { ok: true, value: { credentials: [] } } }; },
    credentialSave: async (arg) => { calls.push(["save", arg]); return { ok: true, value: { ok: true, value: { credential: {}, credentialRefs: {} } } }; },
    credentialDelete: async (arg) => { calls.push(["delete", arg]); return { ok: true, value: { ok: true, value: { deleted: true } } }; }
  }));
  await api.credentialList();
  await api.credentialSave({ name: "shared key", authKind: "key" });
  await api.credentialDelete("00000000-0000-4000-8000-000000000001");
  assert.deepEqual(calls, [["list", {}], ["save", { name: "shared key", authKind: "key" }], ["delete", { credentialId: "00000000-0000-4000-8000-000000000001" }]]);
}

// ── SshApi: a pane click takes the plain connection id the panel holds ────
{
  const calls = [];
  const api = new SshApi(() => ({
    selectConnection: async (arg) => { calls.push(arg); return { ok: true, value: { ok: true, value: { activeConnectionId: "b" } } }; }
  }));
  const result = await api.selectConnection("b");
  assert.deepEqual(calls, [{ connectionId: "b" }], "the wrapper wraps the id instead of sending a bare string");
  assert.equal(result.activeConnectionId, "b", "both envelopes are unwrapped for the caller");
}

// ── SshApi: file contents must survive as raw bytes, not UTF-8 text ──
{
  const captured = [];
  const api = new SshApi(() => ({
    sftpWriteFile: async (rpc) => {
      captured.push(rpc.data);
      return { ok: true, value: { ok: true, value: null } };
    },
    sftpReadFile: async () => ({ ok: true, value: { ok: true, value: { data: captured[0], bytes: payload.length, truncated: false } } })
  }));

  // Crosses the 0x8000 chunk boundary in the base64 encoder.
  const payload = randomBytes(64 * 1024 + 7);
  await api.sftpWriteFile("c1", "/tmp/x.bin", new Uint8Array(payload));
  assert.equal(captured[0], payload.toString("base64"), "sftpWriteFile encodes raw bytes exactly like Buffer.toString('base64')");

  const back = await api.sftpReadFile("c1", "/tmp/x.bin");
  assert.ok(Buffer.from(back.data).equals(payload), "sftpReadFile returns the exact original bytes");

  // The old bug: bytes that are invalid UTF-8 got mangled through TextDecoder.
  const binary = Uint8Array.from({ length: 256 }, (_, i) => i);
  const decoded = await (async () => {
    const stub = new SshApi(() => ({
      sftpReadFile: async () => ({ ok: true, value: { ok: true, value: { data: Buffer.from(binary).toString("base64"), bytes: 256, truncated: false } } })
    }));
    return stub.sftpReadFile("c1", "/tmp/x.bin");
  })();
  assert.ok(Buffer.from(decoded.data).equals(Buffer.from(binary)), "all 256 byte values round-trip through the codec untouched");
}

// ── SshApi: SCP uses exactly the same binary codec as SFTP ──────────────────
{
  const captured = [];
  const payload = randomBytes(4099);
  const api = new SshApi(() => ({
    scpWriteFile: async (rpc) => {
      captured.push(rpc.data);
      return { ok: true, value: { ok: true, value: { path: rpc.path, bytes: payload.length } } };
    },
    scpReadFile: async () => ({ ok: true, value: { ok: true, value: { path: "/tmp/x.bin", data: captured[0], bytes: payload.length, truncated: false } } })
  }));
  await api.scpWriteFile("c1", "/tmp/x.bin", new Uint8Array(payload));
  const back = await api.scpReadFile("c1", "/tmp/x.bin");
  assert.ok(Buffer.from(back.data).equals(payload), "SCP upload/download retains every binary byte");
}

// ── privateKeyProblem: reject truncated / empty-shell / mismatched PEM up front ──
const OPENSSH_KEY = ["-----BEGIN OPENSSH PRIVATE KEY-----", "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB", "-----END OPENSSH PRIVATE KEY-----", ""].join("\n");
const TRAD_ENCRYPTED_KEY = ["-----BEGIN RSA PRIVATE KEY-----", "Proc-Type: 4,ENCRYPTED", "DEK-Info: AES-128-CBC,0123456789ABCDEF0123456789ABCDEF", "MIIEpAIBAAKCAQEA7fF", "-----END RSA PRIVATE KEY-----", ""].join("\n");

assert.equal(privateKeyProblem(""), null, "empty is allowed (password auth / edit-keep-current)");
assert.equal(privateKeyProblem(null), null, "null is allowed");
assert.equal(privateKeyProblem(OPENSSH_KEY), null, "complete OpenSSH-format key passes");
assert.ok(privateKeyProblem(TRAD_ENCRYPTED_KEY), "an encrypted PEM with Proc-Type headers is now flagged when no passphrase is given (it used to pass silently and fail at connect time)");
assert.equal(privateKeyProblem(OPENSSH_KEY.replaceAll("\n", "\r\n")), null, "CRLF line endings pass");

assert.ok(privateKeyProblem("b3BlbnNzaC1rZXk..."), "key without BEGIN/END headers is rejected");
assert.ok(privateKeyProblem(OPENSSH_KEY.slice(0, OPENSSH_KEY.indexOf("b3BlbnNzaC1rZXk"))), "truncated key missing END line is rejected");
assert.ok(privateKeyProblem(OPENSSH_KEY.replace("b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB\n", "")), "empty-shell key (headers only, no body) is rejected");
assert.ok(
  privateKeyProblem(OPENSSH_KEY.replace("BEGIN OPENSSH PRIVATE KEY", "BEGIN RSA PRIVATE KEY")),
  "BEGIN/END type mismatch is rejected"
);
assert.ok(privateKeyProblem("-----BEGIN OPENSSH PRIVATE KEY-----\n不是base64!!!\n-----END OPENSSH PRIVATE KEY-----"), "non-base64 body is rejected");

// ── isEncryptedPrivateKey + the save-time passphrase gate ───────────────────
// The field report behind this gate: an encrypted key saved with its
// passphrase typed into the password/second-factor field connects never, and
// the failure used to surface as raw ssh2 English. Detect the encryption at
// the form instead.
assert.equal(isEncryptedPrivateKey(OPENSSH_KEY), false, "the OpenSSH fixture carries ciphername=none");
assert.equal(isEncryptedPrivateKey(TRAD_ENCRYPTED_KEY), true, "Proc-Type: 4,ENCRYPTED marks a classic PEM as encrypted");
assert.equal(isEncryptedPrivateKey("-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----"), true, "PKCS#8 encrypted PEM is detected by its BEGIN line");
assert.equal(isEncryptedPrivateKey("ssh-rsa AAAAB3 user@host"), false, "a public key is not a private key");
assert.equal(isEncryptedPrivateKey(""), false, "empty is not encrypted (password auth / edit-keep-current)");
assert.ok(privateKeyProblem(TRAD_ENCRYPTED_KEY), "an encrypted key without a passphrase is rejected at the form");
assert.equal(privateKeyProblem(TRAD_ENCRYPTED_KEY, "the-passphrase"), null, "the same key passes once a passphrase is present");
assert.equal(privateKeyProblem(OPENSSH_KEY, ""), null, "an unencrypted key needs no passphrase");

// Real keys from ssh-keygen exercise the OpenSSH-format path (the cipher name
// lives inside the base64 body), which the literals above cannot cover.
// Skipped gracefully where ssh-keygen is unavailable.
{
  const probe = spawnSync("ssh-keygen", []);
  if (probe.error) {
    console.log("ssh-keygen unavailable — skipping generated-key encryption cases");
  } else {
    const dir = mkdtempSync(join(tmpdir(), "dsh-ssh-ops-key-"));
    try {
      execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "secret123", "-f", join(dir, "enc"), "-C", "t"], { stdio: "pipe" });
      execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(dir, "plain"), "-C", "t"], { stdio: "pipe" });
      const encrypted = readFileSync(join(dir, "enc"), "utf8");
      const plain = readFileSync(join(dir, "plain"), "utf8");
      assert.equal(isEncryptedPrivateKey(encrypted), true, "ssh-keygen -N <pass> produces an encrypted OpenSSH key");
      assert.equal(isEncryptedPrivateKey(plain), false, "ssh-keygen -N '' produces an unencrypted key");
      assert.ok(privateKeyProblem(encrypted), "generated encrypted key without a passphrase is rejected at the form");
      assert.equal(privateKeyProblem(encrypted, "secret123"), null, "generated encrypted key with its passphrase passes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

console.log("client codec + pemkey: all cases passed");
