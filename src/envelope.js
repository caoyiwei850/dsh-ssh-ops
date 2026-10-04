/**
 * The one error-envelope vocabulary for the whole plugin. Host Remote methods
 * and agent tools share the same shapes:
 * - fail(code, message)     → the bare { code, message } carried inside a result envelope
 * - failResult(code, message) → the full { ok: false, error } envelope
 *
 * `code` is a stable machine-readable identifier and is never localized (the
 * client keys on it). `message` is user-facing, so it is translated here, in
 * the single place every host error is built, rather than at each of the many
 * call sites. A message that is already Chinese, or that has no dictionary
 * entry, passes through unchanged.
 */
import { t } from "./i18n/core.js";

export function fail(code, message) {
  return { code, message: t(message) };
}

export function failResult(code, message) {
  return { ok: false, error: { code, message: t(message) } };
}
