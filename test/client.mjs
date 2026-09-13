/**
 * Client-side data-path regression tests. These run in Node against the real
 * client modules (no DOM needed): the SshApi base64 byte codec that carries
 * SFTP file contents, and the PEM private-key pre-flight validator.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { SshApi } from "../src/client/api.js";
import { privateKeyProblem } from "../src/client/pemkey.js";

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
assert.equal(privateKeyProblem(TRAD_ENCRYPTED_KEY), null, "traditional encrypted PEM with Proc-Type headers passes");
assert.equal(privateKeyProblem(OPENSSH_KEY.replaceAll("\n", "\r\n")), null, "CRLF line endings pass");

assert.ok(privateKeyProblem("b3BlbnNzaC1rZXk..."), "key without BEGIN/END headers is rejected");
assert.ok(privateKeyProblem(OPENSSH_KEY.slice(0, OPENSSH_KEY.indexOf("b3BlbnNzaC1rZXk"))), "truncated key missing END line is rejected");
assert.ok(privateKeyProblem(OPENSSH_KEY.replace("b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB\n", "")), "empty-shell key (headers only, no body) is rejected");
assert.ok(
  privateKeyProblem(OPENSSH_KEY.replace("BEGIN OPENSSH PRIVATE KEY", "BEGIN RSA PRIVATE KEY")),
  "BEGIN/END type mismatch is rejected"
);
assert.ok(privateKeyProblem("-----BEGIN OPENSSH PRIVATE KEY-----\n不是base64!!!\n-----END OPENSSH PRIVATE KEY-----"), "non-base64 body is rejected");

console.log("client codec + pemkey: all cases passed");
