
/**
 * Pre-flight validation for pasted/imported PEM private keys. A truncated or
 * empty-shell paste used to survive the form and surface later as a bare
 * "All configured authentication methods failed"; catch it at the entry point
 * instead. Returns null when the key is acceptable (including empty — password
 * auth and edit-keep-current flows rely on that), or a user-facing message.
 */
import { t } from "../i18n/core.js";
export function privateKeyProblem(secret) {
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
  return null;
}
