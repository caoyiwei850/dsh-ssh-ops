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
 *    password → publickey → agent → keyboard-interactive) while feeding the
 *    tracker;
 *  - `classifyConnectFailure` maps the final error onto a stage, a reason and
 *    a short list of actionable hints;
 *  - `wasAuthCut` detects "the device killed the transport mid-authentication"
 *    — the trigger for the automatic keyboard-interactive → plain-password
 *    fallback (some firmware aborts the connection while an interactive
 *    session is in flight but accepts the plain password method).
 *
 * Pure and side-effect-free so the connect path can be unit-tested without a
 * socket (the t() calls live inside the diagnosis function, never at module
 * top level, so they follow the active language instead of freezing at import).
 */
import { t } from "./i18n/core.js";

/** ssh2's default auth method order (client.js `authsAllowed`), with its separate `agent` method. */
const AUTH_METHOD_ORDER = ["none", "password", "publickey", "agent", "keyboard-interactive"];

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
 *
 * Dual-factor devices (`AuthenticationMethods password,publickey` or the
 * reverse) answer every completed factor with USERAUTH_FAILURE carrying
 * `partial success`. On such a response the handler restarts the method
 * order: each restart means one more factor has been accepted, so the walk
 * terminates in at most (factors × methods) steps and the second factor
 * actually gets offered instead of exhausting the list after the first.
 */
export function makeAuthHandler(tracker, { hasPassword, hasPrivateKey, hasAgent, tryKeyboard }) {
  const available = AUTH_METHOD_ORDER.filter((method) => {
    if (method === "password") return hasPassword === true;
    if (method === "publickey") return hasPrivateKey === true;
    // ssh2 exposes the local ssh-agent as its own method name; it is only in
    // `authsAllowed` when the connect config carried an `agent` socket.
    if (method === "agent") return hasAgent === true;
    if (method === "keyboard-interactive") return tryKeyboard === true;
    return true; // 'none' is always probed first (RFC 4252 §5.2 semantics)
  });
  let next = 0;
  return (methodsLeft, partialSuccess, _cb) => {
    // USERAUTH_FAILURE carries the server's remaining allowed methods; keep
    // the last list seen, because it names what the device would have accepted.
    if (Array.isArray(methodsLeft) && methodsLeft.length > 0) {
      tracker.lastMethodsLeft = [...methodsLeft];
      tracker.sawFailure = true;
    }
    if (partialSuccess === true) {
      tracker.partialSuccesses = (tracker.partialSuccesses ?? 0) + 1;
      // One factor accepted — start over for the remaining factor(s). The
      // 'none' probe is pointless after real credentials were accepted, so a
      // restart resumes at the first credentialed method. The bound keeps a
      // nonconformant server that re-reports the same factor from looping.
      if (tracker.partialSuccesses <= available.length) {
        next = available[0] === "none" ? 1 : 0;
      }
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

/**
 * ssh2 surfaces a server-sent SSH_MSG_DISCONNECT as an Error whose `message`
 * is the device's own description text and whose numeric `code` is the RFC
 * 4253 §11.1 disconnect reason (ssh2 sets no `level` on it). Node system
 * errors carry STRING codes, so an integer in 1..15 is unambiguous.
 */
export function isServerDisconnect(error) {
  return error instanceof Error && Number.isInteger(error.code) && error.code >= 1 && error.code <= 15;
}

/** RFC 4253 §11.1 reason names, for the diagnosis message line. */
const DISCONNECT_REASON_NAMES = {
  1: "HOST_NOT_ALLOWED_TO_CONNECT", 2: "PROTOCOL_ERROR", 3: "KEY_EXCHANGE_FAILED",
  4: "RESERVED", 5: "MAC_ERROR", 6: "COMPRESSION_ERROR", 7: "SERVICE_NOT_AVAILABLE",
  8: "PROTOCOL_VERSION_NOT_SUPPORTED", 9: "HOST_KEY_NOT_VERIFIABLE", 10: "CONNECTION_LOST",
  12: "TOO_MANY_CONNECTIONS", 13: "AUTH_CANCELED_BY_USER", 14: "NO_MORE_AUTH_METHODS_AVAILABLE",
  15: "ILLEGAL_USER_NAME"
};

/** Cause hints keyed by reason code; absent codes fall back to the device-log hint. */
const DISCONNECT_CODE_HINTS = {
  1: "the host refused the connection by policy (hosts.allow/deny or an allowlist on the device)",
  3: "the key exchange failed on the device side — a legacy device may need the legacy algorithms option",
  7: "the device's SSH service is unavailable — it may be overloaded or sshd is not fully up; retry later",
  12: "the device hit its connection/VTY limit — wait for other sessions to free up or raise the device limit",
  14: "the device saw every offered auth method rejected — verify the credentials and the account's allowed methods",
  15: "the username is not known to the device or not allowed to log in"
};

/** Vendor texts worth translating; matched case-insensitively against the description. */
const DISCONNECT_TEXT_HINTS = [
  { re: /already (?:been )?(?:logged|connected)|logged (?:in|on) (?:elsewhere|on another)/i, hint: "the account is already logged in elsewhere — many devices allow only one active session per account" },
  { re: /RADIUS|TACACS|LDAP|AAA (?:server|backend)/i, hint: "the device cannot reach its authentication backend (RADIUS/TACACS/LDAP) — logins fail until it recovers" },
  { re: /VTY|virtual terminal/i, hint: "the device's VTY lines are exhausted or misconfigured" },
  { re: /auth\w*[ ?]?timed? ?out|timed? ?out (?:during|waiting for) auth/i, hint: "the device's authentication timeout is shorter than the login round trip — check network latency or the device timeout" },
  { re: /\blocked\b|\bdisabled\b|deactivated/i, hint: "the account appears locked or disabled on the device" }
];

/** Stages of a failed connect, used by the agent to decide the next move. */
export const CONNECT_FAILURE_STAGES = Object.freeze({
  AUTH: "auth",
  TRANSPORT: "transport",
  PROTOCOL: "protocol",
  // Local credential problem (an encrypted key saved without its passphrase,
  // an unparseable key): the server never saw an authentication attempt.
  CREDENTIAL: "credential",
  UNKNOWN: "unknown"
});

/**
 * Diagnose ssh2's private-key parse failures. ssh2 surfaces a bad LOCAL key
 * as a plain Error ("Cannot parse privateKey: …", no `level`/`code`) thrown
 * from its auth context before any server-side attempt — an encrypted key
 * saved without its passphrase is the field-report case. These used to fall
 * into the unknown bucket as raw English with zero hints (and a
 * level-carrying variant would masquerade as a server rejection). Returns
 * undefined when the message is not a key-parse failure.
 */
function keyParseDiagnosis(message) {
  if (!/Cannot parse privateKey|no passphrase given|Private key is encrypted|integrity check failed|bad passphrase/i.test(message)) {
    return undefined;
  }
  if (/no passphrase given|Private key is encrypted/i.test(message)) {
    return {
      stage: CONNECT_FAILURE_STAGES.CREDENTIAL,
      reason: "key-encrypted-without-passphrase",
      message: t("私钥是加密的，但「私钥口令」是空的——口令没有随连接送出，这把私钥解不开"),
      hints: [
        t("打开该服务器（或共享凭据）的编辑表单，在「私钥口令」一栏填写生成私钥时设置的口令，保存后重连"),
        t("口令填在「密码」或「第二因素：密码」里不会生效：那是登录服务器用的密码槽，不是解密私钥的口令槽")
      ]
    };
  }
  if (/integrity check failed|bad passphrase/i.test(message)) {
    return {
      stage: CONNECT_FAILURE_STAGES.CREDENTIAL,
      reason: "key-bad-passphrase",
      message: t("私钥口令不正确：用当前保存的口令解不开这把私钥"),
      hints: [t("在编辑表单的「私钥口令」里重新输入正确的口令后保存（留空表示保持原值）")]
    };
  }
  return {
    stage: CONNECT_FAILURE_STAGES.CREDENTIAL,
    reason: "key-unparseable",
    message: t("无法解析这把私钥的格式"),
    hints: [message, t("确认粘贴的是完整私钥（含首尾 BEGIN/END 行），OpenSSH 或 PEM 格式；.pub 公钥不能用于登录")]
  };
}

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
  // ssh2 protocol-level fatal during the auth phase also counts. A device that
  // sends SSH_MSG_DISCONNECT mid keyboard-interactive exchange is the same
  // firmware behaviour as dropping the transport — the plain-password retry
  // is the documented remedy for both shapes.
  if (error instanceof Error && error.level === "handshake" && tracker.kbdSeen) return true;
  return isServerDisconnect(error) && tracker.kbdSeen;
}

/** Hints for an auth rejection, from what was attempted and what the server allows. */
function authHints(tracker, { hasPassword, hasPrivateKey }) {
  const hints = [];
  const tried = tracker?.attempts ?? [];
  if (tried.includes("password")) hints.push("the password may be wrong, or this account is not allowed to log in with a password");
  if (tried.includes("publickey")) hints.push("the private key may not be authorized on the server (missing from authorized_keys), unreadable, or need a passphrase");
  if (tried.includes("agent")) hints.push("none of the keys in the local ssh-agent is authorized for this account (check ssh-add -l on this machine)");
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

  // Local key problems first: they never reach the server, and ssh2 variants
  // that stamp a level on them must not be read as a server-side rejection.
  const keyParse = keyParseDiagnosis(message);
  if (keyParse !== undefined) return keyParse;

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

  if (isServerDisconnect(error)) {
    const name = DISCONNECT_REASON_NAMES[error.code] ?? `reason ${error.code}`;
    const desc = message.trim();
    const hints = [];
    const codeHint = DISCONNECT_CODE_HINTS[error.code];
    if (codeHint) hints.push(codeHint);
    for (const { re, hint } of DISCONNECT_TEXT_HINTS) {
      if (re.test(desc)) hints.push(hint);
    }
    if (hints.length === 0) {
      hints.push("the device closed the connection itself with the reason above; its own log will say what triggered it");
    }
    return {
      stage: CONNECT_FAILURE_STAGES.TRANSPORT,
      reason: "server-disconnect",
      message: `the server disconnected (code ${error.code} ${name})${desc !== "" && desc !== name ? `: ${desc}` : ""}`,
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
