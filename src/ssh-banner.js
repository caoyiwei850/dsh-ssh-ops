/**
 * SSH identification-string repair.
 *
 * ssh2's parser (lib/protocol/Protocol.js) accepts one narrow spelling of the
 * RFC 4253 banner: `SSH-2.0-` or `SSH-1.99-`, followed by a NON-EMPTY,
 * space-free software token. Every other spelling is reported as the bare
 * "Invalid identification string" — a message that names neither the peer nor
 * the offending line, and which no other SSH client produces. Real gear does
 * stray from the grammar (a device writing `SSH-2.0- OpenSSH` with one stray
 * space, or a non-standard `SSH-2.1-`), and OpenSSH connects to both, because it
 * parses the major version and then negotiates.
 *
 * `withRepairedBanner` re-reads the peer's first line and hands ssh2 a stream
 * with that line normalized. It is only used AFTER ssh2 has already rejected a
 * handshake on the raw stream, so a healthy peer never pays for it and the
 * common connect path keeps ssh2's own socket handling. The software token is
 * preserved verbatim — ssh2 derives its compatibility flags from it — and no
 * version is ever invented: a banner that cannot be used is reported with the
 * peer's own bytes rather than guessed at.
 */
import { Duplex } from "node:stream";

/** The software token ssh2 requires: non-empty, no spaces. */
const SOFTWARE_RE = /^[ \t]*([^ \t]+)(?:[ \t]+(.*))?$/;
const IDENT_RE = /^SSH-(\d+)\.(\d+)-(.*)$/;
// The protocol spellings involved: the two ssh2 accepts, and the one it is told
// to present a 2.x peer as. RFC 4253 fixes the protocol version at "2.0" and
// only the major version is negotiated, so any 2.x peer is addressed as 2.0 —
// which is exactly how OpenSSH treats it.
const PROTOCOL_199 = "1.99";
const PROTOCOL_2 = "2.0";
const CRLF = "\r\n";

/**
 * End offset of the first line beginning with "SSH-" (RFC 4253 allows the peer
 * to send arbitrary greeting lines first). Returns null until a complete one is
 * buffered.
 */
function identLineEnd(buf) {
  let start = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] !== 10) continue;
    const isIdent = i - start >= 4
      && buf[start] === 83 && buf[start + 1] === 83 && buf[start + 2] === 72 && buf[start + 3] === 45;
    if (isIdent) return { start, end: i + 1 };
    start = i + 1;
  }
  return null;
}

/** Assemble one conformant identification line: protocol, software, comments. */
const buildLine = (protocol, software, trailing) => "SSH-" + protocol + "-" + software + trailing;

const malformed = (text) => "对端横幅不规范（原文 " + JSON.stringify(text) + "）";

/**
 * Decide what to do with one identification line. Pure — the whole interop
 * policy lives here, so it can be reasoned about (and tested) without a socket.
 *
 * `keep` means the line is already conformant; `rewrite` means it is usable but
 * misspelled; `reject` means no amount of normalization would produce a peer
 * this client can talk to.
 */
export function planBannerRepair(line) {
  const text = String(line).replace(/[\r\n]+$/, "");
  const match = text.match(IDENT_RE);
  if (match === null) {
    return { action: "reject", reason: "横幅没有 SSH-<协议版本>-<软件版本> 结构" };
  }
  const [, major, minor, rest] = match;
  // Software token first, comments after it. Trailing whitespace and NULs
  // inside the token are junk ssh2 would carry into its compat checks.
  const token = rest.match(SOFTWARE_RE);
  const software = token === null ? "" : token[1].replace(/[\s\0]+$/, "");
  const comments = token === null || token[2] === undefined ? "" : token[2];
  const trailing = comments === "" ? "" : " " + comments;

  if (major === "1" && minor === "99") {
    // 1.99 is the "I speak both" spelling of 2.0, which ssh2 accepts natively,
    // so the only thing that can be wrong here is a missing software token.
    if (software === "") return { action: "reject", reason: "SSH-1.99 之后缺少软件版本" };
    const rebuilt = buildLine(PROTOCOL_199, software, trailing);
    return {
      action: rebuilt === text ? "keep" : "rewrite",
      next: rebuilt + CRLF,
      reason: rebuilt === text ? "" : malformed(text)
    };
  }
  if (major !== "2") {
    // SSH-1 is a different wire protocol, not a spelling variant. Pretending it
    // is 2.0 would only move the failure somewhere more confusing.
    return { action: "reject", reason: "对端只提供 SSH-" + major + "." + minor + "，ssh2 不支持 SSH-1 协议" };
  }
  if (software === "") return { action: "reject", reason: "SSH-2.0 之后缺少软件版本" };

  const rebuilt = buildLine(PROTOCOL_2, software, trailing);
  return {
    action: rebuilt === text ? "keep" : "rewrite",
    next: rebuilt + CRLF,
    reason: rebuilt === text ? "" : malformed(text)
  };
}

/**
 * True when ssh2 failed at the banner — before key exchange, before
 * authentication, and therefore independent of both. This is the only failure a
 * banner repair can act on.
 */
export function isIdentMismatchError(error) {
  return /invalid identification string/i.test(String(error?.message ?? error ?? ""));
}

/** Read up to and including the peer's identification line. */
function readBanner(sock, { timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const settle = (fn, arg) => {
      clearTimeout(timer);
      // Pause before detaching: a stream whose last 'data' listener goes away
      // mid-flow keeps flowing and DISCARDS what it reads. The caller resumes
      // once its own forwarder is attached, so bytes that arrive in the same
      // flush as the banner (the peer's KEXINIT, typically) cannot be lost.
      sock.pause();
      sock.off("data", onData);
      sock.off("error", onError);
      sock.off("close", onClose);
      fn(arg);
    };
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const found = identLineEnd(buf);
      if (found !== null) settle(resolve, { buf, found });
      else if (buf.length > maxBytes) settle(reject, new Error("对端发来的标语过长，读取横幅已放弃"));
    };
    const onError = (error) => settle(reject, error);
    const onClose = () => settle(reject, new Error("读取横幅前连接已被对端关闭"));
    const timer = setTimeout(
      () => settle(reject, new Error("对端没有发送 SSH 横幅（读取超时）")),
      timeoutMs
    );
    sock.on("data", onData);
    sock.on("error", onError);
    sock.on("close", onClose);
  });
}

/**
 * Replay `sock` to ssh2 with the peer's identification line normalized.
 *
 * The bytes already consumed while reading the banner — greeting lines and
 * anything that arrived in the same TCP segment, such as the peer's KEXINIT —
 * are pushed back in order, so the stream ssh2 sees is byte-for-byte the peer's
 * except for that one line.
 */
export async function withRepairedBanner(sock, { timeoutMs = 10000, maxBytes = 8192 } = {}) {
  const { buf, found } = await readBanner(sock, { timeoutMs, maxBytes });
  const banner = buf.subarray(found.start, found.end).toString("latin1");
  const plan = planBannerRepair(banner);
  if (plan.action === "reject") {
    // Nothing will consume this stream, so it must not be left open and paused.
    sock.destroy();
    const error = new Error("对端 SSH 横幅无法使用：" + plan.reason);
    error.banner = banner.replace(/[\r\n]+$/, "");
    throw error;
  }

  const head = Buffer.concat([
    buf.subarray(0, found.start),
    Buffer.from(plan.next, "latin1"),
    buf.subarray(found.end)
  ]);
  const duplex = new Duplex({
    read() { sock.resume(); },
    write(chunk, encoding, callback) { sock.write(chunk, encoding, callback); },
    final(callback) { sock.end(callback); },
    destroy(error, callback) { sock.destroy(); callback(error); },
    // ssh2 calls this on its transport behind a typeof guard; forwarding it
    // keeps TCP_NODELAY working even though ssh2 no longer owns the socket.
    setNoDelay(noDelay) { if (typeof sock.setNoDelay === "function") sock.setNoDelay(noDelay); }
  });
  // ssh2 attaches no error listener to an injected socket, and an 'error'
  // emission with no listener takes the whole DSH process down. A failure still
  // reaches the caller through ssh2's own protocol/close handling.
  duplex.on("error", () => {});
  sock.on("data", (chunk) => { if (!duplex.push(chunk)) sock.pause(); });
  sock.on("error", (error) => duplex.destroy(error));
  sock.on("end", () => duplex.push(null));
  sock.on("close", () => { if (!duplex.writableEnded) duplex.destroy(); });
  duplex.push(head);
  // Only now, with the forwarder attached, may the upstream flow again.
  sock.resume();
  return { stream: duplex, plan, banner: banner.replace(/[\r\n]+$/, "") };
}
