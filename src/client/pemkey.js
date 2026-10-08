
/**
 * Pre-flight validation for pasted/imported PEM private keys. A truncated or
 * empty-shell paste used to survive the form and surface later as a bare
 * "All configured authentication methods failed"; catch it at the entry point
 * instead. Returns null when the key is acceptable (including empty — password
 * auth and edit-keep-current flows rely on that), or a user-facing message.
 */
import { t } from "../i18n/core.js";

/**
 * Whether a pasted private key is passphrase-protected. OpenSSH-format keys
 * carry the cipher name inside the base64 body ("none" when unencrypted), so
 * decode the header chunk and read it; classic PEM signals encryption with a
 * "Proc-Type: 4,ENCRYPTED" header, PKCS#8 with its BEGIN line. False
 * negatives are acceptable (connect-time diagnosis catches those later);
 * false positives are not (they would block a working key).
 */
export function isEncryptedPrivateKey(secret) {
  const key = (secret ?? "").trim();
  if (!key.startsWith("-----BEGIN")) return false;
  if (key.startsWith("-----BEGIN ENCRYPTED PRIVATE KEY-----")) return true;
  if (/^-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----[\s\S]{0,200}Proc-Type:\s*4,\s*ENCRYPTED/i.test(key)) return true;
  if (!key.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----")) return false;
  const base64 = key.slice("-----BEGIN OPENSSH PRIVATE KEY-----".length).replace(/-----[\s\S]*$/, "").replace(/\s+/g, "");
  let head;
  try { head = atob(base64.slice(0, 96)); } catch { return false; }
  if (!head.startsWith("openssh-key-v1\u0000")) return false;
  const cipherLength = (head.charCodeAt(15) << 24 | head.charCodeAt(16) << 16 | head.charCodeAt(17) << 8 | head.charCodeAt(18)) >>> 0;
  if (cipherLength === 0 || cipherLength > 32) return false;
  return head.slice(19, 19 + cipherLength) !== "none";
}

export function privateKeyProblem(secret, passphrase = "") {
  const key = (secret ?? "").trim();
  if (!key) return null;
  const begin = key.match(/^-----BEGIN ([A-Z ]*PRIVATE KEY)-----/);
  const end = key.match(/-----END ([A-Z ]*PRIVATE KEY)-----$/);
  if (!begin || !end) {
    return t("私钥内容不完整：应以 -----BEGIN … PRIVATE KEY----- 开头、-----END … PRIVATE KEY----- 结尾，请检查是否拷贝完整");
  }
  if (begin[1] !== end[1]) {
    return t(`私钥首尾行不匹配：BEGIN 是 ${begin[1]}，END 是 ${end[1]}，请检查是否拷贝完整`);
  }
  const body = key.slice(begin[0].length, key.length - end[0].length);
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    return t("私钥主体为空：只有 BEGIN/END 首尾行，请检查是否拷贝完整");
  }
  // Base64 body lines, plus "Proc-Type:"/"DEK-Info:" headers that appear in
  // traditional encrypted PEM.
  const ok = lines.every((line) => /^[A-Za-z0-9+/]+={0,2}$/.test(line) || /^[A-Za-z][A-Za-z0-9-]*:\s*\S/.test(line));
  if (!ok) {
    return t("私钥主体包含非法字符，请检查是否拷贝了完整的 PEM 内容");
  }
  // An encrypted key saved without its passphrase can never work through any
  // connect path — ssh2 refuses to parse it — and the failure used to surface
  // later as raw English. The password / second-factor fields do NOT decrypt
  // the key, so a passphrase typed there is the exact mis-slot this catches.
  if (isEncryptedPrivateKey(key) && !String(passphrase ?? "").trim()) {
    return t("这把私钥是加密的：请在「私钥口令」中填写生成它时设置的口令后再保存——「密码」/「第二因素」字段不会用来解密私钥");
  }
  return null;
}
