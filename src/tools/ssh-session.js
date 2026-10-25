/**
 * Agent tools for the SSH session lifecycle: list, connect, exec, read,
 * write, disconnect. All of them drive the same connections/sessions the
 * right-side panel shows; `service` is the SshOpsService instance.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { assessShellCommand, CATEGORY_DELETE_FILES } from "../safety.js";
import { parseSimpleDeleteCommand } from "../trash.js";
import { t } from "../i18n/core.js";

/** Human name for an execution-policy tier, for agent-facing notices. */
export function execPolicyLabel(mode) {
  if (mode === "custom") return t("自定义放行");
  if (mode === "allowAll") return t("全部放行");
  return t("标准");
}

/**
 * Ask the operator through the host's approval channel. Returns the raw
 * outcome ("allowed-once" | "rejected" | "cancelled" | "unavailable") so the
 * gate can grant precisely, and degrades to "unavailable" whenever the host
 * composes no approval service, exposes none to plugins, or the call has no
 * agent to route the prompt to — fail-closed in every direction.
 */
export async function askOperatorApproval(ctx, execution, reason) {
  let approval;
  try { approval = ctx.get("approval"); } catch { approval = undefined; }
  if (approval === undefined || execution?.agent === undefined || execution?.callId === undefined) {
    return { outcome: "unavailable" };
  }
  try {
    const outcome = await approval.request({
      agent: execution.agent,
      toolName: execution.name,
      callId: execution.callId,
      reason,
      signal: execution.signal
    });
    return { outcome: typeof outcome === "string" ? outcome : "unavailable" };
  } catch {
    return { outcome: "unavailable" };
  }
}

export function registerSshSessionTools(ctx, service) {
  // Dangerous-command gate for ssh_exec: the tools/pre-execute waterfall
  // evaluates the exact policy the exec path will enforce and, when the
  // command is deny-listed, suspends the whole call on the host's approval
  // channel — the agent cannot act, retry, or route around while the
  // operator decides. On "allow" a one-shot voucher (callId -> connection +
  // command) is recorded for the tool body to consume past the inner gate.
  // No approval channel at all degrades to deny, never to execute.
  if (typeof ctx.on === "function") ctx.on("tools/pre-execute", (execution, next) => {
    if (execution?.name !== "ssh_exec") return typeof next === "function" ? next() : undefined;
    return (async () => {
      const command = typeof execution.arguments?.command === "string" ? execution.arguments.command : "";
      const selected = service.resolveConnection(execution.arguments?.connection_id);
      if (!selected.ok) return typeof next === "function" ? next() : undefined; // no target: let the tool report the honest error
      const policy = service.resolveExecPolicy(selected.connectionId);
      const decision = assessShellCommand(command, policy);
      if (decision.ok) return typeof next === "function" ? next() : undefined;
      let trashNote = "";
      if (decision.category === CATEGORY_DELETE_FILES && parseSimpleDeleteCommand(command)) {
        trashNote = t("（批准后实际执行的是移入回收站的可逆操作，不会真删）");
      }
      const host = selected.connection.host ?? "";
      const reason = t(`AI 请求在 ${host} 上执行危险命令，已被执行策略（${execPolicyLabel(policy.mode)}）拦截：\n${command}\n风险类别：${t(decision.category ?? decision.reason)}${trashNote}\n批准=本次执行；拒绝=命令不会运行。`);
      const { outcome } = await askOperatorApproval(ctx, execution, reason);
      if (outcome === "allowed-once") {
        service.recordOperatorApproval(execution.callId, selected.connectionId, command);
        return typeof next === "function" ? next() : undefined;
      }
      if (outcome === "rejected") {
        return { kind: "deny", reason: t(`操作者拒绝了该危险命令（${command}）。请勿重试或换写法绕行；如确需执行，请让操作者自行在终端运行，或请其调整右侧面板的执行策略。`) };
      }
      if (outcome === "cancelled") {
        return { kind: "deny", reason: t("危险命令的确认被取消，命令未执行。请勿重试；如确需执行请与操作者确认。") };
      }
      return { kind: "deny", reason: t(`该命令属于危险操作（${t(decision.category ?? decision.reason)}），必须由操作者确认，但当前宿主没有可用的审批通道，命令未执行。请勿重试或绕行；请操作者直接在终端手动执行。`) };
    })();
  });

  ctx.tools.register(defineTool({
    name: "ssh_shell_integration",
    description: "Enable shell integration (OSC 133 markers) in an open SSH terminal's bash/zsh shell. Afterwards ssh_terminal_context reports the shell's current directory, the last command's exit code and whether it sits at a prompt — far more reliable than guessing from output text. Requires an idle, single interactive shell; the session must be one from ssh_terminal_sessions.",
    parameters: { session_id: { type: "string", required: true, description: "Session id from ssh_terminal_sessions." } },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { sessionId: { type: "string", required: true }, enabled: { type: "boolean", required: true } } },
      render(_args, value) {
        return [{ type: "text", text: value.enabled ? t(`已在会话 ${value.sessionId} 启用 shell integration；此后 ssh_terminal_context 会带上 cwd/退出码/提示符状态。`) : t("启用失败。") }];
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
    output: {
      schema: { type: "object", additionalProperties: false, properties: { sessions: { type: "array", required: true, items: { type: "object", additionalProperties: true } } } },
      render(_args, value) { return [{ type: "text", text: JSON.stringify(value, null, 2) }]; }
    },
    async execute() { const result = service.listTerminalContexts(); if (!result.ok) throw new Error(`ssh_terminal_sessions failed: ${result.error.message}`); return result.value; }
  }));

  ctx.tools.register(defineTool({
    name: "ssh_terminal_context",
    description: "Read a bounded, redacted range from a user-operated SSH terminal after approval. Use ssh_terminal_sessions first to select a session. This does not consume or alter the visible terminal history.",
    parameters: { session_id: { type: "string", required: true }, after: { type: "integer", description: "Optional cursor from a previous read." }, max_bytes: { type: "integer", description: "1024..98304 bytes; defaults to 24576." } },
    output: {
      schema: { type: "object", additionalProperties: true },
      render(_args, value) { return [{ type: "text", text: JSON.stringify(value, null, 2) }]; }
    },
    async execute(args) { const result = service.readTerminalContext({ sessionId: args.session_id, after: args.after, maxBytes: args.max_bytes }); if (!result.ok) throw new Error(`ssh_terminal_context failed: ${result.error.message}`); return result.value; }
  }));

  if (typeof ctx.on === "function") ctx.on("tools/pre-execute", (execution, next) => {
    if (execution?.name !== "ssh_terminal_context") return typeof next === "function" ? next() : undefined;
    return { kind: "ask", reason: "Agent requests recent manual SSH terminal activity, which may contain sensitive output." };
  });

  ctx.tools.register(defineTool({
    name: "ssh_list",
    description: t("List currently open SSH connections and identify the active server. This reports only live connection metadata (name, host, port, username and active state); it never returns credentials. When the operator enabled 「允许 AI 自动连接已保存服务器」 in the SSH settings, the result also lists the operator's saved SSH resources (name, host, username, whether already connected) — connect one with ssh_connect_profile. Use this tool when the user asks which server is connected or which saved servers exist; for normal server work, ssh_exec/ssh_read/ssh_write already target the active connection automatically."),
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
            ? t("Saved SSH resources: none saved yet — the operator can add servers in 设置 → SSH 资源.")
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
    description: t("Connect to one of the operator's saved SSH resources (设置 → SSH 资源) by name and make it the active connection: later ssh_exec/ssh_read/ssh_write without connection_id target it, and its terminal opens in the right-side panel so the operator can see which machine you are on. Only works when the operator enabled 「允许 AI 自动连接已保存服务器」; with the switch off the call fails — then ask the operator to connect the server, and NEVER fall back to ssh_connect with credentials you gathered from conversation. Reuses an already-open connection for the same resource instead of connecting twice."),
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
        const base = t(`已连接保存的服务器「${value.name}」（${value.username}@${value.host}:${value.port}，id: ${value.connectionId}），并已设为当前 SSH 连接，后续 ssh_exec 等工具默认作用于这台机器。${value.reused ? t("复用了该服务器已有的连接。") : ""}${value.terminalOpened ? t("已为它打开终端会话（可在右侧 SSH 面板查看该机器）。") : ""}`);
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
    description: "Run a normal SSH command on the server currently open in the right-side SSH terminal and return its output. This runs one non-interactive command and returns when it finishes. Tasks that need terminal interaction — switching users (sudo -i / su), entering a container (docker exec -it), or connecting onward to another machine (ssh) — do not fit here; run those with ssh_write in the interactive terminal instead. Omit connection_id when the user means the current server; do not call ssh_list first. On Linux with one identifiable idle POSIX terminal shell, the dedicated exec channel starts in that shell's verified current directory. A busy, ambiguous, or inaccessible terminal directory rejects the command instead of guessing; when no terminal shell is detectable, the normal login directory is used and cwd is null. SSH configuration, package changes, service reloads, and config edits are allowed and remain subject to DSH permissions. Explicitly destructive or irreversible commands suspend this call until the operator answers the host's confirmation prompt in the conversation: approving runs the command once, rejecting denies it — never retry or route around a rejection. The command and output are also shown in the terminal panel.",
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
          policy: { type: "string" },
          policySource: { type: "string" }
        }
      },
      render(args, value) {
        if (value.blocked) {
          const tierNote = value.policy
            ? "\n" + t(`当前连接执行策略：${execPolicyLabel(value.policy)}${value.policySource === "session" ? t("（操作者本次会话内切换）") : ""}。若操作者希望放开此类命令，请其自行在右侧面板的策略开关中调整；请勿重试。`)
            : "";
          return [{ type: "text", text: t(`⚠️ 已拦截：${value.reason ?? ""}\n命令未执行。危险命令必须由操作者确认，本次调用没有获得批准（操作者拒绝，或宿主没有可用的审批通道）。\n\`\`\`bash\n${value.command ?? ""}\n\`\`\`\n请勿重试或换写法绕行；把命令交给操作者自行执行，或请其调整执行策略。`) + tierNote }];
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
    async execute(args, exec) {
      const result = await service.executeCommand({
        connectionId: args.connection_id,
        command: args.command,
        timeoutMs: args.timeout_ms ?? 30000,
        // The pre-execute gate records its voucher under the execution id;
        // the inner gate consumes it so an operator-approved command runs.
        approvalToken: exec?.callId
      });
      if (!result.ok) throw new Error(`ssh_exec failed: ${result.error.message}`);
      return result.value;
    }
  }));

  ctx.tools.register(defineTool({
    name: "ssh_read",
    description: "Read output from the current right-side SSH terminal. Omit connection_id for the current server; do not call ssh_list first. By default only output that arrived since your previous ssh_read on this connection is returned — results you already received are not repeated, so read again after ssh_write without re-paying for old output. Pass mode \"tail\" for the full recent terminal capture instead (e.g. output that predates your first read, or something that scrolled past). Also useful when the user typed something in the panel.",
    parameters: {
      connection_id: { type: "string", description: "Optional. Omit to target the current right-side SSH connection." },
      mode: { type: "string", enum: ["new", "tail"], description: "'new' (default) returns only output that arrived since the previous ssh_read on this connection; 'tail' returns the whole recent terminal capture. Use 'tail' sparingly — it repeats output you likely already have." }
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
          : value.data || (args.mode === "tail" ? "(no output yet)" : "(no new output since the previous read)");
        const notes = [
          value.truncated ? "[terminal capture truncated]" : "",
          value.redacted ? "[sensitive values redacted]" : ""
        ].filter(Boolean);
        return [{ type: "text", text: notes.length > 0 ? `${body}\n${notes.join("\n")}` : body }];
      }
    },
    async execute(args) {
      const result = service.readCurrentConnection({ connectionId: args.connection_id, mode: args.mode });
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
