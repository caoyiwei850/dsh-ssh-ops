/**
 * Agent tools for the SSH session lifecycle: list, connect, exec, read,
 * write, disconnect. All of them drive the same connections/sessions the
 * right-side panel shows; `service` is the SshOpsService instance.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { t } from "../i18n/core.js";

export function registerSshSessionTools(ctx, service) {
  ctx.tools.register(defineTool({
    name: "ssh_shell_integration",
    description: "Enable shell integration (OSC 133 markers) in an open SSH terminal's bash/zsh shell. Afterwards ssh_terminal_context reports the shell's current directory, the last command's exit code and whether it sits at a prompt — far more reliable than guessing from output text. Requires an idle, single interactive shell; the session must be one from ssh_terminal_sessions.",
    parameters: { session_id: { type: "string", required: true, description: "Session id from ssh_terminal_sessions." } },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { sessionId: { type: "string", required: true }, enabled: { type: "boolean", required: true } } },
      render(_args, value) {
        return [{ type: "text", text: value.enabled ? t(`Shell integration is enabled in session ${value.sessionId}; from now on ssh_terminal_context reports cwd, exit code and prompt state.`) : t("Enabling failed.") }];
      }
    },
    async execute(args) {
      const result = await service.enableShellIntegration({ sessionId: args.session_id });
      if (!result.ok) throw new Error(`ssh_shell_integration failed: ${result.error.message}`);
      return result.value;
    }
  }));

  ctx.tools.register(defineTool({
    name: "ssh_terminal_sessions",
    description: "List open SSH terminal sessions so you can identify a terminal the user operated manually. Returns metadata and history cursors only; never returns terminal output, saved resources, or credentials.",
    parameters: {},
    output: { schema: { type: "object", additionalProperties: false, properties: { sessions: { type: "array", required: true, items: { type: "object", additionalProperties: true } } } } },
    async execute() { const result = service.listTerminalContexts(); if (!result.ok) throw new Error(`ssh_terminal_sessions failed: ${result.error.message}`); return result.value; }
  }));

  ctx.tools.register(defineTool({
    name: "ssh_terminal_context",
    description: "Read a bounded, redacted range from a user-operated SSH terminal after approval. Use ssh_terminal_sessions first to select a session. This does not consume or alter the visible terminal history.",
    parameters: { session_id: { type: "string", required: true }, after: { type: "integer", description: "Optional cursor from a previous read." }, max_bytes: { type: "integer", description: "1024..98304 bytes; defaults to 24576." } },
    output: { schema: { type: "object", additionalProperties: true } },
    async execute(args) { const result = service.readTerminalContext({ sessionId: args.session_id, after: args.after, maxBytes: args.max_bytes }); if (!result.ok) throw new Error(`ssh_terminal_context failed: ${result.error.message}`); return result.value; }
  }));

  if (typeof ctx.on === "function") ctx.on("tools/pre-execute", (execution, next) => {
    if (execution?.name !== "ssh_terminal_context") return typeof next === "function" ? next() : undefined;
    return { kind: "ask", reason: "Agent requests recent manual SSH terminal activity, which may contain sensitive output." };
  });

  ctx.tools.register(defineTool({
    name: "ssh_list",
    description: t("List currently open SSH connections and identify the active server. This reports only live connection metadata (name, host, port, username and active state); it never returns credentials. When the operator enabled “Allow the AI to connect saved servers automatically” in the SSH settings, the result also lists the operator's saved SSH resources (name, host, username, whether already connected) — connect one with ssh_connect_profile. Use this tool when the user asks which server is connected or which saved servers exist; for normal server work, ssh_exec/ssh_read/ssh_write already target the active connection automatically."),
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          activeConnectionId: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
          connections: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                connectionId: { type: "string", required: true },
                name: { type: "string" },
                host: { type: "string", required: true },
                port: { type: "integer", required: true },
                username: { type: "string", required: true },
                connected: { type: "boolean", required: true },
                sessions: { type: "array", required: true, items: { type: "string" } },
                agentSession: { type: "boolean" },
                agentRevealId: { type: "string" }
              }
            }
          },
          resources: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                profileId: { type: "string", required: true },
                name: { type: "string", required: true },
                host: { type: "string", required: true },
                port: { type: "integer", required: true },
                username: { type: "string", required: true },
                connected: { type: "boolean", required: true }
              }
            }
          }
        }
      },
      render(_args, value) {
        const lines = [];
        if (value.connections.length === 0) lines.push("No SSH connection is currently open.");
        else lines.push(...value.connections.map((connection) => `${connection.connectionId === value.activeConnectionId ? "* " : "- "}${connection.name ?? connection.host}: ${connection.username}@${connection.host}:${connection.port}${connection.sessions.length ? " (terminal open)" : ""}`));
        if (value.resources !== undefined) {
          lines.push("");
          lines.push(value.resources.length === 0
            ? t("Saved SSH resources: none saved yet — the operator can add servers in Settings → SSH Resources.")
            : `Saved SSH resources (connectable via ssh_connect_profile): ${value.resources.map((resource) => `${resource.name} → ${resource.username}@${resource.host}:${resource.port}${resource.connected ? " [connected]" : ""}`).join("; ")}`);
        }
        return [{ type: "text", text: lines.join("\n") }];
      }
    },
    async execute() {
      const result = await service.list();
      if (!result.ok) throw new Error(`ssh_list failed: ${result.error.message}`);
      return result.value;
    }
  }));

  ctx.tools.register(defineTool({
    name: "ssh_connect",
    description: t("Connect to a remote server over SSH, open it in the right-side terminal, and make it the current connection for later SSH tools. Subsequent ssh_exec, ssh_read, ssh_write, and ssh_disconnect calls automatically use this connection unless a connection_id is explicitly supplied."),
    parameters: {
      host: { type: "string", required: true, description: "Remote hostname or IP address." },
      port: { type: "integer", description: "SSH port, defaults to 22." },
      username: { type: "string", required: true, description: "SSH username." },
      auth: {
        type: "object",
        required: true,
        additionalProperties: false,
        description: t("Authentication. Either {kind: 'password', password} or {kind: 'key', privateKey, passphrase?}."),
        properties: {
          kind: { type: "string", enum: ["password", "key"], required: true },
          password: { type: "string" },
          privateKey: { type: "string" },
          passphrase: { type: "string" }
        }
      },
      legacy: { type: "boolean", description: "Only for old network devices (Huawei legacy VRP e.g. S12712, some old IOS/Comware) that offer no modern SSH key exchange. Omit it and the plugin retries automatically once if the handshake fails on key-exchange selection, returning legacyFallback. Pass true to use the legacy algorithm set immediately, or false to forbid the automatic retry." },
      name: { type: "string", description: "Optional display name for this connection." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          connectionId: { type: "string", required: true },
          name: { type: "string" },
          host: { type: "string", required: true },
          port: { type: "integer", required: true },
          username: { type: "string", required: true },
          legacyFallback: { type: "boolean" },
          bannerRepair: { type: "boolean" },
          warning: { type: "string" }
        }
      },
      render(args, value) {
        const conn = value ?? {};
        const base = `Connected ${args.username}@${args.host} (id: ${conn.connectionId ?? "?"})`;
        // Anything unusual about the handshake must be visible in the tool
        // result, not only in the host log — a weakened transport or a rewritten
        // banner is something the operator has to know about to act on it.
        return [{ type: "text", text: conn.warning ? `${base}\n⚠️ ${conn.warning}` : base }];
      }
    },
    async execute(args) {
      const result = await service.connect({
        host: args.host,
        port: args.port,
        username: args.username,
        auth: args.auth,
        legacy: args.legacy,
        name: args.name
      });
      if (!result.ok) throw new Error(`ssh_connect failed: ${result.error.message}`);
      return result.value;
    }
  }));

  ctx.tools.register(defineTool({
    name: "ssh_connect_profile",
    description: t("Connect to one of the operator's saved SSH resources (Settings → SSH Resources) by name and make it the active connection: later ssh_exec/ssh_read/ssh_write without connection_id target it, and its terminal opens in the right-side panel so the operator can see which machine you are on. Only works when the operator enabled “Allow the AI to connect saved servers automatically”; with the switch off the call fails — then ask the operator to connect the server, and NEVER fall back to ssh_connect with credentials you gathered from conversation. Reuses an already-open connection for the same resource instead of connecting twice."),
    parameters: {
      resource: { type: "string", required: true, description: "The saved resource's name as shown by ssh_list (e.g. 'dev', 'prod'), or its profile id. A unique partial name is accepted; unknown or ambiguous names fail with the list of available resources." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          connectionId: { type: "string", required: true },
          profileId: { type: "string", required: true },
          name: { type: "string", required: true },
          host: { type: "string", required: true },
          port: { type: "integer", required: true },
          username: { type: "string", required: true },
          reused: { type: "boolean", required: true },
          terminalOpened: { type: "boolean", required: true },
          warning: { type: "string" }
        }
      },
      render(_args, value) {
        const base = t(`Connected to the saved server “${value.name}” (${value.username}@${value.host}:${value.port}, id: ${value.connectionId}) and made it the active SSH connection, so ssh_exec and similar tools act on this machine by default.${value.reused ? t(" Reused the server's existing connection.") : ""}${value.terminalOpened ? t(" A terminal session was opened for it (see the machine in the SSH panel on the right).") : ""}`);
        return [{ type: "text", text: value.warning ? `${base}\n⚠️ ${value.warning}` : base }];
      }
    },
    async execute(args) {
      const result = await service.agentConnectProfile({ resource: args.resource });
      if (!result.ok) throw new Error(`ssh_connect_profile failed: ${result.error.message}`);
      return result.value;
    }
  }));

  ctx.tools.register(defineTool({
    name: "ssh_exec",
    description: t("Run a normal SSH command on the server currently open in the right-side SSH terminal and return its output. Omit connection_id when the user means the current server; do not call ssh_list first. On Linux with one identifiable idle POSIX terminal shell, the dedicated exec channel starts in that shell's verified current directory. A busy, ambiguous, or inaccessible terminal directory rejects the command instead of guessing; when no terminal shell is detectable, the normal login directory is used and cwd is null. SSH configuration, package changes, service reloads, and config edits are allowed and remain subject to DSH permissions. Explicitly destructive or irreversible operations are not run: a confirmation popup appears in the right-side SSH panel, where only the operator can execute or cancel them. The command and output are also shown in the terminal panel."),
    parameters: {
      connection_id: { type: "string", description: "Optional. Omit to target the current right-side SSH connection." },
      command: { type: "string", required: true, description: "The shell command to execute." },
      timeout_ms: { type: "integer", description: "Timeout in milliseconds, defaults to 30000." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          connectionId: { type: "string", required: true },
          host: { type: "string", required: true },
          exitCode: { oneOf: [{ type: "integer" }, { type: "null" }], required: true },
          stdout: { type: "string", required: true },
          stderr: { type: "string", required: true },
          cwd: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
          commandId: { type: "string", required: true },
          startedAt: { type: "string", required: true },
          finishedAt: { type: "string", required: true },
          durationMs: { type: "integer", required: true },
          truncated: { type: "boolean", required: true },
          timedOut: { type: "boolean", required: true },
          redacted: { type: "boolean", required: true },
          blocked: { type: "boolean" },
          reason: { type: "string" },
          command: { type: "string" },
          prefilled: { type: "boolean" },
          queued: { type: "boolean" }
        }
      },
      render(args, value) {
        if (value.blocked) {
          const where = value.queued
            ? t("The command did not run; a confirmation card appeared in the SSH panel on the right, waiting for the operator to click “Run” or “Undo”: ")
            : t("The command did not run and cannot be prefilled; paste it into the terminal on the right to run it: ");
          const whereRuns = t("Confirmed (or pasted) execution happens inside the interactive shell on the right and follows the terminal's current directory; it is unrelated to the exec channel directory used by ssh_exec. Read relative paths in the command accordingly.");
          return [{ type: "text", text: t(`⚠️ Blocked: ${value.reason ?? ""}\n${where}\n\`\`\`bash\n${value.command ?? ""}\n\`\`\`\n${whereRuns}\nDo not retry or work around it; a human must confirm execution.`) }];
        }
        const out = value.stdout ?? "";
        const err = value.stderr ?? "";
        let body = out;
        if (err.length > 0) {
          if (body.length > 0 && !body.endsWith("\n")) body += "\n";
          body += `[stderr]\n${err}`;
        }
        if (body.length === 0) body = t("(no output)");
        if (value.exitCode !== null && value.exitCode !== 0) body += `\n[exit code: ${value.exitCode}]`;
        if (value.timedOut) body += "\n[command timed out]";
        if (value.truncated) body += "\n[output truncated for safe model context]";
        if (value.redacted) body += "\n[sensitive values redacted]";
        // Where the command ran. First line, so relative-path output always
        // has its context above it; null spells out the home fallback.
        const cwdNote = value.cwd
          ? `[cwd: ${value.cwd}]`
          : t("[cwd: login directory — no interactive shell directory detected]");
        return [{ type: "text", text: `${cwdNote}\n${body}` }];
      }
    },
    async execute(args) {
      const result = await service.executeCommand({
        connectionId: args.connection_id,
        command: args.command,
        timeoutMs: args.timeout_ms ?? 30000
      });
      if (!result.ok) throw new Error(`ssh_exec failed: ${result.error.message}`);
      return result.value;
    }
  }));

  ctx.tools.register(defineTool({
    name: "ssh_read",
    description: "Read buffered output from the current right-side SSH terminal. Omit connection_id for the current server; do not call ssh_list first. Useful after ssh_write or when the user typed something in the panel.",
    parameters: {
      connection_id: { type: "string", description: "Optional. Omit to target the current right-side SSH connection." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          connectionId: { type: "string", required: true },
          host: { type: "string", required: true },
          data: { type: "string", required: true },
          hasSession: { type: "boolean", required: true },
          truncated: { type: "boolean", required: true },
          redacted: { type: "boolean", required: true }
        }
      },
      render(args, value) {
        const body = !value.hasSession
          ? "(no open shell session on this connection)"
          : value.data || "(no output yet)";
        const notes = [
          value.truncated ? "[terminal capture truncated]" : "",
          value.redacted ? "[sensitive values redacted]" : ""
        ].filter(Boolean);
        return [{ type: "text", text: notes.length > 0 ? `${body}\n${notes.join("\n")}` : body }];
      }
    },
    async execute(args) {
      const result = service.readCurrentConnection({ connectionId: args.connection_id });
      if (!result.ok) throw new Error(`ssh_read failed: ${result.error.message}`);
      return result.value;
    }
  }));

  ctx.tools.register(defineTool({
    name: "ssh_write",
    description: "Send input into a right-side SSH terminal and, by default, press Enter afterwards so the input is submitted like a human typing Enter (a carriage return \\r is appended unless the input already ends with a newline). Omit connection_id to target the current/active terminal; provide connection_id to target a specific server's terminal. If the target connection has no open terminal, one is opened automatically so the input is never silently dropped. Normal operations are permitted through DSH permissions; explicitly destructive or irreversible commands are stopped before agent execution. Ctrl-C remains available to cancel an in-progress command.",
    parameters: {
      connection_id: { type: "string", description: "Optional. Omit to target the current/active terminal; specify to target that server's terminal (e.g. from ssh_connect/ssh_list)." },
      input: { type: "string", required: true, description: "The input to send, e.g. 'y' to answer a prompt, or 'ls -la' to run a command." },
      press_enter: { type: "boolean", description: "Whether to append a carriage return (Enter) after the input so the command or prompt answer is submitted. Defaults to true; set false to send raw input without submitting." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          written: { type: "integer", required: true }
        }
      },
      render(args, value) {
        return [{ type: "text", text: `Sent ${value.written} bytes to the terminal session.` }];
      }
    },
    async execute(args) {
      let input = typeof args.input === "string" ? args.input : String(args.input ?? "");
      // The physical Enter key emits a carriage return (\\r). Send that —
      // not a bare \\n — so the input also submits to programs that put the
      // terminal in raw mode (password prompts, [Y/n] confirmations).
      if (args.press_enter !== false && !/[\r\n]$/.test(input)) input += "\r";
      // The input must land in a live terminal session. If the target
      // connection has none open, open one first so "write + enter" actually
      // executes instead of silently writing 0 bytes.
      const ensure = await service.ensureSessionForWrite(args.connection_id);
      if (!ensure.ok) throw new Error(`ssh_write failed: ${ensure.error.message}`);
      const result = service.writeCurrentConnection({ connectionId: ensure.connectionId, input });
      if (!result.ok) throw new Error(`ssh_write failed: ${result.error.message}`);
      return result.value;
    }
  }));

  ctx.tools.register(defineTool({
    name: "ssh_disconnect",
    description: "Close the current SSH connection and any open shell sessions on it. Omit connection_id for the current right-side SSH server.",
    parameters: {
      connection_id: { type: "string", description: "Optional. Omit to target the current right-side SSH connection." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          disconnected: { type: "boolean", required: true }
        }
      },
      render(args, value) {
        return [{ type: "text", text: value.disconnected ? "Disconnected." : "Connection not found." }];
      }
    },
    async execute(args) {
      const result = await service.disconnectCurrentConnection({ connectionId: args.connection_id });
      if (!result.ok) throw new Error(`ssh_disconnect failed: ${result.error.message}`);
      return result.value;
    }
  }));
}
