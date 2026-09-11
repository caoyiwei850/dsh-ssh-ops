/**
 * Agent tools for the SSH session lifecycle: list, connect, exec, read,
 * write, disconnect. All of them drive the same connections/sessions the
 * right-side panel shows; `service` is the SshOpsService instance.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";

export function registerSshSessionTools(ctx, service) {
  ctx.tools.register(defineTool({
    name: "ssh_list",
    description: "List currently open SSH connections and identify the active server. This reports only live connection metadata (name, host, port, username and active state); it never lists saved SSH resources or credentials. Use it only when the user asks which server is connected. For normal server work, ssh_exec/ssh_read/ssh_write already target the active connection automatically.",
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
                sessions: { type: "array", required: true, items: { type: "string" } }
              }
            }
          }
        }
      },
      render(_args, value) {
        if (value.connections.length === 0) return [{ type: "text", text: "No SSH connection is currently open." }];
        const lines = value.connections.map((connection) => `${connection.connectionId === value.activeConnectionId ? "* " : "- "}${connection.name ?? connection.host}: ${connection.username}@${connection.host}:${connection.port}${connection.sessions.length ? " (terminal open)" : ""}`);
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
    description: "Connect to a remote server over SSH, open it in the right-side terminal, and make it the current connection for later SSH tools. Subsequent ssh_exec, ssh_read, ssh_write, and ssh_disconnect calls automatically use this connection unless a connection_id is explicitly supplied.",
    parameters: {
      host: { type: "string", required: true, description: "Remote hostname or IP address." },
      port: { type: "integer", description: "SSH port, defaults to 22." },
      username: { type: "string", required: true, description: "SSH username." },
      auth: {
        type: "object",
        required: true,
        additionalProperties: false,
        description: "Authentication. Either {kind: 'password', password} or {kind: 'key', privateKey, passphrase?}.",
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
          warning: { type: "string" }
        }
      },
      render(args, value) {
        const conn = value ?? {};
        const base = `Connected ${args.username}@${args.host} (id: ${conn.connectionId ?? "?"})`;
        // A weakened handshake must be visible in the tool result, not only in
        // the host log — otherwise nobody learns the device needs upgrading.
        return [{ type: "text", text: conn.legacyFallback ? `${base}\n⚠️ ${conn.warning ?? ""}` : base }];
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
    name: "ssh_exec",
    description: "Run a normal SSH command on the server currently open in the right-side SSH terminal and return its output. Omit connection_id when the user means the current server; do not call ssh_list first. On Linux with one identifiable idle POSIX terminal shell, the dedicated exec channel starts in that shell's verified current directory. A busy, ambiguous, or inaccessible terminal directory rejects the command instead of guessing; when no terminal shell is detectable, the normal login directory is used and cwd is null. SSH configuration, package changes, service reloads, and config edits are allowed and remain subject to DSH permissions. Explicitly destructive or irreversible operations are not run: a confirmation popup appears in the right-side SSH panel, where only the operator can execute or cancel them. The command and output are also shown in the terminal panel.",
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
            ? "命令未执行；右侧 SSH 终端面板已弹出确认卡片，等待操作员点击“执行”或“撤销”："
            : "命令未执行，无法预填，请粘贴到右侧终端执行：";
          const whereRuns = "确认执行（或粘贴执行）发生在右侧交互 shell 内，跟随终端当前目录；与 ssh_exec 的 exec 通道目录无关。命令里的相对路径请按此理解。";
          return [{ type: "text", text: `⚠️ 已拦截：${value.reason ?? ""}\n${where}\n\`\`\`bash\n${value.command ?? ""}\n\`\`\`\n${whereRuns}\n请勿重试/绕行，由人工确认执行。` }];
        }
        const out = value.stdout ?? "";
        const err = value.stderr ?? "";
        let body = out;
        if (err.length > 0) {
          if (body.length > 0 && !body.endsWith("\n")) body += "\n";
          body += `[stderr]\n${err}`;
        }
        if (body.length === 0) body = "(no output)";
        if (value.exitCode !== null && value.exitCode !== 0) body += `\n[exit code: ${value.exitCode}]`;
        if (value.timedOut) body += "\n[command timed out]";
        if (value.truncated) body += "\n[output truncated for safe model context]";
        if (value.redacted) body += "\n[sensitive values redacted]";
        // Where the command ran. First line, so relative-path output always
        // has its context above it; null spells out the home fallback.
        const cwdNote = value.cwd
          ? `[cwd: ${value.cwd}]`
          : "[cwd: login directory — no interactive shell directory detected]";
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
