// SSH banner repair: peers that write a non-conformant identification string.
//
// ssh2's parser (lib/protocol/Protocol.js) accepts ONLY `SSH-2.0-` / `SSH-1.99-`
// followed by a non-empty, space-free software token, and reports anything else
// as the bare "Invalid identification string" — wording that names neither the
// peer nor the offending line. OpenSSH connects to several banners ssh2 refuses
// (e.g. `SSH-2.0- OpenSSH_9.6`, one stray space).
//
// Loop: node --test test/ssh-banner.mjs
//
// The end-to-end cases put a real ssh2 Server behind a proxy that corrupts its
// banner, so the repair is exercised through the actual production connect path
// and the repaired transport must carry a real shell session afterwards. A
// stubbed Client could not show that the spliced stream loses no bytes.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { Duplex } from "node:stream";
import ssh2 from "ssh2";
import { generateKeyPairSync } from "node:crypto";
import SshOpsService from "../src/index.js";
import { planBannerRepair, isIdentMismatchError } from "../src/ssh-banner.js";

const { Server, Client } = ssh2;
const SHELL_MARKER = "REPAIRED-SHELL-OK";

// ── 1. the repair decision is a pure function ──────────────────────────────

test("planBannerRepair: rewrites only banners that are usable but malformed", () => {
  const cases = [
    // [banner line, expected action]
    ["SSH-2.0-OpenSSH_9.6\r\n", "keep"],
    ["SSH-1.99-OpenSSH_9.6\r\n", "keep"],
    ["SSH-2.0-OpenSSH_9.6 trailing comment\r\n", "keep"],
    // A stray space where the space-free software token must start: OpenSSH
    // accepts this, ssh2 does not.
    ["SSH-2.0- OpenSSH_9.6\r\n", "rewrite"],
    // Any major version 2 parses for OpenSSH (only the major is negotiated).
    ["SSH-2.1-OpenSSH_9.6\r\n", "rewrite"],
    // Trailing junk inside the software token: ssh2 swallows the NUL, OpenSSH
    // rejects the line outright.
    ["SSH-2.0-OpenSSH_9.6\u0000\r\n", "rewrite"],
    // Nothing to salvage — these must fail with a real explanation instead.
    ["SSH-1.5-OpenSSH_3.9p1\r\n", "reject"],
    ["SSH-2.0-\r\n", "reject"],
    ["SSH-2.0\r\n", "reject"],
    ["not an ssh banner\r\n", "reject"]
  ];
  for (const [line, action] of cases) {
    assert.equal(planBannerRepair(line).action, action, `banner ${JSON.stringify(line)}`);
  }
});

test("planBannerRepair: a rewrite preserves the software version verbatim", () => {
  const plan = planBannerRepair("SSH-2.0- OpenSSH_9.6\r\n");
  // Compatibility flags are derived from the software token, so the repair must
  // not touch it — only the malformed protocol field and the stray whitespace.
  assert.equal(plan.next, "SSH-2.0-OpenSSH_9.6\r\n");
});

test("planBannerRepair: rejects name the reason, not just the failure", () => {
  assert.match(planBannerRepair("SSH-1.5-OpenSSH_3.9p1\r\n").reason, /SSH-1\.5/);
  assert.match(planBannerRepair("SSH-2.0-\r\n").reason, /软件版本/);
});

test("isIdentMismatchError: only ssh2's banner rejection, not a generic failure", () => {
  assert.equal(isIdentMismatchError(new Error("Invalid identification string")), true);
  assert.equal(isIdentMismatchError(new Error("no matching key exchange algorithm")), false);
  assert.equal(isIdentMismatchError(new Error("Connection lost before handshake")), false);
  assert.equal(isIdentMismatchError(undefined), false);
});

// ── fixtures ───────────────────────────────────────────────────────────────

/** A real ssh2 server that offers a shell and prints SHELL_MARKER on it. */
function startSshServer() {
  return new Promise((resolve, reject) => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const hostKey = privateKey.export({ type: "pkcs1", format: "pem" });
    const server = new Server({ hostKeys: [hostKey] }, (client) => {
      client.on("error", () => {});
      client.on("authentication", (authCtx) => {
        if (authCtx.method === "password" && authCtx.password === "test123") authCtx.accept();
        else authCtx.reject(["password"]);
      });
      client.on("ready", () => {
        client.on("session", (accept) => {
          const session = accept();
          session.on("pty", (acceptPty) => acceptPty && acceptPty());
          session.on("shell", (acceptShell) => {
            const stream = acceptShell();
            stream.write(`${SHELL_MARKER}\r\n`);
            stream.on("data", () => {});
          });
        });
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      port: server.address().port,
      // Closing the listener is the whole job: every test disconnects its
      // connections first (makeService registers that as teardown), so close()
      // has nothing to wait for. ssh2's Server emits an ssh2 Client — not a
      // socket — on 'connection', and that object has no destroy(), so tracking
      // those and calling destroy() would throw and skip this close entirely.
      destroy: () => server.close()
    }));
  });
}

/** Find the end of the first line beginning with "SSH-". */
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

/**
 * A TCP proxy that rewrites the server's identification line on the way to the
 * client — the only way to make a real ssh2 Server present a malformed banner.
 * `attempts` counts how many times the plugin actually opened a transport, so a
 * test can prove a fatal banner does not send it into a retry loop.
 */
function startCorruptingProxy(targetPort, corrupt, { greeting = "" } = {}) {
  return new Promise((resolve, reject) => {
    const state = { attempts: 0 };
    const upstreams = new Set();
    const downstreams = new Set();
    const server = net.createServer((down) => {
      state.attempts += 1;
      down.on("error", () => {});
      downstreams.add(down);
      down.on("close", () => downstreams.delete(down));
      const up = net.connect(targetPort, "127.0.0.1");
      upstreams.add(up);
      up.on("error", () => {});
      let buf = Buffer.alloc(0);
      let patched = false;
      const onData = (data) => {
        if (patched) { down.write(data); return; }
        buf = Buffer.concat([buf, data]);
        const found = identLineEnd(buf);
        if (found === null) return;
        patched = true;
        up.off("data", onData);
        const line = buf.subarray(found.start, found.end).toString("latin1").replace(/[\r\n]+$/, "");
        const bad = corrupt(line);
        down.write(Buffer.concat([
          buf.subarray(0, found.start),
          Buffer.from(greeting + bad + "\r\n", "latin1"),
          buf.subarray(found.end)
        ]));
        // Pipe rather than forwarding chunks by hand: a half-closed connection
        // that never propagates its FIN keeps both sides' sockets — and the
        // test runner's event loop — alive forever.
        up.pipe(down);
      };
      up.on("data", onData);
      down.pipe(up);
      // pipe() propagates a clean end but not a destroy, and either side can be
      // reset abruptly; tie the two lifetimes together so nothing stays open.
      down.on("close", () => up.destroy());
      up.on("close", () => down.destroy());
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      state,
      port: server.address().port,
      destroy: () => {
        // Neither close() nor pipe() propagates an abrupt destroy, so a socket
        // left half-open here keeps the peer's server handle — and the test
        // runner's event loop — alive.
        for (const u of upstreams) u.destroy();
        for (const d of downstreams) d.destroy();
        server.close();
      }
    }));
  });
}

const closeSrv = (srv) => new Promise((r) => { try { srv.destroy(); } catch {} setImmediate(r); });

/** Bare service instance: no storage or ctx wiring needed for a connect. */
function makeService(t) {
  const service = Object.create(SshOpsService.prototype);
  service.config = {};
  service.connections = new Map();
  service.sessions = new Map();
  service.exitedSessions = new Map();
  service.pendingConfirmations = new Map();
  service.activeConnectionId = null;
  service.ctx = { logger: { warn: () => {}, info: () => {}, debug: () => {} } };
  // Tested against null (`!== null`), so null — not undefined — disables TOFU.
  service.knownHosts = null;
  // A live connection holds a transport; if an assertion fails before the test's
  // own disconnect runs, the leaked socket would keep the runner alive. Tear
  // down whatever is left, whatever the outcome.
  if (t !== undefined) {
    t.after(async () => {
      for (const id of [...service.connections.keys()]) {
        await service.disconnect({ connectionId: id }).catch(() => {});
      }
    });
  }
  return service;
}

const creds = { host: "127.0.0.1", username: "admin", auth: { kind: "password", password: "test123" } };

/** Prove the repaired transport really carries traffic, not merely a handshake. */
async function readShellMarker(service, connectionId) {
  const opened = await service.openSession({ connectionId, cols: 80, rows: 24 });
  assert.equal(opened.ok, true, `the repaired transport must open a shell: ${opened.error?.message ?? ""}`);
  const read = await service.read({ sessionId: opened.value.sessionId, timeoutMs: 3000 });
  assert.equal(read.ok, true, JSON.stringify(read));
  const text = read.value.data ? Buffer.from(read.value.data, "base64").toString("utf8") : "";
  await service.closeSession({ sessionId: opened.value.sessionId }).catch(() => {});
  return text;
}

/** The stray-space banner: OpenSSH connects to this, ssh2 refuses it. */
const straySpace = (line) => line.replace(/^(SSH-2\.0)-/, "$1- ");

/**
 * What ssh2 alone makes of the proxy's banner — the reported dead end. This has
 * to be a bare Client rather than a service connect, because the service is
 * itself the repair.
 */
function rawConnectFailure(port) {
  return new Promise((resolve) => {
    const client = new Client();
    let settled = false;
    const finish = (message) => {
      if (settled) return;
      settled = true;
      try { client.end(); } catch {}
      resolve(message);
    };
    client.on("error", (error) => finish(error.message));
    client.on("close", () => finish("closed without an error"));
    client.connect({
      host: "127.0.0.1", port, username: "probe", password: "probe",
      readyTimeout: 4000, hostVerifier: () => true
    });
    setTimeout(() => finish("timed out"), 8000).unref();
  });
}

// ── 2. the reported failure, end to end ───────────────────────────────────

test("stray-space banner: ssh2 alone dies on it, the service repairs and connects", async (t) => {
  const sshd = await startSshServer();
  const proxy = await startCorruptingProxy(sshd.port, straySpace);
  t.after(async () => { await closeSrv(proxy); await closeSrv(sshd); });

  // Baseline: ssh2 by itself reads this banner as fatal, which is exactly the
  // reported dead end. (It must be a bare client — the service is the repair.)
  const failure = await rawConnectFailure(proxy.port);
  assert.match(failure, /Invalid identification string/,
    `a plain ssh2 handshake must be the thing that fails here, got: ${failure}`);

  // Now the production path: it must recover, say so, and carry a real session.
  const service = makeService(t);
  const result = await service.connect({ ...creds, port: proxy.port, retries: 0 });
  assert.equal(result.ok, true, `banner repair must connect: ${result.error?.message ?? ""}`);
  assert.equal(result.value.bannerRepair, true, "the caller is told the banner was rewritten");
  assert.match(result.value.warning ?? "", /横幅/, "the user gets a visible warning");

  assert.match(await readShellMarker(service, result.value.connectionId), new RegExp(SHELL_MARKER),
    "the repaired stream carries a full shell session, so no bytes were lost");

  await service.disconnect({ connectionId: result.value.connectionId });
});

test("protocol 2.1 banner: repaired like any other non-2.0 spelling", async (t) => {
  const sshd = await startSshServer();
  const proxy = await startCorruptingProxy(sshd.port, (line) => line.replace(/^SSH-2\.0-/, "SSH-2.1-"));
  t.after(async () => { await closeSrv(proxy); await closeSrv(sshd); });

  const service = makeService(t);
  const result = await service.connect({ ...creds, port: proxy.port, retries: 0 });
  assert.equal(result.ok, true, result.error?.message ?? "");
  assert.equal(result.value.bannerRepair, true);
  assert.match(await readShellMarker(service, result.value.connectionId), new RegExp(SHELL_MARKER));
  await service.disconnect({ connectionId: result.value.connectionId });
});

test("a greeting line before the banner survives the repair", async (t) => {
  const sshd = await startSshServer();
  const proxy = await startCorruptingProxy(sshd.port, straySpace, { greeting: "device says hello\r\n" });
  t.after(async () => { await closeSrv(proxy); await closeSrv(sshd); });

  const service = makeService(t);
  const result = await service.connect({ ...creds, port: proxy.port, retries: 0 });
  assert.equal(result.ok, true, `greeting bytes must be replayed in order: ${result.error?.message ?? ""}`);
  assert.match(await readShellMarker(service, result.value.connectionId), new RegExp(SHELL_MARKER));
  await service.disconnect({ connectionId: result.value.connectionId });
});

// ── 3. unrepairable banners: a clear error, and no retry loop ─────────────

test("SSH-1 banner: fails with the peer's own line named, and does not loop", async (t) => {
  const sshd = await startSshServer();
  const proxy = await startCorruptingProxy(sshd.port, () => "SSH-1.5-OpenSSH_3.9p1");
  t.after(async () => { await closeSrv(proxy); await closeSrv(sshd); });

  const service = makeService(t);
  const result = await service.connect({ ...creds, port: proxy.port, retries: 0 });
  assert.equal(result.ok, false, "an SSH-1 peer is not something ssh2 can speak to");
  // The whole point: the error must identify the culprit instead of repeating
  // ssh2's "Invalid identification string".
  assert.match(result.error.message, /SSH-1\.5/);
  assert.match(result.error.message, /SSH-1|横幅/);
  assert.ok(proxy.state.attempts <= 2, `one repair attempt at most, saw ${proxy.state.attempts}`);
});

test("empty software version: fails with a named reason instead of ssh2's wording", async (t) => {
  const sshd = await startSshServer();
  const proxy = await startCorruptingProxy(sshd.port, () => "SSH-2.0-");
  t.after(async () => { await closeSrv(proxy); await closeSrv(sshd); });

  const service = makeService(t);
  const result = await service.connect({ ...creds, port: proxy.port, retries: 0 });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /软件版本/);
  assert.doesNotMatch(result.error.message, /Invalid identification string/);
});

// ── 4. the repair must never fire on a healthy peer ───────────────────────

test("withRepairedBanner: splices any duplex, which is what a jump hop gives us", async () => {
  // A jump chain hands the plugin a forwarded channel rather than a TCP socket,
  // so the splice must not assume net.Socket. Bytes that arrived in the same
  // chunk as the banner (here a stand-in for the peer's KEXINIT) must still be
  // replayed, in order, after the rewritten line.
  const written = [];
  const upstream = new Duplex({
    read() {},
    write(chunk, encoding, callback) { written.push(chunk); callback(); }
  });
  upstream.push("SSH-2.0- OpenSSH_9.6\r\n");
  upstream.push("AFTER-BANNER\r\n");

  const service = makeService();
  const record = { connectConfig: { readyTimeout: 5000 } };
  const stream = await service.openRepairedSock(record, upstream);
  const seen = [];
  stream.on("data", (chunk) => seen.push(chunk));
  stream.write(Buffer.from("CLIENT-BYTES"));
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(Buffer.concat(seen).toString(), "SSH-2.0-OpenSSH_9.6\r\nAFTER-BANNER\r\n");
  assert.equal(Buffer.concat(written).toString(), "CLIENT-BYTES", "writes reach the forwarded stream");
  assert.match(record.bannerRepairNote ?? "", /不规范/, "the record explains what was rewritten");

  stream.destroy();
  upstream.destroy();
});

test("a well-formed server is connected without any banner handling", async (t) => {
  const sshd = await startSshServer();
  t.after(() => closeSrv(sshd));

  const service = makeService(t);
  const result = await service.connect({ ...creds, port: sshd.port, retries: 0 });
  assert.equal(result.ok, true, result.error?.message ?? "");
  assert.equal(result.value.bannerRepair ?? false, false, "no repair flag on a normal handshake");
  assert.equal(result.value.warning, undefined, "and nothing to warn about");
  assert.match(await readShellMarker(service, result.value.connectionId), new RegExp(SHELL_MARKER));
  await service.disconnect({ connectionId: result.value.connectionId });
});
