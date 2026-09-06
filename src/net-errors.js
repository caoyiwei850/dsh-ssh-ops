/**
 * Connect retry policy: classify a failed SSH handshake as transient (worth
 * retrying with backoff) or permanent (surface immediately). Based on the
 * error's `code` first — ssh2 surfaces socket errors as Node errno codes —
 * with a message fallback for protocol-level failures that carry no code.
 * Authentication failures are never retried regardless of wording.
 */
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "EPIPE"
]);

const PERMANENT_MESSAGE_RE = /authenticat|permission|denied/i;
const TRANSIENT_MESSAGE_RE = /reset|timeout|timed out|kex|handshake|socket/i;

export function isTransientConnectError(error) {
  const code = error?.code === undefined ? "" : String(error.code);
  if (code !== "" && !TRANSIENT_CODES.has(code)) return false;
  const message = String(error?.message ?? error);
  if (PERMANENT_MESSAGE_RE.test(message)) return false;
  return TRANSIENT_CODES.has(code) || TRANSIENT_MESSAGE_RE.test(message);
}
