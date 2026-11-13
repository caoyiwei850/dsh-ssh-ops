import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const SSH_IMPORT_LIMIT = 500;
const CONFIG_BYTES = 1024 * 1024;

function matcher(pattern) {
  const rule = pattern.toLowerCase();
  return {
    test(value) {
      const name = value.toLowerCase();
      let at = 0;
      let next = 0;
      let star = -1;
      let retry = 0;
      while (at < name.length) {
        if (rule[next] === "*") {
          star = next++;
          retry = at;
        } else if (rule[next] === "?" || rule[next] === name[at]) {
          at++;
          next++;
        } else if (star !== -1) {
          next = star + 1;
          at = ++retry;
        } else {
          return false;
        }
      }
      return /^\**$/.test(rule.slice(next));
    }
  };
}

async function readConfig(file, state, depth = 0) {
  if (depth > 8 || ++state.files > 128) throw new Error("SSH configuration includes too many files");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  let text;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > state.remaining) throw new Error("SSH configuration exceeds the input limit");
    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > info.size) throw new Error("SSH configuration changed while reading");
    state.remaining -= bytesRead;
    text = buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
  let hostSection = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const option = /^([a-z][a-z0-9]*)\s*(?:=\s*|\s+)(.+)$/i.exec(line);
    if (!option) continue;
    const key = option[1].toLowerCase();
    const args = (option[2].match(/"(?:[^"\\]|\\.)*"|[^\s"#]+|#/g) ?? []);
    const comment = args.indexOf("#");
    if (comment !== -1) args.length = comment;
    const values = args.map((value) => value.replace(/^"(.*)"$/, "$1"));
    if (key === "host") hostSection = true;
    if (key === "match") throw new Error("SSH configurations containing Match are not supported");
    if (key !== "include") {
      if (key === "host") {
        const positive = values.filter((value) => !value.startsWith("!")).map(matcher);
        const negative = values.filter((value) => value.startsWith("!")).map((value) => matcher(value.slice(1)));
        state.options.push({ key, values, matches: (name) => positive.some((rule) => rule.test(name)) && !negative.some((rule) => rule.test(name)) });
      } else {
        state.options.push({ key, values });
      }
      continue;
    }
    if (hostSection) throw new Error("Conditional SSH Include is not supported");
    for (const value of values) {
      const path = resolve(state.directory, value.replace(/^~[/\\]/, state.home + "/"));
      const folder = dirname(path);
      const pattern = basename(path);
      if (/[*?[\]]/.test(folder) || /[[\]]/.test(pattern)) throw new Error("Unsupported SSH Include pattern");
      const paths = /[*?]/.test(pattern)
        ? (await readdir(folder).catch((error) => { if (error.code === "ENOENT") return []; throw error; }))
          .filter((name) => (!name.startsWith(".") || pattern.startsWith(".")) && matcher(pattern).test(name)).sort().map((name) => join(folder, name))
        : [path];
      for (const included of paths) {
        state.options.push({ key: "include-start", values: [] });
        try { await readConfig(included, state, depth + 1); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        state.options.push({ key: "include-end", values: [] });
      }
    }
  }
}

export async function scanOpenSshConfig({ home = homedir(), username = userInfo().username } = {}) {
  const directory = join(home, ".ssh");
  const state = { home, directory, files: 0, remaining: CONFIG_BYTES, options: [] };
  try { await readConfig(join(directory, "config"), state); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }

  const aliases = new Map();
  for (const { key, values } of state.options) {
    if (key !== "host") continue;
    for (const name of values) {
      if (/^[\w.:@-]{1,120}$/.test(name) && !aliases.has(name.toLowerCase())) aliases.set(name.toLowerCase(), name);
    }
  }
  if (aliases.size > SSH_IMPORT_LIMIT) throw new Error("SSH configuration contains more than 500 hosts");

  return [...aliases.values()].map((name) => {
    const settings = new Map();
    let active = true;
    const includeScopes = [];
    for (const { key, values, matches } of state.options) {
      if (key === "include-start") {
        includeScopes.push(active);
      } else if (key === "include-end") {
        active = includeScopes.pop();
      } else if (key === "host") {
        active = matches(name);
      } else if (active && values.length && !settings.has(key)) {
        settings.set(key, values[0]);
      }
    }

    const host = (settings.get("hostname") ?? name).replaceAll("%h", name);
    const user = settings.get("user") ?? username;
    const rawPort = settings.get("port") ?? "22";
    const port = /^\d+$/.test(rawPort) ? Number(rawPort) : 0;
    const validPort = Number.isInteger(port) && port >= 1 && port <= 65535;
    const jump = settings.get("proxyjump") ?? "none";
    const hops = jump.toLowerCase() === "none" ? [] : jump.split(",");
    const proxy = settings.get("proxycommand");
    const issues = [];
    if (!host || host.length > 255 || /[%\s]/.test(host)) issues.push("HostName");
    if (!user || user.length > 128 || /[%\s]/.test(user)) issues.push("User");
    if (!validPort) issues.push("Port");
    if (proxy && proxy.toLowerCase() !== "none") issues.push("ProxyCommand");
    if (settings.get("canonicalizehostname") && settings.get("canonicalizehostname").toLowerCase() !== "no") issues.push("CanonicalizeHostname");
    if (hops.length > 8 || hops.some((hop) => !/^[\w.-]+$/.test(hop))) issues.push("ProxyJump");
    return { name, host, username: user, port: validPort ? port : 22, hops, issues, unsupported: issues.length > 0, authKind: settings.has("identityfile") ? "key" : "password" };
  });
}
