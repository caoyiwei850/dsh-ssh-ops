/**
 * Reversible deletion for agent-initiated file removal (ssh_exec, sftp_delete).
 *
 * When the safety gate blocks a *simple* `rm`/`unlink`/`rmdir` command, the
 * command is rewritten into a trash move: targets are moved into
 * `$HOME/.dsh-trash/` on the remote host and recorded in that directory's
 * `manifest.tsv` (trash name, original absolute path, epoch, ISO time). Every
 * trash run first purges manifest entries older than the retention window, so
 * expired copies disappear without ever installing a cron/at job on the
 * server. Restore is an ordinary `mv` of the manifest line back to the
 * recorded path.
 *
 * Only fully literal, single-command deletions are rewritten: anything with
 * pipelines, redirection, command substitution, globs, expansions, exotic
 * flags or unknown programs keeps the original confirmation-card flow. The
 * generated script contains the word `rm` itself (the purge step), so it must
 * never be re-fed through assessShellCommand — callers rewrite before the
 * gate or keep the rewritten command inside the prepared-exec path.
 */

export const TRASH_DIR = "$HOME/.dsh-trash";
export const TRASH_MARKER = "__DSH_TRASH_V1__";
export const TRASH_RETENTION_MS = 24 * 60 * 60 * 1000;
export const TRASH_MANIFEST = "manifest.tsv";

const DELETE_PROGRAMS = new Set(["rm", "unlink", "rmdir"]);
// Bundles of these short flags are understood; anything else (long options,
// -p for rmdir, -i prompts whose semantics a move cannot reproduce) falls
// back to the confirmation card.
const RM_FLAGS = new Set(["r", "R", "f", "v", "d", "i"]);
const RMDIR_FLAGS = new Set(["v"]);
// Characters that make a command line "not a simple delete": operators,
// redirection, substitution, globs, brace/grouping syntax, comments. A path
// containing a tab would also corrupt the TSV manifest.
const UNSAFE_CHARS = new Set([";", "&", "|", "<", ">", "`", "$", "*", "?", "[", "]", "(", ")", "{", "}", "#", "\t", "\n", "\r"]);

/**
 * Tokenize a command line the way a shell would for a purely literal command:
 * single-quoted (verbatim), double-quoted (escape-aware, expansion rejected)
 * and bare words. Each token records whether its first character came from
 * inside quotes, because tilde expansion only happens for an unquoted `~` —
 * `rm '~/x'` and `rm ~/x` mean different directories. Returns null whenever
 * anything ambiguous or dynamic is present — the caller then keeps the
 * conservative card flow.
 */
function tokenizeLiteralCommand(command) {
  const tokens = [];
  let current = "";
  let hasToken = false;
  let firstQuoted = false;
  let i = 0;
  const n = command.length;
  const startToken = (fromQuote) => {
    if (!hasToken) { hasToken = true; firstQuoted = fromQuote; }
  };
  const endToken = () => {
    if (hasToken) { tokens.push({ text: current, quoted: firstQuoted }); current = ""; hasToken = false; }
  };
  while (i < n) {
    const ch = command[i];
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return null;
      startToken(true);
      current += command.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let part = "";
      let closed = false;
      while (j < n) {
        const c = command[j];
        if (c === "\\") {
          const next = command[j + 1];
          if (next === '"' || next === "\\" || next === "$" || next === "`") { part += next; j += 2; continue; }
          return null;
        }
        if (c === '"') { closed = true; j++; break; }
        if (c === "$" || c === "`") return null;
        part += c;
        j++;
      }
      if (!closed) return null;
      startToken(true);
      current += part;
      i = j;
      continue;
    }
    if (ch === "\\") {
      const next = command[i + 1];
      if (next === undefined || next === "\n") return null;
      startToken(false);
      current += next;
      i += 2;
      continue;
    }
    if (ch === " " || ch === "\t") {
      endToken();
      i++;
      continue;
    }
    if (UNSAFE_CHARS.has(ch)) return null;
    if (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127) return null;
    startToken(false);
    current += ch;
    i++;
  }
  endToken();
  return tokens;
}

/**
 * Parse an agent-issued command line as a simple, fully literal deletion.
 * Returns `{ targets }` (each `{ kind: "plain"|"home", path }`) when the whole
 * line is one rm/unlink/rmdir invocation with recognized flags and explicit
 * literal paths; null otherwise, meaning the caller must keep the
 * confirmation-card flow.
 */
export function parseSimpleDeleteCommand(command) {
  if (typeof command !== "string") return null;
  const tokens = tokenizeLiteralCommand(command.trim());
  if (tokens === null || tokens.length < 2) return null;
  const program = tokens[0].text;
  if (!DELETE_PROGRAMS.has(program)) return null;

  const targets = [];
  let noMoreFlags = false;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i].text;
    if (!noMoreFlags && token === "--") { noMoreFlags = true; continue; }
    if (!noMoreFlags && token.startsWith("-") && token.length > 1) {
      if (token.startsWith("--")) return null; // long options → card
      for (const flag of token.slice(1)) {
        const allowed = program === "rmdir" ? RMDIR_FLAGS : RM_FLAGS;
        if (!allowed.has(flag)) return null;
      }
      continue;
    }
    // A lone "-" is a stdin convention, not a path we can move.
    if (token === "-" || token.length === 0) return null;
    // A tab/newline inside a quoted path would corrupt the TSV manifest —
    // such targets keep the confirmation-card flow instead.
    if (/[\t\n\r\0]/.test(token)) return null;
    if (token === "/" || token === "." || token === "..") return null;
    if (token.startsWith("~")) {
      if (tokens[i].quoted) {
        // A quoted `~` is a literal directory name for the shell too, so the
        // move must keep it verbatim — identical to what rm would remove.
        targets.push({ kind: "plain", path: token });
      } else if (token === "~" || !token.startsWith("~/")) {
        return null; // bare ~ or ~user paths: refuse / cannot resolve
      } else if (token.length === 2) {
        return null; // bare ~/
      } else {
        targets.push({ kind: "home", path: token.slice(2) });
      }
    } else {
      targets.push({ kind: "plain", path: token });
    }
  }
  if (targets.length === 0) return null;
  return { program, targets };
}

function quoteTarget(target) {
  if (target.kind === "home") {
    // The tokenizer guarantees no " $ ` \ survive inside a target, so the
    // expansion is the only dynamic part and it is safe inside double quotes.
    return `"$HOME/${target.path}"`;
  }
  return shellSingleQuote(target.path);
}

/**
 * Build the remote POSIX-shell script that implements the trash move for the
 * parsed targets. The script:
 *   1. creates `$HOME/.dsh-trash/`,
 *   2. purges manifest entries older than `retentionMs` (no cron/at needed),
 *   3. moves each existing target into the trash under `<epoch>-<basename>`,
 *   4. appends a manifest line (name, original absolute path, epoch, ISO time),
 *   5. reports one `__DSH_TRASH_V1__` line per target for host-side parsing.
 * All paths are quoted; busybox/GNU/macOS coreutils all cover the used
 * builtins (mkdir/mv/awk/date/printf). The script always exits 0 — failures
 * are reported per target, never thrown.
 */
export function buildTrashCommand(targets, { retentionMs = TRASH_RETENTION_MS } = {}) {
  const retentionSec = Math.max(1, Math.floor(retentionMs / 1000));
  const list = targets.map(quoteTarget).join(" ");
  return [
    '__dsh_t="$HOME/.dsh-trash"',
    'mkdir -p "$__dsh_t" || { printf \'__DSH_TRASH_V1__\\terror\\ttrash-dir\\n\'; exit 0; }',
    "__dsh_n=$(date +%s)",
    '__dsh_m="$__dsh_t/manifest.tsv"',
    "if [ -f \"$__dsh_m\" ]; then",
    `  __dsh_cut=$((__dsh_n - ${retentionSec}))`,
    '  __dsh_tmp="$__dsh_t/.purge.$$"',
    "  awk -F'\\t' -v c=\"$__dsh_cut\" '$3+0 > 0 && $3+0 < c { print $1 }' \"$__dsh_m\" > \"$__dsh_tmp\" 2>/dev/null || : > \"$__dsh_tmp\"",
    '  __dsh_purged=0',
    '  while IFS= read -r __dsh_x; do',
    '    case "$__dsh_x" in ""|"."|".."|*/*) continue ;; esac',
    '    if rm -rf "$__dsh_t/$__dsh_x"; then __dsh_purged=$((__dsh_purged + 1)); fi',
    '  done < "$__dsh_tmp"',
    '  if [ "$__dsh_purged" -gt 0 ]; then',
    "    awk -F'\\t' -v c=\"$__dsh_cut\" '!($3+0 > 0 && $3+0 < c)' \"$__dsh_m\" > \"$__dsh_tmp\" 2>/dev/null && cat \"$__dsh_tmp\" > \"$__dsh_m\"",
    '  fi',
    '  rm -f "$__dsh_tmp"',
    `  printf '${TRASH_MARKER}\\tpurged\\t%d\\n' "$__dsh_purged"`,
    "fi",
    "__dsh_i=0",
    `for __dsh_p in ${list}; do`,
    '  case "$__dsh_p" in /*) : ;; *) __dsh_p="./$__dsh_p" ;; esac',
    '  __dsh_q=$__dsh_p',
    '  while : ; do case "$__dsh_q" in */) __dsh_q="${__dsh_q%/}" ;; *) break ;; esac; done',
    '  case "$__dsh_q" in /*) __dsh_abs=$__dsh_q ;; *) __dsh_abs="$(pwd -P 2>/dev/null || pwd)/${__dsh_q#./}" ;; esac',
    '  if [ ! -e "$__dsh_q" ] && [ ! -L "$__dsh_q" ]; then',
    `    printf '${TRASH_MARKER}\\tmissing\\t%s\\n' "$__dsh_abs"`,
    '    continue',
    '  fi',
    '  __dsh_b=${__dsh_q##*/}',
    '  __dsh_name="$__dsh_n-$__dsh_b"',
    '  __dsh_d="$__dsh_t/$__dsh_name"',
    '  while [ -e "$__dsh_d" ] || [ -L "$__dsh_d" ]; do',
    '    __dsh_i=$((__dsh_i + 1))',
    '    __dsh_name="$__dsh_n-$__dsh_i-$__dsh_b"',
    '    __dsh_d="$__dsh_t/$__dsh_name"',
    '  done',
    '  if mv "$__dsh_q" "$__dsh_d"; then',
    '    printf \'%s\\t%s\\t%s\\t%s\\n\' "$__dsh_name" "$__dsh_abs" "$__dsh_n" "$(date -u +%Y%m%dT%H%M%SZ)" >> "$__dsh_m"',
    `    printf '${TRASH_MARKER}\\tmoved\\t%s\\t%s\\n' "$__dsh_abs" "$__dsh_d"`,
    '  else',
    `    printf '${TRASH_MARKER}\\tfailed\\t%s\\n' "$__dsh_abs"`,
    '  fi',
    'done',
    'exit 0'
  ].join("\n");
}

/**
 * Extract the per-target report lines from a trash run's stdout and strip
 * them so neither the tool result nor the terminal mirror shows the protocol
 * lines. Returns `{ events, stdout }` with events like
 * `{ event: "moved", original, trashPath }`, `{ event: "missing"|"failed", original }`
 * and a single `{ event: "purged", count }`.
 */
export function parseTrashOutput(stdout) {
  const events = [];
  const kept = [];
  for (const line of String(stdout ?? "").split("\n")) {
    if (!line.startsWith(TRASH_MARKER)) { kept.push(line); continue; }
    const parts = line.split("\t");
    if (parts[1] === "moved" && parts.length >= 4) {
      events.push({ event: "moved", original: parts[2], trashPath: parts[3] });
    } else if ((parts[1] === "missing" || parts[1] === "failed" || parts[1] === "error") && parts.length >= 3) {
      events.push({ event: parts[1], original: parts[2] });
    } else if (parts[1] === "purged" && parts.length >= 3) {
      events.push({ event: "purged", count: Number(parts[2]) || 0 });
    }
  }
  return { events, stdout: kept.join("\n") };
}

/**
 * Parse a manifest.tsv body. Malformed lines are skipped; each entry keeps
 * its raw line because restore/purge rewrite the file by exact-line match.
 */
export function parseTrashManifest(text) {
  const entries = [];
  for (const raw of String(text ?? "").split("\n")) {
    if (raw.length === 0) continue;
    const parts = raw.split("\t");
    if (parts.length < 4 || parts[0].length === 0 || parts[1].length === 0) continue;
    const epoch = Number(parts[2]);
    if (!Number.isFinite(epoch) || epoch <= 0) continue;
    if (parts[0].includes("/") || parts[0] === "." || parts[0] === "..") continue;
    entries.push({ name: parts[0], original: parts[1], epoch, iso: parts[3], raw });
  }
  return entries;
}

function shellSingleQuote(text) {
  return `'${String(text).replace(/'/g, "'\\''")}'`;
}

function manifestFilterCommand(entry) {
  // Exact-line removal keeps every other entry byte-for-byte intact.
  return `grep -v -F -x -- ${shellSingleQuote(entry.raw)}`;
}

/**
 * Build a remote script that moves one trash entry back to its recorded
 * original path (never overwriting an existing file) and drops the manifest
 * line. `entry` comes from parseTrashManifest.
 */
export function buildRestoreCommand(entry) {
  if (!entry || typeof entry.name !== "string" || typeof entry.original !== "string") return null;
  const parent = entry.original.replace(/\/+[^/]*$/, "") || "/";
  return [
    `__dsh_f="$HOME/.dsh-trash/"${shellSingleQuote(entry.name)}`,
    'if [ ! -e "$__dsh_f" ] && [ ! -L "$__dsh_f" ]; then echo "trash entry not found: $__dsh_f" >&2; exit 1; fi',
    `if [ -e ${shellSingleQuote(entry.original)} ] || [ -L ${shellSingleQuote(entry.original)} ]; then echo "restore target already exists: ${entry.original.replace(/'/g, "'\\''")}" >&2; exit 1; fi`,
    `mkdir -p ${shellSingleQuote(parent)} || exit 1`,
    `if mv "$__dsh_f" ${shellSingleQuote(entry.original)}; then`,
    `  __dsh_m="$HOME/.dsh-trash/"${shellSingleQuote(TRASH_MANIFEST)}`,
    // grep -v exits 1 when it selects nothing (last line removed), so the
    // rewrite must not hang off its exit status — an empty result is valid.
    '  if [ -f "$__dsh_m" ]; then ' + manifestFilterCommand(entry) + ' "$__dsh_m" > "$__dsh_m.r" 2>/dev/null; cat "$__dsh_m.r" > "$__dsh_m" 2>/dev/null; rm -f "$__dsh_m.r"; fi',
    '  echo restored',
    'else',
    '  echo "restore move failed" >&2',
    '  exit 1',
    'fi'
  ].join("\n");
}

/**
 * Build a remote script that permanently deletes the given trash entries and
 * rewrites the manifest without them. This is the one place where a real
 * `rm -rf` is acceptable: it only ever touches paths inside the trash.
 */
export function buildPurgeCommand(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const lines = [
    `__dsh_m="$HOME/.dsh-trash/"${shellSingleQuote(TRASH_MANIFEST)}`
  ];
  for (const entry of entries) {
    if (!entry || typeof entry.name !== "string" || entry.name.includes("/") || entry.name === "." || entry.name === "..") continue;
    lines.push(`if rm -rf "$HOME/.dsh-trash/"${shellSingleQuote(entry.name)}; then echo purged; fi`);
    if (typeof entry.raw === "string" && entry.raw.length > 0) {
      // grep -v exits 1 when it selects nothing (last line removed); the
      // rewrite must still happen, so no && chaining here either.
      lines.push(`if [ -f "$__dsh_m" ]; then ` + manifestFilterCommand(entry) + ` "$__dsh_m" > "$__dsh_m.p" 2>/dev/null; cat "$__dsh_m.p" > "$__dsh_m" 2>/dev/null; rm -f "$__dsh_m.p"; fi`);
    }
  }
  return lines.join("\n");
}
