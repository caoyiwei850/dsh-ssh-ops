/**
 * Local SSH test server for dsh-ssh-ops.
 *
 * Spins up a password-authenticated ssh2 Server on 127.0.0.1 so the plugin can
 * be exercised against a real SSH transport without a remote host. Run several
 * instances on different ports to simulate multiple servers for the multi-tab
 * feature.
 *
 *   node test-sshd.mjs            # port 2222
 *   node test-sshd.mjs 2223       # port 2223
 *
 * Credentials: any username / password "test123".
 *
 * Channels:
 *   - exec  -> runs the command through the platform shell and streams stdout/stderr
 *              with a real exit code (exercises ssh_exec).
 *   - shell -> runs an interactive platform shell and pipes stdin/stdout
 *              to it (exercises the terminal + ssh_write Enter).
 */
import ssh2 from "ssh2";
import { generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { Server } = ssh2;

const PORT = Number(process.argv[2] ?? 2222);
const PASSWORD = "test123";
const IS_WINDOWS = process.platform === "win32";
const SHELL = IS_WINDOWS ? "cmd.exe" : "/bin/sh";

// Persist the host key so restarts keep the same fingerprint (a real sshd keeps
// a fixed host key; regenerating one each run would trip the plugin's TOFU host
// key check on every restart).
const HOST_KEY_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "test-sshd-hostkey.pem");
let hostKey;
if (existsSync(HOST_KEY_PATH)) {
  hostKey = readFileSync(HOST_KEY_PATH, "utf8");
} else {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  // ssh2 wants the host key as a PEM string, not a KeyObject.
  hostKey = privateKey.export({ type: "pkcs1", format: "pem" });
  writeFileSync(HOST_KEY_PATH, hostKey, "utf8");
}

function runShell(stream, args, { onExit } = {}) {
  const child = spawn(SHELL, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: IS_WINDOWS ? process.env : { ...process.env, PS1: "dsh-test$ " }
  });
  child.stdout.on("data", (d) => { if (!stream.destroyed) stream.write(d); });
  child.stderr.on("data", (d) => { if (!stream.destroyed) stream.stderr.write(d); });
  stream.on("data", (d) => {
    if (!child.stdin.writable) return;
    // The terminal's Enter key is a carriage return (CR). Linux's line
    // discipline (icrnl) turns that CR into a line terminator; Windows cmd.exe
    // is CRLF-oriented and would otherwise ignore a lone CR. Expand CR/LF to
    // CRLF so the local Windows test server behaves like a Linux shell.
    const normalized = IS_WINDOWS
      ? d.toString("utf8").replace(/\r\n?|\n/g, "\r\n")
      : d.toString("utf8").replace(/\r\n?/g, "\n");
    // Simulate a real PTY's ECHO: pipe the typed line back to the client so the
    // command text is visible, exactly as a Linux terminal echoes keystrokes.
    if (!stream.destroyed) stream.write(normalized);
    child.stdin.write(normalized);
  });
  stream.on("close", () => { try { child.kill(); } catch {} });
  child.on("error", () => { try { stream.close(); } catch {} });
  child.on("close", (code) => {
    onExit?.(code);
    try { stream.exit(code ?? 0); stream.end(); } catch {}
  });
  return child;
}

const server = new Server({ hostKeys: [hostKey] }, (client) => {
  // A client that disconnects abruptly emits an 'error' (ECONNRESET); without
  // a handler that crashes the whole server.
  client.on("error", () => {});

  client.on("authentication", (ctx) => {
    if (ctx.method === "password" && ctx.password === PASSWORD) {
      ctx.accept();
    } else if (ctx.method === "none") {
      ctx.reject(["password"]);
    } else {
      ctx.reject();
    }
  });

  client.on("ready", () => {
    client.on("session", (accept) => {
      const session = accept();
      let term = "xterm-256color";
      let cols = 100;
      let rows = 30;

      session.on("pty", (acceptPty, _reject, info) => {
        term = info?.term ?? term;
        cols = info?.cols ?? cols;
        rows = info?.rows ?? rows;
        acceptPty?.();
      });

      session.on("window-change", (acceptChange, _reject, info) => {
        cols = info?.cols ?? cols;
        rows = info?.rows ?? rows;
        acceptChange?.();
      });

      session.on("shell", (acceptShell) => {
        const stream = acceptShell();
        stream.on("error", () => {});
        // Interactive shell. Windows cmd.exe needs CRLF input; POSIX shells
        // accept LF. runShell normalizes terminal Enter for each platform.
        const args = IS_WINDOWS ? ["/Q"] : [];
        runShell(stream, args, { onExit: (code) => { if (!stream.destroyed) { try { stream.exit(code ?? 0); } catch {} } } });
      });

      session.on("exec", (acceptExec, _reject, info) => {
        const stream = acceptExec();
        stream.on("error", () => {});
        const command = typeof info.command === "string" ? info.command : "";
        const args = IS_WINDOWS ? ["/Q", "/C", command] : ["-c", command];
        runShell(stream, args, {
          onExit: (code) => { if (!stream.destroyed) { try { stream.exit(code ?? 0); } catch {} } }
        });
      });

      session.on("env", (acceptEnv) => acceptEnv?.());
      session.on("signal", (acceptSignal) => acceptSignal?.());
      session.on("close", () => {});
    });
  });
});

server.on("error", (err) => {
  console.error("[test-sshd] server error:", err.message);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[test-sshd] listening on 127.0.0.1:${PORT} (user: any / password: ${PASSWORD})`);
});
