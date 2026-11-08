import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptResourceBackup, decryptResourceBackup } from "../src/resource-backup-crypto.js";

test("encrypted backup round trips without exposing credentials", async () => {
  const data = { servers: [{ host: "private-host", password: "example-secret" }] };
  const password = "a sufficiently long passphrase";
  const archive = await encryptResourceBackup(data, password);
  assert.equal(archive.includes("example-secret"), false);
  assert.equal(archive.includes("private-host"), false);
  assert.deepEqual(await decryptResourceBackup(archive, password), data);
  assert.notEqual(await encryptResourceBackup(data, password), archive);
  await assert.rejects(decryptResourceBackup(archive, "a different long passphrase"), /Wrong password/);
  const tampered = JSON.parse(archive);
  const ciphertext = Buffer.from(tampered.ciphertext, "base64"); ciphertext[0] ^= 1;
  tampered.ciphertext = ciphertext.toString("base64");
  await assert.rejects(decryptResourceBackup(JSON.stringify(tampered), password), /damaged backup/);
  await assert.rejects(encryptResourceBackup(data, "short"), /at least 12/);
});
