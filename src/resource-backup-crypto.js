import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const AAD = Buffer.from("dsh-ssh-ops/ssh-resource-backup/v1", "utf8");
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const SCRYPT = Object.freeze({ N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

function checkPassword(password) {
  if (typeof password !== "string" || password.length < 12 || Buffer.byteLength(password, "utf8") > 1024) {
    throw new Error("Backup password must contain at least 12 characters");
  }
}

function decode(value, length) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("Invalid backup format");
  const result = Buffer.from(value, "base64");
  if ((length !== undefined && result.length !== length) || result.toString("base64") !== value) throw new Error("Invalid backup format");
  return result;
}

export async function encryptResourceBackup(payload, password) {
  checkPassword(password);
  const plain = Buffer.from(JSON.stringify(payload), "utf8");
  if (plain.length > MAX_ARCHIVE_BYTES) throw new Error("Backup exceeds size limit");
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = await scrypt(password, salt, 32, SCRYPT);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    return JSON.stringify({ format: "dsh-ssh-ops-resource-backup", version: 1, kdf: "scrypt-32768-8-1", cipher: "aes-256-gcm", salt: salt.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") });
  } finally { key.fill(0); plain.fill(0); }
}

export async function decryptResourceBackup(archive, password) {
  checkPassword(password);
  if (typeof archive !== "string" || Buffer.byteLength(archive, "utf8") > MAX_ARCHIVE_BYTES * 2) throw new Error("Invalid backup format");
  let data;
  try { data = JSON.parse(archive); } catch { throw new Error("Invalid backup format"); }
  if (!data || data.format !== "dsh-ssh-ops-resource-backup" || data.version !== 1 || data.kdf !== "scrypt-32768-8-1" || data.cipher !== "aes-256-gcm") throw new Error("Invalid backup format");
  const salt = decode(data.salt, 16), iv = decode(data.iv, 12), tag = decode(data.tag, 16), ciphertext = decode(data.ciphertext);
  if (ciphertext.length > MAX_ARCHIVE_BYTES) throw new Error("Invalid backup format");
  const key = await scrypt(password, salt, 32, SCRYPT);
  let plain;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(AAD); decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plain.toString("utf8"));
  } catch { throw new Error("Wrong password or damaged backup"); }
  finally { key.fill(0); plain?.fill(0); }
}
