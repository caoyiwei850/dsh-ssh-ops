/**
 * Authentication-stage diagnostics for dsh-ssh-ops.
 *
 * ssh2 reports a failed login as a single opaque line ("All configured
 * authentication methods failed") and a device cutting the connection during
 * authentication as a bare close — neither tells the agent what actually
 * happened or what to try next. This module turns the raw handshake outcome
 * into a structured diagnosis:
 *
 *  - `createAuthTracker` records which methods were attempted and what the
 *    server said it still accepts (from USERAUTH_FAILURE), plus whether a
 *    keyboard-interactive prompt was ever served;
 *  - `makeAuthHandler` reproduces ssh2's default method order (none →
 *    password → publickey → keyboard-interactive) while feeding the tracker;
 *  - `classifyConnectFailure` maps the final error onto a stage, a reason and
 *    a short list of actionable hints;
 *  - `wasAuthCut` detects "the device killed the transport mid-authentication"
 *    — the trigger for the automatic keyboard-interactive → plain-password
 *    fallback (some firmware aborts the connection while an interactive
 *    session is in flight but accepts the plain password method).
 *
 * Pure and side-effect-free so the connect path can be unit-tested without a
 * socket.
 */

/** ssh2's default auth method order (client.js `authsAllowed`). */
const AUTH_METHOD_ORDER = ["none", "password", "publickey", "keyboard-interactive"];

/**
 * Build the per-connection auth tracker. Lives on the connection record so
 * transparent reconnects can consult the previous attempt's verdicts.
 */
export function createAuthTracker() {
  return {
    /** Method names actually offered, in order. */
    attempts: [],
    /** Last USERAUTH_FAILURE `methods left` list (what the server still accepts). */
    lastMethodsLeft: null,
    /** Any server-allowed list seen — the most informative failure detail. */
    sawFailure: false,
    /** A keyboard-interactive prompt round-trip happened. */
    kbdSeen: false
  };
}

/**
 * ssh2-compatible auth handler that walks the default method order while
 * recording progress. `tryKeyboard` must only be true when the caller has a
 * 'keyboard-interactive' listener attached that can answer prompts.
 */
export function makeAuthHandler(tracker, { hasPassword, hasPrivateKey, tryKeyboard }) {
  const available = AUTH_METHOD_ORDER.filter((method) => {
    if (method === "password") return hasPassword === true;
    if (method === "publickey") return hasPrivateKey === true;
    if (method === "keyboard-interactive") return tryKeyboard === true;
    return true; // 'none' is always probed first (RFC 4252 §5.2 semantics)
  });
  let next = 0;
  return (methodsLeft, _partialSuccess, _cb) => {
    // USERAUTH_FAILURE carries the server's remaining allowed methods; keep
    // the last list seen, because it names what the device would have accepted.
    if (Array.isArray(methodsLeft) && methodsLeft.length > 0) {
      tracker.lastMethodsLeft = [...methodsLeft];
      tracker.sawFailure = true;
    }
    if (next >= available.length) return false;
    const method = available[next];
    next += 1;
    tracker.attempts.push(method);
    return method;
  };
}

/** Errors meaning the transport itself died mid-handshake. */
const TRANSPORT_CUT_RE = /connection closed before handshake|Connection lost before handshake|keepalive timeout|ECONNRESET|EPIPE|read ECONNRESET/i;

/** ssh2's terminal auth verdict. */
const AUTH_REJECTED_RE = /All configured authentication methods failed/;

/** Stages of a failed connect, used by the agent to decide the next move. */
export const CONNECT_FAILURE_STAGES = Object.freeze({
  AUTH: "auth",
  TRANSPORT: "transport",
  PROTOCOL: "protocol",
  UNKNOWN: "unknown"
});

/**
 * Detect "the device killed the connection while authentication was in
 * flight". Requires evidence that auth had actually started (a failure
 * response or a keyboard-interactive prompt), otherwise this is an ordinary
 * network failure, not an auth downgrade trigger.
 */
export function wasAuthCut(tracker, error) {
  if (!tracker) return false;
  const authStarted = tracker.sawFailure || tracker.kbdSeen || tracker.attempts.length > 1;
  if (!authStarted) return false;
  if (error instanceof Error && TRANSPORT_CUT_RE.test(error.message)) return true;
  // ssh2 protocol-level fatal during the auth phase also counts.
  return error instanceof Error && error.level === "handshake" && tracker.kbdSeen;
}

/** Hints for an auth rejection, from what was attempted and what the server allows. */
function authHints(tracker, { hasPassword, hasPrivateKey }) {
  const hints = [];
  const tried = tracker?.attempts ?? [];
  if (tried.includes("password")) hints.push("the password may be wrong, or this account is not allowed to log in with a password");
  if (tried.includes("publickey")) hints.push("the private key may not be authorized on the server (missing from authorized_keys), unreadable, or need a passphrase");
  const left = tracker?.lastMethodsLeft;
  if (Array.isArray(left) && left.length > 0) {
    hints.push(`the server still accepts: ${left.join(", ")}`);
    if (!left.includes("password") && left.includes("keyboard-interactive") && hasPassword) {
      hints.push("the server requires keyboard-interactive (MFA/one-time code); the plugin answered prompts with the saved password — if the code is dynamic, authenticate manually in the SSH panel instead");
    }
    if (!left.includes("password") && !left.includes("keyboard-interactive") && !left.includes("publickey") && hasPrivateKey) {
      hints.push("the server rejected the key's algorithm or type; check which host key/signature algorithms the device enables");
    }
  }
  hints.push("verify the account is not expired or locked, and that the server permits logins from this source");
  return hints;
}

const TRANSPORT_HINTS = {
  "connection closed before handshake": "the device or a firewall closed the TCP/SSH transport — common with rate limiting, fail2ban, or devices that drop unauthenticated sessions",
  "Connection lost before handshake": "the device or a firewall closed the TCP/SSH transport — common with rate limiting, fail2ban, or devices that drop unauthenticated sessions",
  keepalive: "the peer stopped responding while the handshake was in flight (network drop or device overload)",
  ECONNRESET: "the TCP connection was reset — a firewall, VPN, or the server itself dropped the session",
  EPIPE: "the TCP connection was reset — a firewall, VPN, or the server itself dropped the session"
};

const PROTOCOL_HINTS = [
  { re: /signature verification failed/i, hint: "the server's host-key signature did not verify — the device's key encoding or signature algorithm may be off-spec, or the key changed" },
  { re: /no matching (key exchange|host key|cipher|MAC)|protocol negotiation|Couldn't agree/i, hint: "no shared SSH algorithm — this is usually a legacy device; retry the connection with the legacy algorithms option enabled" },
  { re: /Invalid identification string/i, hint: "the device's SSH banner is malformed; the plugin retries such handshakes with the banner normalized — a persistent failure means the device speaks a non-SSH protocol on this port" },
  { re: /Host key (does not match|verification failed|denied)/i, hint: "the presented host key did not match the negotiated type or the stored fingerprint — confirm the server identity before changing the host-key policy" }
];

/**
 * Turn a connect failure into a structured diagnosis. Never throws; unknown
 * errors fall through to a pass-through verdict so the caller always has a
 * message.
 */
export function classifyConnectFailure(error, tracker, creds = {}) {
  if (!(error instanceof Error)) {
    return { stage: CONNECT_FAILURE_STAGES.UNKNOWN, reason: "unknown", message: String(error ?? "connection failed"), hints: [] };
  }
  const message = error.message ?? String(error);

  if (error.level === "client-authentication" || AUTH_REJECTED_RE.test(message)) {
    const hints = authHints(tracker, creds);
    const tried = tracker?.attempts?.join(", ") || "none";
    return {
      stage: CONNECT_FAILURE_STAGES.AUTH,
      reason: "auth-rejected",
      message: `authentication rejected by the server (tried: ${tried})`,
      hints
    };
  }

  if (TRANSPORT_CUT_RE.test(message)) {
    const matched = Object.entries(TRANSPORT_HINTS).find(([key]) =>
      key === message.toLowerCase().trim() || message.toLowerCase().includes(key.toLowerCase()));
    return {
      stage: CONNECT_FAILURE_STAGES.TRANSPORT,
      reason: "transport-cut",
      message,
      hints: [matched ? matched[1] : "the SSH transport died mid-handshake; retry, and check firewalls/rate limits between here and the device"]
    };
  }

  if (error.level === "handshake" || error.level === "protocol") {
    const hint = PROTOCOL_HINTS.find(({ re }) => re.test(message));
    return {
      stage: CONNECT_FAILURE_STAGES.PROTOCOL,
      reason: "handshake-failed",
      message,
      hints: hint ? [hint.hint] : ["the SSH handshake violated the protocol; capture the device's SSH version output if this persists"]
    };
  }

  return { stage: CONNECT_FAILURE_STAGES.UNKNOWN, reason: "unknown", message, hints: [] };
}

/** Compose the diagnosis into the final `connect-failed` error text. */
export function formatConnectFailure(diagnosis, target) {
  const lines = [`${target}: ${diagnosis.message}`];
  if (diagnosis.hints.length > 0) {
    lines.push("Likely causes / next steps:");
    for (const hint of diagnosis.hints) lines.push(`- ${hint}`);
  }
  return lines.join("\n");
}
