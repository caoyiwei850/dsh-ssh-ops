/**
 * Discovery for the operator's OpenSSH client configuration.
 *
 * The plugin used to offer this feature and lost it to a broken fs callback
 * (v0.3.16). This module is the read-only half only: it turns `~/.ssh/config`
 * into a list of concrete hosts the panel can import, and never writes to the
 * storage domain or the credential store. The import itself lives in
 * `SshOpsService.sshConfigImport` so validation and record creation stay next
 * to the tables that already own them.
 *
 * Semantics intentionally follow OpenSSH rather than a naive line split:
 * - `Include` is expanded in place, so a split config is not half-imported;
 * - the first value obtained for a keyword inside a Host block wins;
 * - `Host`/`Match` patterns (`*`, `?`, `!`) describe rules, not servers, so
 *   they produce no entries — only concrete aliases do;
 * - `%d %h %n %r %u %%` tokens are expanded the way ssh expands them.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { t } from "./i18n/core.js";
import { isAbsolute, join } from "node:path";

/** Includes nested deeper than this are almost certainly a loop or a mistake. */
const MAX_INCLUDE_DEPTH = 4;
/** A runaway config must not produce an unbounded import dialog. */
const MAX_ENTRIES = 500;
/** Private keys larger than this are not keys. */
const MAX_KEY_BYTES = 1024 * 1024;
/** Lines longer than this are not ssh_config syntax; skip them safely. */
const MAX_LINE_LENGTH = 8192;

/** Keywords that are collected per Host block (first value wins). */
const WANTED = new Set(["hostname", "port", "user", "identityfile", "proxyjump"]);

function expandTilde(value, home) {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(home, value.slice(2));
  return value;
}

/**
 * Expand the ssh_config percent tokens. `%h` needs the already-expanded host
 * name, so callers pass `host` for it; `%n` always means the alias.
 */
function expandTokens(value, context) {
  return value.replace(/%([%dhUnr])/g, (whole, token) => {
    switch (token) {
      case "%": return "%";
      case "d": return context.home;
      case "h": return context.host ?? whole;
      case "n": return context.name ?? whole;
      case "r": return context.username ?? whole;
      case "u": return context.localUser ?? whole;
      default: return whole;
    }
  });
}

/** Split `key value` or `key=value` the way ssh_config accepts both. */
function splitOption(line) {
  const match = /^([A-Za-z][A-Za-z0-9]*)\s*(?:=\s*|\s+)(.*)$/.exec(line);
  if (match === null) return null;
  const value = match[2].trim().replace(/^"([\s\S]*)"$/, "$1");
  return { key: match[1].toLowerCase(), value };
}

/** A Host argument is importable only when it names one concrete alias. */
function isConcreteAlias(alias) {
  return alias.length > 0 && !alias.includes("*") && !alias.includes("?") && !alias.startsWith("!");
}

async function readText(path) {
  const text = await readFile(path, "utf8");
  // A CRLF config on Windows must not leave \r on every value.
  return text.replace(/\r\n?/g, "\n");
}

/**
 * Yield the logical lines of one config file, with `Include` expanded in
 * place. Yields `{ line, file }` so a parse warning can name the file that
 * caused it.
 */
async function* readConfigLines(path, context, depth = 0) {
  let text;
  try {
    text = await readText(path);
  } catch (error) {
    if (depth === 0) throw error;
    context.warnings.add(t(`无法读取 ${path}：${error.message}`));
    return;
  }
  for (const raw of text.split("\n")) {
    if (raw.length > MAX_LINE_LENGTH) continue;
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const option = splitOption(line);
    if (option === null) continue;
    if (option.key !== "include") {
      yield { line, file: path };
      continue;
    }
    if (depth >= MAX_INCLUDE_DEPTH) {
      context.warnings.add(t(`Include 嵌套超过 ${MAX_INCLUDE_DEPTH} 层，已跳过：${option.value}`));
      continue;
    }
    for (const included of await resolveInclude(option.value, context, depth)) {
      yield* readConfigLines(included, context, depth + 1);
    }
  }
}

/**
 * Resolve an Include argument to concrete files. Relative paths are relative
 * to `~/.ssh` (where ssh itself looks). Globs are matched against the target
 * directory with a small `*`/`?` matcher — no dependency, no shell.
 */
async function resolveInclude(value, context, depth) {
  const expanded = expandTilde(expandTokens(value, { home: context.home }), context.home);
  const absolute = isAbsolute(expanded) ? expanded : join(context.home, ".ssh", expanded);
  if (!absolute.includes("*") && !absolute.includes("?")) return [absolute];
  const slash = Math.max(absolute.lastIndexOf("/"), absolute.lastIndexOf("\\"));
  if (slash < 0) return [];
  const directory = absolute.slice(0, slash) || "/";
  const pattern = absolute.slice(slash + 1);
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    context.warnings.add(t(`无法展开 Include ${value}：${error.message}`));
    return [];
  }
  const matcher = globMatcher(pattern);
  return names.filter((name) => matcher(name)).sort().map((name) => join(directory, name));
}

/** Translate an ssh-style glob (`*`, `?`) into a predicate. */
function globMatcher(pattern) {
  let source = "^";
  for (const character of pattern) {
    if (character === "*") source += "[^\\\\/]*";
    else if (character === "?") source += "[^\\\\/]";
    else source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const expression = new RegExp(`${source}$`);
  return (name) => expression.test(name);
}

/**
 * Read the private key referenced by an IdentityFile only far enough to know
 * whether it is usable: existence, size, and whether it needs a passphrase.
 * Returns the path rather than the content; the caller decides whether to
 * import the material.
 */
async function inspectKeyFile(path) {
  if (path === null) return { exists: false, encrypted: false, error: null };
  try {
    const info = await stat(path);
    if (!info.isFile()) return { exists: false, encrypted: false, error: t(`不是普通文件：${path}`) };
    if (info.size > MAX_KEY_BYTES) return { exists: false, encrypted: false, error: t(`私钥文件超过 1 MB：${path}`) };
    const text = await readText(path);
    return { exists: true, encrypted: keyIsEncrypted(text), error: null };
  } catch (error) {
    return { exists: false, encrypted: false, error: error.code === "ENOENT" ? null : error.message };
  }
}

/** Detect the two encrypted private-key encodings OpenSSH users actually have. */
export function keyIsEncrypted(text) {
  if (/Proc-Type:\s*4\s*,\s*ENCRYPTED/i.test(text)) return true;
  const block = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/.exec(text);
  if (block !== null) {
    try {
      // The OpenSSH container names its cipher in the unencrypted header; an
      // unencrypted key stores "none", an encrypted one stores a cipher plus a
      // bcrypt KDF block.
      const raw = Buffer.from(block[1].replace(/\s+/g, ""), "base64").toString("latin1");
      return raw.includes("bcrypt");
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Parse one config file into importable entries.
 *
 * Returns `{ path, exists, entries, warnings }`. Entries are concrete aliases
 * only, de-duplicated by alias with the first block winning (the same way ssh
 * resolves repeated `Host` lines). Authentication kind is derived from whether
 * the block names an IdentityFile; the caller may override it.
 */
export async function scanSshConfig({ home = homedir(), localUser = null } = {}) {
  const path = join(home, ".ssh", "config");
  const warnings = new Set();
  let exists = true;
  try {
    await stat(path);
  } catch {
    exists = false;
    return { path, exists, entries: [], warnings: [] };
  }

  const context = { home, warnings };
  const blocks = [];
  let current = null;
  try {
    for await (const { line, file } of readConfigLines(path, context)) {
      const option = splitOption(line);
      if (option === null) continue;
      if (option.key === "host") {
        const aliases = option.value.split(/\s+/).filter(isConcreteAlias);
        current = { aliases, settings: new Map(), file };
        blocks.push(current);
        continue;
      }
      if (option.key === "match") {
        // Match blocks are conditional rules, not host definitions.
        current = null;
        continue;
      }
      if (current !== null && WANTED.has(option.key) && !current.settings.has(option.key)) {
        current.settings.set(option.key, option.value);
      }
    }
  } catch (error) {
    return { path, exists, entries: [], warnings: [t(`读取 ${path} 失败：${error.message}`)] };
  }

  const entries = [];
  const seenNames = new Set();
  const user = localUser ?? process.env.USER ?? process.env.USERNAME ?? "";
  for (const block of blocks) {
    for (const name of block.aliases) {
      if (seenNames.has(name.toLocaleLowerCase())) continue;
      if (entries.length >= MAX_ENTRIES) {
        warnings.add(t(`条目超过 ${MAX_ENTRIES} 个，剩余主机已跳过。`));
        break;
      }
      const settings = block.settings;
      const rawPort = settings.get("port");
      const port = rawPort === undefined ? 22 : Number.parseInt(rawPort, 10);
      const username = settings.has("user")
        ? expandTokens(settings.get("user"), { home, name, localUser: user })
        : user;
      const host = expandTokens(settings.get("hostname") ?? name, { home, name, username, localUser: user });
      const rawIdentity = settings.get("identityfile");
      const identityExpanded = rawIdentity === undefined
        ? null
        : expandTilde(expandTokens(rawIdentity, { home, host, name, username, localUser: user }), home);
      const identityFilePath = identityExpanded === null
        ? null
        : (isAbsolute(identityExpanded) ? identityExpanded : join(home, identityExpanded));
      const key = await inspectKeyFile(identityFilePath);
      if (key.error !== null) warnings.add(`${name}: ${key.error}`);
      const rawJump = settings.get("proxyjump") ?? null;
      const proxyJump = rawJump === null || rawJump.toLocaleLowerCase() === "none"
        ? null
        : expandTokens(rawJump, { home, host, name, username, localUser: user });
      seenNames.add(name.toLocaleLowerCase());
      entries.push({
        name,
        host,
        port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 22,
        username: username || user || "root",
        identityFilePath,
        keyExists: key.exists,
        keyEncrypted: key.encrypted,
        proxyJump,
        source: block.file
      });
    }
  }
  return { path, exists, entries, warnings: [...warnings] };
}
