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
 *   - sftp  -> a sandboxed SFTP subsystem over one root directory (see
 *              test-sftp-server.mjs), seeded with sample files so the file
 *              manager, editor, export and download paths can run for real.
 *   - direct-tcpip -> forwards an accepted channel to its requested target, so
 *              local forwards and the dynamic SOCKS5 tunnel work offline.
 */
import ssh2 from "ssh2";
import { generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import net from "node:net";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { attachSftp } from "./test-sftp-server.mjs";
import { fileURLToPath } from "node:url";

const { Server } = ssh2;

const PORT = Number(process.argv[2] ?? 2222);
const PASSWORD = "test123";
const IS_WINDOWS = process.platform === "win32";
const SHELL = IS_WINDOWS ? "cmd.exe" : "/bin/sh";

/**
 * SFTP sandbox: one directory this server exposes, seeded with the shapes the
 * plugin's file panel has to handle — text, a subdirectory, a "binary" file
 * and an empty file.
 */
const SFTP_ROOT = process.argv.includes("--sftp-root")
  ? resolve(process.argv[process.argv.indexOf("--sftp-root") + 1])
  : join(os.tmpdir(), `dsh-sshd-sandbox-${PORT}`);
if (process.argv.includes("--reset-sftp-root")) {
  rmSync(SFTP_ROOT, { recursive: true, force: true });
}
mkdirSync(join(SFTP_ROOT, "config"), { recursive: true });
const seed = (relative, content) => {
  const target = join(SFTP_ROOT, relative);
  if (existsSync(target)) return;
  writeFileSync(target, content);
};
seed("welcome.txt", "hello from test-sshd\n");
seed("config/nginx.conf", "server {\n  listen 80;\n  server_name test-sshd.local;\n}\n");
seed("empty.txt", "");
seed("binary.bin", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02, 0x03]));

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

function runShell(stream, args, { onExit, interactive = false } = {}) {
  const child = spawn(SHELL, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    // An interactive shell needs its own prompt: without it there is nothing
    // for the panel (or shell integration) to key on.
    env: IS_WINDOWS
      ? process.env
      : { ...process.env, PS1: "dsh-test$ ", PS2: "> ", TERM: "xterm-256color", ...(interactive ? {} : { PS1: "" }) }
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

  // direct-tcpip channels: what the plugin's local and dynamic (SOCKS5) tunnels
  // open through this server. Without this the channel request is rejected and
  // every forward fails — which is exactly the state an offline tunnel test
  // must not be stuck in.
  client.on("tcpip", (accept, reject, info) => {
    let channel;
    try { channel = accept(); } catch { try { reject?.(); } catch {} return; }
    channel.on("error", () => {});
    const target = net.connect(info.destPort, info.destIP === "0.0.0.0" ? "127.0.0.1" : info.destIP);
    target.on("connect", () => {
      target.on("error", () => channel.destroy());
      channel.on("error", () => target.destroy());
      channel.pipe(target);
      target.pipe(channel);
    });
    target.on("error", () => { try { channel.close(); } catch {} });
  });

  client.on("ready", () => {
    client.on("session", (accept) => {
      const session = accept();
      let term = "xterm-256color";
      let cols = 100;
      let rows = 30;
      let ptyRequested = false;

      session.on("pty", (acceptPty, rejectPty, info) => {
        if (!info?.term) { try { rejectPty?.(); } catch {} return; }
        ptyRequested = true;
        term = info.term ?? term;
        cols = info.cols ?? cols;
        rows = info.rows ?? rows;
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
        // accept LF. `ptyRequested` marks the panel's terminals: those get a
        // real interactive shell so a prompt (and shell integration, which
        // rides the prompt) actually happens. exec channels and pty-less
        // shells stay non-interactive, exactly like a real server.
        const args = IS_WINDOWS ? ["/Q"] : (ptyRequested ? ["-i"] : []);
        runShell(stream, args, {
          interactive: ptyRequested,
          onExit: (code) => { if (!stream.destroyed) { try { stream.exit(code ?? 0); } catch {} } }
        });
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

      session.on("sftp", (acceptSftp, rejectSftp) => {
        let sftp;
        try { sftp = acceptSftp(); } catch { try { rejectSftp?.(); } catch {} return; }
        sftp.on("error", () => {});
        attachSftp(sftp, { root: SFTP_ROOT });
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
  console.log(`[test-sshd] sftp sandbox: ${SFTP_ROOT}`);
});
