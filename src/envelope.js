/**
 * The one error-envelope vocabulary for the whole plugin. Host Remote methods
 * and agent tools share the same shapes:
 * - fail(code, message)     → the bare { code, message } carried inside a result envelope
 * - failResult(code, message) → the full { ok: false, error } envelope
 */

export function fail(code, message) {
  return { code, message };
}

export function failResult(code, message) {
  return { ok: false, error: { code, message } };
}
