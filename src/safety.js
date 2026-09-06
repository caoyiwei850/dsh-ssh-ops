/**
 * Host-enforced SSH command policy.
 *
 * DSH owns normal approval/access-mode handling. The plugin therefore only
 * stops a conversational agent from issuing explicitly destructive commands;
 * routine SSL, package, service, and configuration operations stay available.
 * A user who deliberately types a high-risk command into the right-side SSH
 * terminal is not intercepted by this agent-command guard.
 */
import { policyBlockedReason } from "./policy-messages.js";

const IRREVERSIBLE_BLOCKS = [
  [/(?:^|\s)(?:rm|unlink|shred|rmdir)\b/i, "删除文件或目录"],
  [/\bfind\b[\s\S]*\s-delete\b/i, "批量删除文件"],
  [/\b(?:drop\s+(?:database|schema|table|view|user)|truncate\b|delete\s+from\b)\b/i, "删除数据库数据或对象"],
  [/\b(?:mkfs(?:\.|\b)|dd\b|wipefs\b|fdisk\b|parted\b|sgdisk\b)\b/i, "格式化或改写磁盘"],
  [/\b(?:docker\s+(?:system\s+prune|container\s+prune|image\s+prune|volume\s+prune)|docker\s+(?:rm|rmi|volume\s+rm))\b/i, "删除容器、镜像或卷"],
  [/\b(?:kubectl\s+delete|helm\s+uninstall|terraform\s+destroy)\b/i, "销毁已部署资源"],
  [/\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f)\b/i, "不可恢复地清理代码工作区"],
  [/\b(?:reboot|shutdown|poweroff|halt)\b/i, "重启或关闭服务器"]
];

function blocked(category) {
  return {
    ok: false,
    category,
    // Short reason: surfaced on the ssh_write path (Enter was blocked) and as
    // the card title on ssh_exec/sftp_delete. Kept terse so the key advice
    // (don't retry, don't bypass, a human confirms) is visible at a glance.
    reason: policyBlockedReason(category)
  };
}

/**
 * Return an allow/deny decision for an agent-initiated shell command line.
 * This is a deny-list of explicitly destructive operations, not a diagnostic
 * allow-list; normal DSH approval remains the primary permissions layer.
 */
export function assessShellCommand(command) {
  if (typeof command !== "string") return blocked("命令不是文本");
  const value = command.trim();
  if (!value) return { ok: true };

  for (const [pattern, reason] of IRREVERSIBLE_BLOCKS) {
    if (pattern.test(value)) return blocked(reason);
  }
  return { ok: true };
}

/**
 * Whether a blocked command can be safely prefilled into the interactive
 * terminal's input line. Control characters are rejected because Tab would
 * trigger completion, ESC/Ctrl-C would cancel the line, and CR/LF would
 * submit it immediately — the operator must be the one to press Enter.
 */
export function isPrefillable(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  if (command.length > 4096) return false;
  for (let i = 0; i < command.length; i++) {
    const code = command.charCodeAt(i);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

/**
 * POSIX single-quote an argument so it is safe to interpolate into a shell
 * command line (e.g. an SFTP path turned into `rm -rf <quoted>`). Embedded
 * single quotes are escaped with the standard `'\''` sequence.
 */
export function shellQuote(arg) {
  const text = typeof arg === "string" ? arg : String(arg ?? "");
  return `'${text.replace(/'/g, "'\\''")}'`;
}
