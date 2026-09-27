/**
 * Agent tools for SFTP file management. sftp_delete never deletes on its own:
 * it converts the path into an `rm -rf` confirmation card for the operator;
 * approving it additionally leaves a silent rollback copy in the server trash
 * (see src/trash.js).
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { shellQuote } from "../safety.js";
import { buildTrashCommand, parseSimpleDeleteCommand } from "../trash.js";

export function registerSftpTools(ctx, service) {
  ctx.tools.register(defineTool({
    name: "sftp_list",
    description: "List the entries of a remote directory over SFTP on a connected server (the one open in the right-side SSH terminal unless connection_id is given). Returns file/directory entries with sizes and mtimes.",
    parameters: {
      connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." },
      path: { type: "string", required: true, description: "Remote directory path, e.g. /etc or /var/log." }
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
    async execute(args) {
      const result = await service.sftpList({ connectionId: args.connection_id, path: args.path });
      if (!result.ok) throw new Error(`sftp_list failed: ${result.error.message}`);
      return result.value;
    }
  }));

  ctx.tools.register(defineTool({
    name: "sftp_read",
    description: "Read a remote file's contents over SFTP (base64-decoded to text). Useful for inspecting config files, logs, or small artifacts on a connected server. Omit connection_id for the current server.",
    parameters: {
      connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." },
      path: { type: "string", required: true, description: "Remote file path." },
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
    async execute(args) {
      const result = await service.sftpReadFile({ connectionId: args.connection_id, path: args.path, maxBytes: args.max_bytes });
      if (!result.ok) throw new Error(`sftp_read failed: ${result.error.message}`);
      return result.value;
    }
  }));

  ctx.tools.register(defineTool({
    name: "sftp_write",
    description: "Write text content to a remote file over SFTP (creates or overwrites). Omit connection_id for the current server.",
    parameters: {
      connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." },
      path: { type: "string", required: true, description: "Remote file path to write." },
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
    async execute(args) {
      const result = await service.sftpWriteFile({ connectionId: args.connection_id, path: args.path, data: Buffer.from(args.content, "utf8").toString("base64") });
      if (!result.ok) throw new Error(`sftp_write failed: ${result.error.message}`);
      return result.value;
    }
  }));

  ctx.tools.register(defineTool({
    name: "sftp_mkdir",
    description: "Create a remote directory over SFTP. Omit connection_id for the current server.",
    parameters: {
      connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." },
      path: { type: "string", required: true, description: "Remote directory path to create." }
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { path: { type: "string", required: true } } },
      render(args, value) { return [{ type: "text", text: `Created directory ${value.path}` }]; }
    },
    async execute(args) {
      const result = await service.sftpMkdir({ connectionId: args.connection_id, path: args.path });
      if (!result.ok) throw new Error(`sftp_mkdir failed: ${result.error.message}`);
      return result.value;
    }
  }));

  ctx.tools.register(defineTool({
    name: "sftp_delete",
    description: "Delete a remote file or empty directory over SFTP. Omit connection_id for the current server. Deleting is irreversible and is never executed by the agent directly: the equivalent `rm -rf <path>` triggers a confirmation popup in the right-side SSH panel (or returns a copyable command when no terminal is open) for the operator to execute or cancel.",
    parameters: {
      connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." },
      path: { type: "string", required: true, description: "Remote path to delete." }
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { path: { type: "string", required: true }, isDirectory: { type: "boolean" }, blocked: { type: "boolean" }, reason: { type: "string" }, command: { type: "string" }, prefilled: { type: "boolean" }, queued: { type: "boolean" } } },
      render(args, value) {
        if (value.blocked) {
          const where = value.queued
            ? "命令未执行；右侧 SSH 终端面板已弹出确认卡片，等待操作员点击“执行”或“撤销”："
            : "命令未执行，无法预填，请粘贴到右侧终端执行：";
          return [{ type: "text", text: `⚠️ 已拦截：${value.reason ?? ""}\n${where}\n\`\`\`bash\n${value.command ?? ""}\n\`\`\`\n请勿重试/绕行，由人工确认执行。` }];
        }
        return [{ type: "text", text: `Deleted ${value.path}` }];
      }
    },
    async execute(args) {
      // Original card UX, byte for byte. The only addition is invisible: when
      // the path is a simple literal, the queued card carries a prepared trash
      // script so operator approval leaves a rollback copy on the server
      // (see src/trash.js) instead of really deleting.
      const command = `rm -rf ${shellQuote(args.path)}`;
      const parsed = parseSimpleDeleteCommand(command);
      const trashScript = parsed ? buildTrashCommand(parsed.targets) : null;
      const pending = service.prefillBlockedCommand(args.connection_id, command, "删除文件或目录（SFTP）", trashScript);
      return { path: args.path, blocked: true, reason: "删除文件或目录（SFTP）", command, prefilled: pending.prefilled, queued: pending.queued };
    }
  }));

  ctx.tools.register(defineTool({
    name: "sftp_rename",
    description: "Rename or move a remote file/directory over SFTP. Omit connection_id for the current server.",
    parameters: {
      connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." },
      from: { type: "string", required: true, description: "Current remote path." },
      to: { type: "string", required: true, description: "New remote path." }
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { from: { type: "string", required: true }, to: { type: "string", required: true } } },
      render(args, value) { return [{ type: "text", text: `Renamed ${value.from} -> ${value.to}` }]; }
    },
    async execute(args) {
      const result = await service.sftpRename({ connectionId: args.connection_id, from: args.from, to: args.to });
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
    async execute(args) {
      const result = await service.sftpUploadDir({ connectionId: args.connection_id, localPath: args.local_path, remotePath: args.remote_path });
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
    async execute(args) {
      const result = await service.sftpDownloadDir({ connectionId: args.connection_id, remotePath: args.remote_path, localPath: args.local_path });
      if (!result.ok) throw new Error(`sftp_download_dir failed: ${result.error.message}`);
      return result.value;
    }
  }));
}
