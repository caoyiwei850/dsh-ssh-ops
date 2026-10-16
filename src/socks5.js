/**
 * Minimal SOCKS5 server (RFC 1928) backing the dynamic forwarding tunnel —
 * the `ssh -D` equivalent. Only CONNECT is implemented: each accepted client
 * is piped into a fresh ssh2 forwardOut channel for the address it asked for,
 * so one listener reaches whatever the SSH server can reach. BIND and UDP
 * ASSOCIATE are answered "command not supported" instead of being silently
 * approximated: an SSH channel cannot carry either.
 *
 * Parsing and framing live here as pure functions; attachSocks5() wires them
 * to a socket.
 */

export const SOCKS_REPLY = Object.freeze({
  SUCCEEDED: 0x00,
  GENERAL_FAILURE: 0x01,
  NETWORK_UNREACHABLE: 0x03,
  HOST_UNREACHABLE: 0x04,
  CONNECTION_REFUSED: 0x05,
  COMMAND_NOT_SUPPORTED: 0x07,
  ADDRESS_NOT_SUPPORTED: 0x08
});

/** Map an ssh2 forwardOut error onto the closest SOCKS reply code. */
export function replyCodeForError(error) {
  const message = String(error?.message ?? error ?? "").toLowerCase();
  if (message.includes("refused")) return SOCKS_REPLY.CONNECTION_REFUSED;
  if (message.includes("unreachable") || message.includes("no route")) return SOCKS_REPLY.NETWORK_UNREACHABLE;
  if (message.includes("unknown") || message.includes("not found") || message.includes("enotfound") || message.includes("resolve")) return SOCKS_REPLY.HOST_UNREACHABLE;
  return SOCKS_REPLY.GENERAL_FAILURE;
}

/**
 * Parse the client greeting (VER, NMETHODS, METHODS).
 * @returns `{ ok: true, wantsNoAuth }`, `{ ok: false, reason }`, or null when
 *   more bytes are needed.
 */
export function parseGreeting(bytes) {
  if (bytes.length < 2) return null;
  if (bytes[0] !== 0x05) return { ok: false, reason: `unsupported SOCKS version ${bytes[0]}` };
  const count = bytes[1];
  if (bytes.length < 2 + count) return null;
  const methods = bytes.subarray(2, 2 + count);
  return { ok: true, wantsNoAuth: methods.includes(0x00) };
}

/**
 * Parse a CONNECT request. The address is returned as a string ssh2 accepts:
 * dotted quad, IPv6 text, or the domain name verbatim. `bytes` carries the
 * request frame's on-wire length so the caller can strip it from the buffer
 * (reconstructing the address type from the string form would be ambiguous
 * for domain names like "1.2.3.4").
 * @returns `{ cmd, host, port, bytes }`, `{ ok: false, reason }`, or null for "need more bytes".
 */
export function parseRequest(bytes) {
  if (bytes.length < 4) return null;
  if (bytes[0] !== 0x05) return { ok: false, reason: `unsupported SOCKS version ${bytes[0]}` };
  const cmd = bytes[1];
  const atyp = bytes[3];
  if (cmd !== 0x01) return { cmd, unsupportedCommand: true };
  if (atyp === 0x01) {
    if (bytes.length < 10) return null;
    const host = `${bytes[4]}.${bytes[5]}.${bytes[6]}.${bytes[7]}`;
    return { cmd, host, port: bytes.readUInt16BE(8), bytes: 10 };
  }
  if (atyp === 0x03) {
    if (bytes.length < 5) return null;
    const length = bytes[4];
    if (bytes.length < 5 + length + 2) return null;
    const host = bytes.subarray(5, 5 + length).toString("utf8");
    return { cmd, host, port: bytes.readUInt16BE(5 + length), bytes: 5 + length + 2 };
  }
  if (atyp === 0x04) {
    if (bytes.length < 22) return null;
    const groups = [];
    for (let offset = 4; offset < 20; offset += 2) groups.push(bytes.readUInt16BE(offset).toString(16));
    return { cmd, host: groups.join(":"), port: bytes.readUInt16BE(20), bytes: 22 };
  }
  return { ok: false, reason: `unsupported address type ${atyp}` };
}

/** The 10-byte reply frame; the bound address is always 0.0.0.0:0 (nothing to report). */
export function replyBytes(code) {
  return Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
}

/**
 * Serve one accepted socket: negotiate no-auth, open the requested address
 * through the SSH connection, then pipe both directions. Errors map to SOCKS
 * reply codes so a client sees "connection refused" rather than a hang.
 * @param socket - the accepted net.Socket.
 * @param options - { forwardOut(host, port, cb), onClose?() }.
 * @returns a disposer that stops serving and destroys the socket.
 */
export function attachSocks5(socket, { forwardOut, onClose }) {
  let buffer = Buffer.alloc(0);
  let state = "greeting";
  // The close counting contract: exactly one onClose per served socket. The
  // socket can reach 'close' through several teardowns, so the notification
  // itself must be idempotent — the host's connection counter hangs off it.
  let closeNotified = false;
  const closed = () => {
    if (closeNotified) return;
    closeNotified = true;
    try { onClose?.(); } catch { /* counting must never throw */ }
  };
  const fail = (code) => {
    try { socket.write(replyBytes(code)); } catch {}
    socket.destroy();
  };

  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (state === "greeting") {
        const greeting = parseGreeting(buffer);
        if (greeting === null) return;
        if (greeting.ok === false || !greeting.wantsNoAuth) {
          // No-auth is the only method offered; anything else must be refused
          // explicitly or the client would wait forever.
          try { socket.write(Buffer.from([0x05, 0xff])); } catch {}
          socket.destroy();
          return;
        }
        buffer = buffer.subarray(2 + buffer[1]);
        state = "request";
        socket.write(Buffer.from([0x05, 0x00]));
        continue;
      }
      if (state === "request") {
        const request = parseRequest(buffer);
        if (request === null) return;
        if (request.ok === false) { fail(SOCKS_REPLY.ADDRESS_NOT_SUPPORTED); return; }
        if (request.unsupportedCommand) { fail(SOCKS_REPLY.COMMAND_NOT_SUPPORTED); return; }
        // Cut the consumed request frame off the buffer exactly like the
        // greeting: a client may pipeline its payload in the same segment,
        // and those bytes must survive for the channel flush below.
        buffer = buffer.subarray(request.bytes);
        state = "open";
        forwardOut(request.host, request.port, (error, stream) => {
          if (error || !stream) { fail(replyCodeForError(error)); return; }
          socket.write(replyBytes(SOCKS_REPLY.SUCCEEDED));
          // One flush, then the parser retires: bytes buffered during the
          // short channel-opening window go to the upstream, the data path
          // is handed to pipe(), and onData is removed. Leaving this
          // listener attached would re-buffer every tunnelled byte here —
          // an unbounded per-connection memory leak with O(n²) concat cost.
          socket.removeListener("data", onData);
          if (buffer.length > 0) stream.write(buffer);
          buffer = Buffer.alloc(0);
          stream.on("error", () => socket.destroy());
          socket.on("error", () => stream.destroy());
          socket.on("close", () => stream.destroy());
          socket.pipe(stream);
          stream.pipe(socket);
        });
        return;
      }
      // Channel opening (stream not resolved yet): keep buffering so
      // pipelined payload survives the handshake window; flushed above.
      return;
    }
  };

  socket.on("data", onData);
  socket.on("error", () => socket.destroy());
  socket.on("close", closed);
  socket.on("end", () => socket.destroy());

  return () => {
    socket.removeListener("data", onData);
    socket.destroy();
  };
}
