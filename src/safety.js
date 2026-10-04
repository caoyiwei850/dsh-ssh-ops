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
import { t } from "./i18n/core.js";

/**
 * Stable identifier for the file-deletion category. The trash rewrite keys on
 * this (not on the display string) so editing the human-facing message can
 * never silently disable the rewrite.
 *
 * The identifier is deliberately untranslated: `index.js` compares it and the
 * decision is made on the regex, so only the message built from it is
 * localized (see `blocked`).
 */
export const CATEGORY_DELETE_FILES = "Delete files or directories";

const IRREVERSIBLE_BLOCKS = [
  [/(?:^|\s)(?:rm|unlink|shred|rmdir)\b/i, CATEGORY_DELETE_FILES],
  // Deny-list evasion is a real, observed failure mode: an agent whose `rm`
  // was blocked once re-issued the deletion through an equivalent form. These
  // entries cover the high-frequency vectors — batch deletion disguised as
  // find/xargs, and interpreter one-liners that call unlink/rmtree from
  // python/perl/ruby/php/node. A deny-list can never be exhaustive (any
  // script or pipeline can hide a deletion); the recoverable-trash and
  // backup layers are the consequence backstop, this list only narrows it.
  [/\bfind\b[\s\S]*\s-delete\b/i, "Delete files in bulk"],
  [/\bfind\b[\s\S]*\s-exec(?:dir)?\b[\s\S]*\b(?:rm|unlink)\b/i, "Delete files in bulk"],
  [/\bxargs\b[^|;&]*\b(?:rm|unlink)\b/i, "Delete files in bulk"],
  [/\brimraf\b/i, CATEGORY_DELETE_FILES],
  [/\b(?:python3?|perl|ruby|php|node)\b[\s\S]*\b(?:unlink(?:Sync)?|rmtree|rmSync|rimraf|os\.remove|shutil\.rmtree|fs\.rm(?:Sync)?|fs\.unlink(?:Sync)?)\b/i, "Delete files through a script interpreter"],
  [/\b(?:drop\s+(?:database|schema|table|view|user)|truncate\b|delete\s+from\b)\b/i, "Delete database data or objects"],
  [/\b(?:mkfs(?:\.|\b)|dd\b|wipefs\b|fdisk\b|parted\b|sgdisk\b)\b/i, "Format or overwrite a disk"],
  [/\b(?:docker\s+(?:system\s+prune|container\s+prune|image\s+prune|volume\s+prune)|docker\s+(?:rm|rmi|volume\s+rm))\b/i, "Delete containers, images or volumes"],
  [/\b(?:kubectl\s+delete|helm\s+uninstall|terraform\s+destroy)\b/i, "Destroy deployed resources"],
  [/\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f)\b/i, "Irreversibly clean the code workspace"],
  [/\b(?:reboot|shutdown|poweroff|halt)\b/i, "Reboot or shut down the server"]
];

function blocked(category) {
  return {
    ok: false,
    category,
    // Short reason: surfaced on the ssh_write path (Enter was blocked) and as
    // the card title on ssh_exec/sftp_delete. Kept terse so the key advice
    // (don't retry, don't bypass, a human confirms) is visible at a glance.
    // The category is translated here, at call time, so the notice follows the
    // active language while the identifier above stays stable.
    reason: policyBlockedReason(t(category))
  };
}

/**
 * Return an allow/deny decision for an agent-initiated shell command line.
 * This is a deny-list of explicitly destructive operations, not a diagnostic
 * allow-list; normal DSH approval remains the primary permissions layer.
 */
export function assessShellCommand(command) {
  if (typeof command !== "string") return blocked(t("The command is not text"));
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
