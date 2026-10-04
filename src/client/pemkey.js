import { t } from "../i18n/core.js";
/**
 * Pre-flight validation for pasted/imported PEM private keys. A truncated or
 * empty-shell paste used to survive the form and surface later as a bare
 * "All configured authentication methods failed"; catch it at the entry point
 * instead. Returns null when the key is acceptable (including empty — password
 * auth and edit-keep-current flows rely on that), or a user-facing message.
 */
export function privateKeyProblem(secret) {
  const key = (secret ?? "").trim();
  if (!key) return null;
  const begin = key.match(/^-----BEGIN ([A-Z ]*PRIVATE KEY)-----/);
  const end = key.match(/-----END ([A-Z ]*PRIVATE KEY)-----$/);
  if (!begin || !end) {
    return t("The private key is incomplete: it must start with -----BEGIN … PRIVATE KEY----- and end with -----END … PRIVATE KEY-----. Check that you copied it in full.");
  }
  if (begin[1] !== end[1]) {
    return t(`The private key's BEGIN/END labels do not match: BEGIN is ${begin[1]}, END is ${end[1]}. Check that you copied it in full.`);
  }
  const body = key.slice(begin[0].length, key.length - end[0].length);
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    return t("The private key body is empty: it contains only the BEGIN/END lines. Check that you copied it in full.");
  }
  // Base64 body lines, plus "Proc-Type:"/"DEK-Info:" headers that appear in
  // traditional encrypted PEM.
  const ok = lines.every((line) => /^[A-Za-z0-9+/]+={0,2}$/.test(line) || /^[A-Za-z][A-Za-z0-9-]*:\s*\S/.test(line));
  if (!ok) {
    return t("The private key body contains invalid characters. Check that you copied the complete PEM contents.");
  }
  return null;
}
