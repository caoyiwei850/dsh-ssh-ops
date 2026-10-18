/**
 * Agent tools for SFTP file management. sftp_delete never deletes on its own:
 * the tools/pre-execute gate suspends the call on the host's approval channel
 * and only an operator "allow" lets the body run — as a reversible move to the
 * server trash (see src/trash.js) whenever the path is a simple literal.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { shellQuote } from "../safety.js";
import { buildTrashCommand, parseSimpleDeleteCommand } from "../trash.js";
import { t } from "../i18n/core.js";
import { askOperatorApproval } from "./ssh-session.js";

export function registerSftpTools(ctx, service) {
  /**
   * Resolve one SFTP request for the calling session (issue #38). When the
   * session's workspace is bound to a remote root, a relative path resolves
   * under that root and an omitted connection_id means the bound server;
   * otherwise the historical absolute-path/current-connection behavior is
   * untouched. A path that escapes the bound root is refused here, before any
   * I/O reaches the server.
   */
  const resolveTarget = (exec, connectionId, path) => service.resolveRemoteToolPath({ connectionId, path }, exec);
  /** Second path of a rename must land on the same server as the first. */
  const target = (resolved, connectionId) => (connectionId ?? resolved.connectionId);

  // sftp_delete is a deletion by definition, so its gate asks unconditionally:
  // the whole call suspends until the operator answers, and only "allow"
  // records the voucher the body consumes to actually delete. Deny paths and
  // hosts without an approval channel degrade to a structured blocked result,
  // never to a deletion.
  if (typeof ctx.on === "function") ctx.on("tools/pre-execute", (execution, next) => {
    if (execution?.name !== "sftp_delete") return typeof next === "function" ? next() : undefined;
    return (async () => {
      let preview;
      try {
        preview = await resolveTarget(execution, execution.arguments?.connection_id, execution.arguments?.path);
      } catch {
        return typeof next === "function" ? next() : undefined; // bad path: let the tool report the honest error
      }
      const conn = service.connections?.get(preview.connectionId);
      const host = conn?.host ?? preview.connectionId;
      const command = `rm -rf ${shellQuote(preview.path)}`;
      const reason = t(`AI 请求删除 ${host} 上的：\n${preview.path}\n（等价于 \`${command}\`）。批准后优先执行移入回收站的可逆删除；拒绝则不会删除任何内容。`);
      const { outcome } = await askOperatorApproval(ctx, execution, reason);
      if (outcome === "allowed-once") {
        service.recordOperatorApproval(execution.callId, preview.connectionId, command);
        return typeof next === "function" ? next() : undefined;
      }
      const denied = outcome === "rejected"
        ? t(`操作者拒绝了删除 ${preview.path}。请勿重试或换路径绕行；确需删除请让操作者自行处理。`)
        : outcome === "cancelled"
          ? t("删除操作的确认被取消，未删除任何内容。请勿重试；确需删除请与操作者确认。")
          : t(`删除 ${preview.path} 必须由操作者确认，但当前宿主没有可用的审批通道，未删除任何内容。请让操作者自行删除。`);
      return { kind: "deny", reason: denied };
    })();
  });

  ctx.tools.register(defineTool({
    name: "sftp_list",
    description: "List the entries of a remote directory over SFTP on a connected server (the one open in the right-side SSH terminal unless connection_id is given). In a remote workspace a relative path resolves under the bound remote root. Returns file/directory entries with sizes and mtimes.",
    parameters: {
      connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server (or the remote workspace's bound server)." },
      path: { type: "string", required: true, description: "Remote directory path, e.g. /etc or /var/log. Relative values resolve under the remote workspace root." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", required: true },
          entries: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
            name: { type: "string", required: true },
            isDirectory: { type: "boolean", required: true },
            size: { type: "number", required: true },
            mtime: { type: "number", required: true },
            mode: { type: "number", required: true }
          } } }
        }
      },
      render(args, value) {
        if (!value.entries.length) return [{ type: "text", text: `(empty directory ${value.path})` }];
        const lines = value.entries.map((e) => `${e.isDirectory ? "d" : "-"} ${e.isDirectory ? "" : String(e.size).padStart(10)}  ${new Date(e.mtime).toISOString().slice(0, 16).replace("T", " ")}  ${e.name}`);
        return [{ type: "text", text: `Directory ${value.path} (${value.entries.length} entries):\n` + lines.join("\n") }];
      }
    },
    async execute(args, exec) {
      const target = await resolveTarget(exec, args.connection_id, args.path);
      const result = await service.sftpList({ connectionId: target.connectionId, path: target.path });
      if (!result.ok) throw new Error(`sftp_list failed: ${result.error.message}`);
      return result.value;
    }
  }));

  ctx.tools.register(defineTool({
    name: "sftp_read",
    description: "Read a remote file's contents over SFTP (base64-decoded to text). Useful for inspecting config files, logs, or small artifacts on a connected server. Omit connection_id for the current server.",
    parameters: {
      connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." },
      path: { type: "string", required: true, description: "Remote file path. A relative path resolves under the remote workspace root." },
      max_bytes: { type: "integer", description: "Maximum bytes to read, defaults to 4 MiB." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", required: true },
          data: { type: "string", required: true },
          truncated: { type: "boolean", required: true },
          bytes: { type: "number", required: true }
        }
      },
      render(args, value) {
        const body = value.data || "(empty file)";
        return [{ type: "text", text: value.truncated ? `${body}\n[output truncated at ${value.bytes} bytes]` : body }];
      }
    },
    async execute(args, exec) {
      const target = await resolveTarget(exec, args.connection_id, args.path);
      const result = await service.sftpReadFile({ connectionId: target.connectionId, path: target.path, maxBytes: args.max_bytes });
      if (!result.ok) throw new Error(`sftp_read failed: ${result.error.message}`);
      return result.value;
    }
  }));

  ctx.tools.register(defineTool({
    name: "sftp_write",
    description: "Write text content to a remote file over SFTP (creates or overwrites). Omit connection_id for the current server.",
    parameters: {
      connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." },
      path: { type: "string", required: true, description: "Remote file path to write. A relative path resolves under the remote workspace root." },
      content: { type: "string", required: true, description: "File content to write." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", required: true },
          bytes: { type: "number", required: true }
        }
      },
      render(args, value) {
        return [{ type: "text", text: `Wrote ${value.bytes} bytes to ${value.path}` }];
      }
    },
    async execute(args, exec) {
      const target = await resolveTarget(exec, args.connection_id, args.path);
      const result = await service.sftpWriteFile({ connectionId: target.connectionId, path: target.path, data: Buffer.from(args.content, "utf8").toString("base64") });
      if (!result.ok) throw new Error(`sftp_write failed: ${result.error.message}`);
      return result.value;
    }
  }));

  ctx.tools.register(defineTool({
    name: "sftp_mkdir",
    description: "Create a remote directory over SFTP. Omit connection_id for the current server.",
    parameters: {
      connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." },
      path: { type: "string", required: true, description: "Remote directory path to create. A relative path resolves under the remote workspace root." }
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { path: { type: "string", required: true } } },
      render(args, value) { return [{ type: "text", text: `Created directory ${value.path}` }]; }
    },
    async execute(args, exec) {
      const target = await resolveTarget(exec, args.connection_id, args.path);
      const result = await service.sftpMkdir({ connectionId: target.connectionId, path: target.path });
      if (!result.ok) throw new Error(`sftp_mkdir failed: ${result.error.message}`);
      return result.value;
    }
  }));

  ctx.tools.register(defineTool({
    name: "sftp_delete",
    description: "Delete a remote file or directory over SFTP. Omit connection_id for the current server. Deletion suspends this call until the operator answers the host's confirmation prompt in the conversation: approving performs a reversible move to the server trash when the path is a simple literal (a real deletion otherwise), rejecting deletes nothing — never retry or route around a rejection.",
    parameters: {
      connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." },
      path: { type: "string", required: true, description: "Remote path to delete. A relative path resolves under the remote workspace root." }
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { path: { type: "string", required: true }, isDirectory: { type: "boolean" }, blocked: { type: "boolean" }, reason: { type: "string" }, command: { type: "string" } } },
      render(args, value) {
        if (value.blocked) {
          return [{ type: "text", text: t(`⚠️ 已拦截：${value.reason ?? ""}\n未删除任何内容。删除必须由操作者确认，本次调用没有获得批准（操作者拒绝，或宿主没有可用的审批通道）。\n\`\`\`bash\n${value.command ?? ""}\n\`\`\`\n请勿重试或换路径绕行；把删除交给操作者自行处理。`) }];
        }
        return [{ type: "text", text: `Deleted ${value.path}` }];
      }
    },
    async execute(args, exec) {
      // The pre-execute gate asked the operator and, on "allow", recorded a
      // voucher under this execution's id; it is consumed here exactly once.
      // In a remote workspace the ask always names the resolved absolute
      // path, so the operator sees exactly what would be removed.
      const resolved = await resolveTarget(exec, args.connection_id, args.path);
      const command = `rm -rf ${shellQuote(resolved.path)}`;
      const parsed = parseSimpleDeleteCommand(command);
      const trashScript = parsed ? buildTrashCommand(parsed.targets) : null;
      if (!(exec?.callId !== undefined && service.consumeOperatorApproval(exec.callId, resolved.connectionId, command))) {
        return { path: resolved.path, blocked: true, reason: t("删除文件或目录（SFTP）"), command };
      }
      // Approved: the reversible trash move is what actually runs whenever
      // the path allows it; only a non-parseable path deletes for real.
      const result = await service.runPreparedExec(resolved.connectionId, trashScript ?? command, command, true, 30000, false, false);
      if (!result.ok) throw new Error(`sftp_delete failed: ${result.error.message}`);
      if (result.value.timedOut || result.value.exitCode !== 0) {
        const detail = result.value.stderr?.trim() || `exit code ${result.value.exitCode ?? "unknown"}`;
        throw new Error(`sftp_delete outcome is not successful: ${detail}`);
      }
      return { path: resolved.path };
    }
  }));

  ctx.tools.register(defineTool({
    name: "sftp_rename",
    description: "Rename or move a remote file/directory over SFTP. Omit connection_id for the current server.",
    parameters: {
      connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." },
      from: { type: "string", required: true, description: "Current remote path. A relative path resolves under the remote workspace root." },
      to: { type: "string", required: true, description: "New remote path. A relative path resolves under the remote workspace root." }
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { from: { type: "string", required: true }, to: { type: "string", required: true } } },
      render(args, value) { return [{ type: "text", text: `Renamed ${value.from} -> ${value.to}` }]; }
    },
    async execute(args, exec) {
      const file = await resolveTarget(exec, args.connection_id, args.from);
      const destination = await resolveTarget(exec, target(file, args.connection_id), args.to);
      const result = await service.sftpRename({ connectionId: file.connectionId, from: file.path, to: destination.path });
      if (!result.ok) throw new Error(`sftp_rename failed: ${result.error.message}`);
      return result.value;
    }
  }));

  ctx.tools.register(defineTool({
    name: "sftp_upload_dir",
    description: "Upload a local directory tree to a remote server over SFTP, creating the remote directory structure. Small files transfer in parallel (bounded), large files one at a time for full link throughput. Per-file failures are reported, not fatal. Omit connection_id for the current server.",
    parameters: {
      connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." },
      local_path: { type: "string", required: true, description: "Local directory to upload." },
      remote_path: { type: "string", required: true, description: "Remote destination directory (created when missing)." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          source: { type: "string", required: true },
          target: { type: "string", required: true },
          directories: { type: "number", required: true },
          files: { type: "number", required: true },
          bytes: { type: "number", required: true },
          failed: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: { path: { type: "string", required: true }, error: { type: "string", required: true } } } }
        }
      },
      render(args, value) {
        const head = `Uploaded ${value.files} files (${value.bytes} bytes, ${value.directories} directories) to ${value.target}`;
        if (!value.failed.length) return [{ type: "text", text: head }];
        const lines = value.failed.map((f) => `- ${f.path}: ${f.error}`);
        return [{ type: "text", text: `${head}\n${value.failed.length} failures:\n${lines.join("\n")}` }];
      }
    },
    async execute(args, exec) {
      const target = await resolveTarget(exec, args.connection_id, args.remote_path);
      const result = await service.sftpUploadDir({ connectionId: target.connectionId, localPath: args.local_path, remotePath: target.path });
      if (!result.ok) throw new Error(`sftp_upload_dir failed: ${result.error.message}`);
      return result.value;
    }
  }));

  ctx.tools.register(defineTool({
    name: "sftp_download_dir",
    description: "Download a remote directory tree over SFTP to a local directory, recreating the structure. Small files transfer in parallel (bounded), large files one at a time. Per-file failures are reported, not fatal. Omit connection_id for the current server.",
    parameters: {
      connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." },
      remote_path: { type: "string", required: true, description: "Remote directory to download." },
      local_path: { type: "string", required: true, description: "Local destination directory (created when missing)." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          source: { type: "string", required: true },
          target: { type: "string", required: true },
          directories: { type: "number", required: true },
          files: { type: "number", required: true },
          bytes: { type: "number", required: true },
          failed: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: { path: { type: "string", required: true }, error: { type: "string", required: true } } } }
        }
      },
      render(args, value) {
        const head = `Downloaded ${value.files} files (${value.bytes} bytes, ${value.directories} directories) to ${value.target}`;
        if (!value.failed.length) return [{ type: "text", text: head }];
        const lines = value.failed.map((f) => `- ${f.path}: ${f.error}`);
        return [{ type: "text", text: `${head}\n${value.failed.length} failures:\n${lines.join("\n")}` }];
      }
    },
    async execute(args, exec) {
      const target = await resolveTarget(exec, args.connection_id, args.remote_path);
      const result = await service.sftpDownloadDir({ connectionId: target.connectionId, remotePath: target.path, localPath: args.local_path });
      if (!result.ok) throw new Error(`sftp_download_dir failed: ${result.error.message}`);
      return result.value;
    }
  }));
}
