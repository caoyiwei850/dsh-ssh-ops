// Self-update runtime resolution and install channel priority, ported from
// @michengai/dsh-archive-manager 1.0.20: desktopProfiles → profileContext /
// official-desktop argv (dsh-desktop-host entry + argv-pnpm via
// ELECTRON_RUN_AS_NODE) → dsh CLI entry, with the install chain
// desktopPnpm → packageManager → pluginManager.installBundle → CLI.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { install, isNewerVersion, registerPluginUpdater, resolveUpdateRuntime, shouldNotifyParent } from "../src/plugin-updater.js";

const NO_SERVICES = { get: () => undefined };
const OFFICIAL_ENTRY = "/Applications/DSH.app/Contents/Resources/app.asar/dsh-desktop-host/main.js";
const NO_ENTRY_ARGV = ["/bin/node", "/bin/definitely-not-a-dsh-entry"];

// ── desktopProfiles service branch (desktop app exposing its services) ──────
{
  const desktopPnpm = { runPlugin: () => ({ done: Promise.resolve({ exitCode: 0 }) }) };
  const target = resolveUpdateRuntime(
    { get: (name) => (name === "desktopProfiles" ? { current: { name: "desktop", dir: "/tmp/prof" } } : name === "desktopPnpm" ? desktopPnpm : undefined) }
  );
  assert.equal(target.profileName, "desktop");
  assert.equal(target.profileDir, resolve("/tmp/prof"));
  assert.equal(target.officialDesktop, false);
  assert.equal(target.canAutoUpdate, true);
  assert.equal(target.desktopPnpm, desktopPnpm);
}
{
  const target = resolveUpdateRuntime(
    { get: (name) => (name === "desktopProfiles" ? { current: { name: "desktop", dir: "/tmp/prof" } } : undefined) }
  );
  assert.equal(target.canAutoUpdate, false, "no desktopPnpm.runPlugin → no auto update");
  assert.equal(target.desktopPnpm, undefined);
}
{
  const target = resolveUpdateRuntime(
    { get: (name) => (name === "desktopProfiles" ? { current: { name: "desktop", dir: "/tmp/prof" } } : name === "desktopPnpm" ? {} : undefined) }
  );
  assert.equal(target.canAutoUpdate, false, "desktopPnpm without runPlugin is not runnable");
}
assert.throws(
  () => resolveUpdateRuntime({ get: (name) => (name === "desktopProfiles" ? { current: { name: "a/b", dir: "/tmp/prof" } } : undefined) }),
  /Desktop Profile/
);
assert.throws(
  () => resolveUpdateRuntime({ get: (name) => (name === "desktopProfiles" ? { current: { name: "desktop", dir: "relative/dir" } } : undefined) }),
  /Desktop Profile/
);

// ── profileContext branch: name/dir come from the service ───────────────────
{
  const target = resolveUpdateRuntime(
    { get: (name) => (name === "profileContext" ? { name: "work", dir: "/tmp/prof-work" } : undefined) },
    {
      argv: [...NO_ENTRY_ARGV, "--profile", "other"],
      env: {},
      exists: () => false
    }
  );
  assert.equal(target.profileName, "work", "service name wins over --profile argv");
  assert.equal(target.profileDir, resolve("/tmp/prof-work"));
  assert.equal(target.officialDesktop, false);
  assert.equal(target.canAutoUpdate, false);
}
{
  const launched = { name: "desktop", dir: "relative/dir", packageManager: { command: "pnpm", args: ["--dir"], env: { FOO: "1", BAD: 2 } } };
  const pluginManager = { installBundle: async () => ({ application: "applied" }) };
  const target = resolveUpdateRuntime(
    { get: (name) => (name === "profileContext" ? launched : name === "pluginManager" ? pluginManager : undefined) },
    { argv: NO_ENTRY_ARGV, env: { DSH_PROFILE_DIR: "/tmp/dshenv" }, exists: () => false }
  );
  assert.equal(target.officialDesktop, true, "profileContext name desktop marks the official host");
  assert.equal(target.profileName, "desktop");
  assert.equal(target.profileDir, resolve("/tmp/dshenv"), "relative service dir falls through to DSH_PROFILE_DIR");
  assert.deepEqual(target.packageManager, { command: "pnpm", args: ["--dir"], env: { FOO: "1" } }, "non-string env entries dropped");
  assert.equal(target.pluginManager, undefined, "pluginManager not consulted while packageManager exists");
  assert.equal(target.canAutoUpdate, true);
}

// ── official desktop host via argv[1] + the argv-pnpm channel ───────────────
const scratch = mkdtempSync(join(tmpdir(), "dsh-ssh-ops-updater-"));
try {
  const pnpmDir = join(scratch, "pnpm-bin");
  mkdirSync(pnpmDir);
  const pnpmCli = join(pnpmDir, "pnpm.cjs");
  writeFileSync(pnpmCli, "");

  {
    const argv = ["/fake/Electron", OFFICIAL_ENTRY, "ignored", "/Users/x/.dsh/profiles/desktop", "ignored", pnpmCli, pnpmDir];
    const target = resolveUpdateRuntime(NO_SERVICES, { argv, env: { PATH: "/usr/bin" }, exists: existsSync, execPath: "/fake/Electron" });
    assert.equal(target.officialDesktop, true);
    assert.equal(target.profileName, "desktop", "official host without a recognizable name still says desktop");
    assert.equal(target.profileDir, resolve("/Users/x/.dsh/profiles/desktop"), "argv[3] is the profile dir");
    assert.deepEqual(target.packageManager, {
      command: "/fake/Electron",
      args: ["--expose-internals", pnpmCli],
      env: { ELECTRON_RUN_AS_NODE: "1", PATH: `${pnpmDir}${delimiter}/usr/bin` }
    });
    assert.equal(target.canAutoUpdate, true);
  }
  {
    const pluginManager = { installBundle: async () => ({ application: "applied" }) };
    const target = resolveUpdateRuntime(
      { get: (name) => (name === "pluginManager" ? pluginManager : undefined) },
      { argv: ["/fake/Electron", OFFICIAL_ENTRY], env: {}, exists: () => false }
    );
    assert.equal(target.officialDesktop, true);
    assert.equal(target.packageManager, undefined, "no pnpm in argv → no argv channel");
    assert.equal(target.pluginManager, pluginManager);
    assert.equal(target.canAutoUpdate, true);
  }
  {
    const target = resolveUpdateRuntime(NO_SERVICES, { argv: ["/fake/Electron", OFFICIAL_ENTRY], env: {}, exists: () => false });
    assert.equal(target.canAutoUpdate, false, "official host without any channel cannot auto update");
    assert.equal(target.cliEntry, undefined, "CLI entry never consulted on the official host");
  }

  // ── dsh CLI entry channel (web hosts): walk up to the @deepseek-ai/dsh bin ──
  const cliRoot = join(scratch, "fake-dsh");
  mkdirSync(cliRoot);
  const cliJs = join(cliRoot, "dsh.js");
  writeFileSync(cliJs, "process.exit(process.argv.includes('fail') ? 1 : 0)\n");
  writeFileSync(join(cliRoot, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", bin: { dsh: "./dsh.js" } }));
  {
    const target = resolveUpdateRuntime(NO_SERVICES, { argv: ["/bin/node", cliJs, "--profile", "alpha"], env: {} });
    assert.equal(target.cliEntry, cliJs);
    assert.equal(target.profileName, "alpha");
    assert.equal(target.canAutoUpdate, true);
  }
  {
    const target = resolveUpdateRuntime(NO_SERVICES, { argv: ["/bin/node", cliJs], env: { DSH_PROFILE_DIR: "/tmp/envdir" }, homeDir: "/tmp/fakehome" });
    assert.equal(target.profileDir, resolve("/tmp/envdir"), "DSH_PROFILE_DIR wins over the web default");
    assert.equal(target.profileName, "envdir", "profile name falls back to the dir basename");
  }
  {
    const target = resolveUpdateRuntime(NO_SERVICES, { argv: ["/bin/node", join(scratch, "not-a-cli.js")], env: {}, homeDir: "/tmp/fakehome" });
    assert.equal(target.canAutoUpdate, false, "a random entry script is not the dsh CLI");
    assert.equal(target.profileName, "web");
    assert.equal(target.profileDir, resolve("/tmp/fakehome/.dsh/profiles/web"));
  }

  // ── install channel priority: desktopPnpm → packageManager → pluginManager ──
  {
    const target = {
      profileName: "p",
      profileDir: scratch,
      desktopPnpm: { runPlugin: (args, dir) => ({ done: Promise.resolve({ exitCode: 0, args, dir }) }) },
      packageManager: { command: process.execPath, args: ["-e", "process.exit(7)"] },
      pluginManager: { installBundle: async () => { throw new Error("must not run"); } },
      cliEntry: join(cliRoot, "would-run.js")
    };
    await install(target, "dsh-ssh-ops@9.9.9");
  }
  await assert.rejects(
    install({ profileName: "p", profileDir: scratch, desktopPnpm: { runPlugin: () => ({ done: Promise.resolve({ exitCode: 5 }) }) } }, "dsh-ssh-ops@9.9.9"),
    /5/
  );
  {
    let ran = false;
    const target = {
      profileName: "p",
      profileDir: scratch,
      packageManager: { command: process.execPath, args: ["-e", "process.exit(0)"], env: {} },
      pluginManager: { installBundle: async () => { ran = true; } },
      cliEntry: join(cliRoot, "would-run.js")
    };
    await install(target, "dsh-ssh-ops@9.9.9");
    assert.equal(ran, false, "packageManager beats pluginManager");
  }
  await assert.rejects(
    install({ profileName: "p", profileDir: scratch, packageManager: { command: process.execPath, args: ["-e", "process.exit(3)"], env: {} } }, "dsh-ssh-ops@9.9.9"),
    /3/
  );
  for (const application of ["applied", "restart-required", "overridden"]) {
    let spec;
    await install({ pluginManager: { installBundle: async (value) => { spec = value; return { application }; } } }, "dsh-ssh-ops@9.9.9");
    assert.equal(spec, "dsh-ssh-ops@9.9.9");
  }
  await assert.rejects(
    install({ pluginManager: { installBundle: async () => ({ application: "failed", error: { message: "boom" } }) } }, "dsh-ssh-ops@9.9.9"),
    /boom/
  );
  await assert.rejects(
    install({ pluginManager: { installBundle: async () => ({ application: "failed", packageResult: { output: "install output" } }) } }, "dsh-ssh-ops@9.9.9"),
    /install output/
  );
  await install({ profileName: "p", profileDir: scratch, cliEntry: cliJs }, "dsh-ssh-ops@9.9.9");
  await assert.rejects(
    install({ profileName: "p", profileDir: scratch, cliEntry: cliJs }, "fail"),
    /退出码 1/
  );
  await assert.rejects(
    install({}, "dsh-ssh-ops@9.9.9"),
    /不支持自动更新/
  );

  // ── shouldNotifyParent: only plain web hosts started by a parent ────────────
  assert.equal(shouldNotifyParent({}, () => {}), true);
  assert.equal(shouldNotifyParent({ officialDesktop: true }, () => {}), false);
  assert.equal(shouldNotifyParent({ desktopPnpm: {} }, () => {}), false);
  assert.equal(shouldNotifyParent({ packageManager: {} }, () => {}), false);
  assert.equal(shouldNotifyParent({}, undefined), false, "no IPC channel → nothing to notify");

  // ── endpoint wiring: status payload + trust gate ────────────────────────────
  const manifestPath = join(scratch, "package.json");
  writeFileSync(manifestPath, JSON.stringify({ version: "1.0.0" }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ version: "9.9.9" }) });
  try {
    let handler;
    registerPluginUpdater(
      { webServer: { register: (descriptor) => { handler = descriptor.handler; return () => {}; } }, get: () => undefined },
      { endpoint: "/api/test/update", packageName: "test-pkg", manifestUrl: pathToFileURL(manifestPath) }
    );
    const response = { code: 0, headers: undefined, body: undefined, writeHead(code, headers) { this.code = code; this.headers = headers; }, end(body) { this.body = body; } };
    await handler({ method: "GET", headers: {} }, response);
    assert.equal(response.code, 200);
    const payload = JSON.parse(response.body);
    assert.equal(payload.packageName, "test-pkg");
    assert.equal(payload.currentVersion, "1.0.0");
    assert.equal(payload.latestVersion, "9.9.9");
    assert.equal(payload.updateAvailable, true);
    assert.equal(payload.canAutoUpdate, false);
    assert.equal(payload.profileName, "web");
    await handler({ method: "POST", headers: {}, socket: { remoteAddress: "127.0.0.1" } }, response);
    assert.equal(response.code, 403, "untrusted POST is refused");
  } finally {
    globalThis.fetch = originalFetch;
  }

  // ── semver comparison keeps its prerelease semantics ────────────────────────
  assert.equal(isNewerVersion("0.3.22", "0.3.23"), true);
  assert.equal(isNewerVersion("1.0.0", "1.0.0"), false);
  assert.equal(isNewerVersion("1.0.0-alpha.1", "1.0.0"), true, "rc install is offered the stable of the same core");
  assert.equal(isNewerVersion("1.0.0", "1.0.0-beta"), false);
  assert.equal(isNewerVersion("1.0.0-alpha", "1.0.0-alpha.1"), true);
  assert.equal(isNewerVersion("1.0.0", "not-a-version"), false);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
