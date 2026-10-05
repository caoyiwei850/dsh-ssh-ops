/**
 * Self-update endpoint for the plugin's settings page: version check against
 * the npm registry plus a trusted one-click install.
 *
 * Adapted from @michengai/dsh-archive-manager's plugin-updater (Apache-2.0) —
 * same trust model (loopback + same-origin + plugin header), same desktop
 * pnpm / dsh-CLI install channels, messages routed through our i18n t().
 *
 * GET  → { packageName, currentVersion, latestVersion?, latestCheckFailed,
 *          updateAvailable, profileName, canAutoUpdate }
 * POST → runs the install (only from the trusted page), then reports
 *        { ..., updatedVersion, restartRequired: true, autoReload }.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { t } from "./i18n/core.js";

export const UPDATE_ENDPOINT = "/api/dsh-ssh-ops/update";
const UPDATE_HEADER = "x-dsh-ssh-ops-update";
const UPDATE_IPC = "apply-plugin-updates";

function header(request, name) {
  const value = request.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function isLoopbackAddress(value) {
  const address = value?.toLowerCase().replace(/^\[|\]$/g, "");
  return address === "localhost" || address === "localhost." || address === "::1"
    || address?.startsWith("127.") === true || address?.startsWith("::ffff:127.") === true;
}

/** Only the plugin's own settings page, served from this machine, may POST. */
function isTrustedUpdateRequest(request) {
  if (header(request, UPDATE_HEADER) !== "1") return false;
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false;
  const site = header(request, "sec-fetch-site");
  if (site !== undefined && site !== "same-origin") return false;
  const origin = header(request, "origin");
  const host = header(request, "host");
  if (origin === undefined || host === undefined) return false;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:")
      && isLoopbackAddress(url.hostname) && url.host === host;
  } catch {
    return false;
  }
}

function validProfileName(value) {
  return typeof value === "string" && value !== "" && value !== "." && value !== ".."
    && !value.includes("/") && !value.includes("\\") && !/[\0-\x1f\x7f]/.test(value);
}

function profileNameFromArgv(argv) {
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--profile") return argv[index + 1];
    if (argv[index]?.startsWith("--profile=")) return argv[index].slice("--profile=".length);
  }
  return argv[2] === "web" ? "web" : undefined;
}

function isDshCliEntry(entry, manifest, packageRoot) {
  if (typeof manifest !== "object" || manifest === null) return false;
  if (manifest.name !== "@deepseek-ai/dsh") return false;
  const bin = typeof manifest.bin === "string" ? manifest.bin
    : typeof manifest.bin === "object" && manifest.bin !== null && "dsh" in manifest.bin ? manifest.bin.dsh
      : undefined;
  return typeof bin === "string" && bin !== "" && !isAbsolute(bin) && resolve(packageRoot, bin) === resolve(entry);
}

/** Walk up from the running entry to find the dsh CLI bin, if we are it. */
function cliEntry() {
  const value = process.argv[1];
  if (value === undefined || value === "") return undefined;
  const entry = value.startsWith("file:") ? fileURLToPath(value) : resolve(process.cwd(), value);
  if (!existsSync(entry)) return undefined;
  for (let directory = dirname(entry);;) {
    const manifestPath = resolve(directory, "package.json");
    if (existsSync(manifestPath)) {
      try {
        if (isDshCliEntry(entry, JSON.parse(readFileSync(manifestPath, "utf8")), directory)) return entry;
      } catch {}
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** Where this profile lives and which install channel it supports. */
function runtime(ctx) {
  const profiles = ctx.get?.("desktopProfiles");
  const desktopPnpm = ctx.get?.("desktopPnpm");
  if (profiles?.current !== undefined) {
    const current = profiles.current;
    if (!validProfileName(current.name) || typeof current.dir !== "string" || !isAbsolute(current.dir)) {
      throw new Error(t("当前 Desktop Profile 信息无效，请重启后重试。"));
    }
    return {
      profileName: current.name,
      profileDir: resolve(current.dir),
      ...(typeof desktopPnpm?.runPlugin === "function" ? { desktopPnpm } : {})
    };
  }
  const profileDir = resolve(process.env.DSH_PROFILE_DIR ?? resolve(homedir(), ".dsh", "profiles", "web"));
  const selected = profileNameFromArgv(process.argv);
  const profileName = validProfileName(selected) ? selected : validProfileName(basename(profileDir)) ? basename(profileDir) : "web";
  const entry = cliEntry();
  return { profileName, profileDir, ...(entry === undefined ? {} : { cliEntry: entry }) };
}

function parseSemver(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (match === null) return undefined;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4]?.split(".") ?? [] };
}

function comparePrerelease(left, right) {
  if (left.length === 0 || right.length === 0) return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      const aNumber = BigInt(a);
      const bNumber = BigInt(b);
      if (aNumber !== bNumber) return aNumber > bNumber ? 1 : -1;
      continue;
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a > b ? 1 : -1;
  }
  return 0;
}

export function isNewerVersion(currentValue, candidateValue) {
  const current = parseSemver(currentValue);
  const candidate = parseSemver(candidateValue);
  if (current === undefined || candidate === undefined) return false;
  for (let index = 0; index < 3; index += 1) {
    if (candidate.core[index] !== current.core[index]) return candidate.core[index] > current.core[index];
  }
  return comparePrerelease(candidate.prerelease, current.prerelease) > 0;
}

let latestCache;

async function latestVersion(packageName) {
  if (latestCache?.packageName === packageName && Date.now() < latestCache.expiresAt) return latestCache.version;
  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return undefined;
    const value = await response.json();
    if (typeof value.version !== "string" || value.version === "") return undefined;
    latestCache = { packageName, version: value.version, expiresAt: Date.now() + 5 * 60000 };
    return value.version;
  } catch {
    return undefined;
  }
}

async function currentVersion(manifestUrl) {
  const value = JSON.parse(await readFile(manifestUrl, "utf8"));
  if (typeof value.version !== "string" || value.version === "") throw new Error(t("无法读取当前插件版本。"));
  return value.version;
}

async function status(options, target) {
  const current = await currentVersion(options.manifestUrl);
  const latest = await latestVersion(options.packageName);
  return {
    packageName: options.packageName,
    currentVersion: current,
    ...(latest === undefined ? {} : { latestVersion: latest }),
    latestCheckFailed: latest === undefined,
    updateAvailable: latest !== undefined && isNewerVersion(current, latest),
    profileName: target.profileName,
    canAutoUpdate: target.desktopPnpm !== undefined || target.cliEntry !== undefined
  };
}

async function runCliInstall(target, packageSpec) {
  if (target.cliEntry === undefined) throw new Error(t("当前环境不支持自动更新，请使用手动更新命令。"));
  const entry = target.cliEntry;
  await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entry, "plugin", "--profile", target.profileName, "add", "--config.minimumReleaseAge=0", packageSpec, "--registry=https://registry.npmjs.org/"], {
      cwd: target.profileDir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" }
    });
    let detail = "";
    child.stdout?.on("data", (chunk) => { detail = (detail + String(chunk)).slice(-4000); });
    child.stderr?.on("data", (chunk) => { detail = (detail + String(chunk)).slice(-4000); });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(t("更新超时，请改用手动更新。")));
    }, 10 * 60000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(detail.trim() || t(`更新进程退出码 ${code}`)));
    });
  });
}

async function install(target, packageSpec) {
  if (target.desktopPnpm === undefined) return runCliInstall(target, packageSpec);
  const handle = target.desktopPnpm.runPlugin(["add", "--config.minimumReleaseAge=0", packageSpec, "--registry=https://registry.npmjs.org/"], target.profileDir);
  const result = await handle.done;
  if (result.exitCode !== 0) throw new Error(t(`更新进程退出码 ${result.exitCode}`));
}

function json(response, statusCode, value) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

/** Error text for the wire: never leak local paths. */
function publicError(error) {
  const message = error instanceof Error ? error.message : t("更新暂不可用。");
  return /[A-Za-z]:[\\/]|\/(?:home|root|Users|var|tmp)\//.test(message) ? t("更新失败，请查看服务端日志。") : message;
}

/**
 * Register the update endpoint on the host web server. The returned disposer
 * removes the route when the plugin unloads.
 */
export function registerPluginUpdater(ctx, options) {
  let installing = false;
  return ctx.webServer.register({
    kind: "exact",
    path: options.endpoint,
    handler: async (request, response) => {
      try {
        const target = runtime(ctx);
        if (request.method === "GET" || request.method === "HEAD") {
          const payload = await status(options, target);
          response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          response.end(request.method === "HEAD" ? undefined : JSON.stringify(payload));
          return;
        }
        if (request.method !== "POST") {
          response.writeHead(405, { allow: "GET, HEAD, POST" });
          response.end();
          return;
        }
        if (!isTrustedUpdateRequest(request)) {
          json(response, 403, { error: t("已拒绝非本机同源更新请求。") });
          return;
        }
        if (installing) {
          json(response, 409, { error: t("当前插件正在更新，请稍候。") });
          return;
        }
        const before = await status(options, target);
        if (before.latestVersion === undefined) {
          json(response, 503, { error: t("暂时无法获取最新版本。") });
          return;
        }
        if (!before.updateAvailable) {
          json(response, 200, before);
          return;
        }
        installing = true;
        try {
          await install(target, `${options.packageName}@${before.latestVersion}`);
        } finally {
          installing = false;
        }
        const notifyParent = target.desktopPnpm === undefined && typeof process.send === "function";
        const autoReload = target.desktopPnpm !== undefined || notifyParent;
        json(response, 200, { ...before, updatedVersion: before.latestVersion, restartRequired: true, autoReload });
        if (notifyParent) setTimeout(() => { process.send?.(UPDATE_IPC); }, 150).unref?.();
      } catch (error) {
        ctx.logger?.warn?.(`plugin updater failed: ${String(error)}`);
        json(response, 503, { error: publicError(error) });
      }
    }
  });
}
