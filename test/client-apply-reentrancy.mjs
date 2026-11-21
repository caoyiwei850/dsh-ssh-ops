/**
 * Issue #37 regression: the client entry's apply() must be reentrant.
 *
 * The host retries a FAILED plugin by running apply() again WITHOUT a
 * teardown in between. The pre-fix entry guarded only the remote $mount, so
 * a throw anywhere later (dictionary registration, slots, sidebar wiring) lost
 * the disposer list: the locale dictionaries stayed registered and every
 * retry died on
 *   `locale namespace "ssh-ops" already has locale "zh"`
 * — burying the original error until a full page reload (issue #37).
 *
 * The contract under test is plugin-side, so the retry is exercised by
 * re-invoking entry.apply() on the SAME mock faces — exactly what the host's
 * fiber.update() does to the plugin (verified against the host's cordis
 * 4.0.5; the devDependency's 4.0.2 fiber.update() has racy await semantics
 * and is deliberately not used here).
 */
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The entry only references the three surface components (it never renders
// them during apply), and their import graph pulls the whole panel + xterm.
const stubSurfaceComponents = {
  name: "stub-surface-components",
  setup(build) {
    build.onResolve({ filter: /(IconTerminal16|SshSidebarBody|SshResources)\.jsx$/ }, (args) => ({
      path: args.path,
      namespace: "surface-stub"
    }));
    build.onLoad({ filter: /\.jsx$/, namespace: "surface-stub" }, (args) => {
      const name = args.path.replace(/^\.\//, "").replace(/\.jsx$/, "");
      return { contents: `export const ${name} = function ${name}() { return null; }`, loader: "jsx" };
    });
  }
};

// Bundled into a scratch dir under node_modules/.cache: invisible to git,
// lint and packaging, yet close enough to the repo root that the external
// `react` import still resolves from the repo's node_modules.
const scratchRoot = join(root, "node_modules/.cache");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "client-apply-reentrancy-"));
try {
  const outfile = join(scratch, "entry.mjs");
  await build({
    entryPoints: [join(root, "src/client/index.jsx")],
    outfile,
    format: "esm",
    platform: "browser",
    target: "es2022",
    bundle: true,
    external: ["react", "react/*"],
    plugins: [stubSurfaceComponents],
    logLevel: "silent"
  });
  const entry = await import(pathToFileURL(outfile).href);

  // ── Host-shaped faces ──────────────────────────────────────────────────
  // locale: same contract as dsh-client-locale — a duplicate key in the same
  // namespace throws (the exact error the issue reports), and an empty
  // namespace map stays behind after rollback the way the host's does.
  function makeLocaleFace() {
    const dicts = new Map();
    return {
      dicts,
      register(namespace, entries) {
        const existing = dicts.get(namespace);
        if (existing) {
          for (const key of Object.keys(entries)) {
            if (existing.has(key)) {
              throw new Error(`locale namespace "${namespace}" already has locale "${key}"`);
            }
          }
        }
        const target = existing ?? new Map();
        dicts.set(namespace, target);
        for (const [key, value] of Object.entries(entries)) target.set(key, value);
        return () => { for (const key of Object.keys(entries)) target.delete(key); };
      },
      bind: () => () => null
    };
  }

  function makeRemoteFace() {
    const unmounts = [];
    return { unmounts, $mount: async () => () => { unmounts.push(1); } };
  }

  function makeSlotsFace(failSettingsSection) {
    const injections = [];
    return {
      injections,
      inject(name) {
        if (name === "settings.section" && failSettingsSection()) {
          throw new Error("boom: settings.section unavailable");
        }
        injections.push(name);
        return () => { injections.splice(injections.indexOf(name), 1); };
      },
      register: () => () => {}
    };
  }

  // A host that never provides the Sidebar services: the delayed lifecycle
  // registers a watcher and nothing more — a legitimate shape.
  function makeCtx({ locale, remote, slots }) {
    return {
      locale,
      remote,
      slots,
      inject: () => () => {}
    };
  }

  const dictionaryCount = (locale) => locale.dicts.get("ssh-ops")?.size ?? 0;

  // The client entry must coalesce startup notifications and settle even if
  // persisting a language causes the host to publish its locale again (#58).
  {
    const locale = makeLocaleFace();
    const remote = makeRemoteFace();
    let active = "zh";
    let stored = "zh";
    let pinned = false;
    let listener;
    let reads = 0;
    let saveInFlight;
    const writes = [];
    locale.getSnapshot = () => ({ active });
    locale.subscribe = (callback) => {
      listener = callback;
      return () => { listener = undefined; };
    };
    const response = (value) => ({ ok: true, value: { ok: true, value } });
    remote.namespaces = new Map([["sshOps", { service: {
      async languageGet() {
        reads++;
        return response({ language: stored, autoApplySystemLanguage: !pinned });
      },
      async languageSave({ language }) {
        writes.push(language);
        if (saveInFlight) await saveInFlight;
        stored = language;
        // Cap the simulated feedback so the unfixed event loop can drain.
        if (writes.length < 12) listener?.();
        return response({ language });
      }
    } }]]);
    const teardown = await entry.apply(makeCtx({ locale, remote, slots: makeSlotsFace(() => false) }));
    try {
      for (let i = 0; i < 8; i++) listener();
      await setImmediate();
      assert.deepEqual({ reads, writes }, { reads: 1, writes: [] }, "startup events must share one read and skip saving an equal language");

      active = "en";
      for (let i = 0; i < 8; i++) listener();
      await setImmediate();
      listener();
      await setImmediate();
      assert.deepEqual({ reads, writes }, { reads: 2, writes: ["en"] }, "a locale change writes once despite the echoed event");

      let releaseSave;
      saveInFlight = new Promise((resolve) => { releaseSave = resolve; });
      active = "zh";
      listener();
      await setImmediate();
      assert.deepEqual(writes, ["en", "zh"], "switching back to a previously saved language still persists");
      active = "en";
      listener();
      await setImmediate();
      assert.deepEqual(writes, ["en", "zh"], "writes must not overlap during a rapid switch");
      saveInFlight = undefined;
      releaseSave();
      await setImmediate();
      assert.deepEqual(writes, ["en", "zh", "en"], "the latest language is persisted after the in-flight write");

      pinned = true;
      active = "zh";
      listener();
      await setImmediate();
      assert.deepEqual(writes, ["en", "zh", "en"], "a stored language pin suppresses follow-mode writes");
    } finally {
      await teardown();
    }
    assert.equal(listener, undefined, "unloading removes the locale subscription");
  }

  // ── Scenario A: a transient mid-apply failure must not poison the retry ──
  {
    let failing = true;
    const locale = makeLocaleFace();
    const remote = makeRemoteFace();
    const slots = makeSlotsFace(() => failing);
    const ctx = makeCtx({ locale, remote, slots });

    let firstError = null;
    try {
      await entry.apply(ctx);
    } catch (error) {
      firstError = error;
    }
    assert.match(firstError?.message ?? "", /boom: settings\.section unavailable/,
      "the FIRST failure must surface the real cause, not a dictionary complaint");
    assert.doesNotMatch(firstError?.message ?? "", /already has locale/,
      "even the first failure must not be a stale duplicate-registration error");
    assert.equal(dictionaryCount(locale), 0,
      "the locale dictionaries must be rolled back when apply fails (issue #37 residue)");
    assert.equal(remote.unmounts.length, 1,
      "the mounted remote namespace is unwound with everything else");
    assert.deepEqual(slots.injections, [],
      "the settings-section injection is unwound with everything else");

    // Host retry: apply() again on the same faces, no teardown in between.
    failing = false;
    const teardown = await entry.apply(ctx);
    assert.deepEqual([...locale.dicts.get("ssh-ops")?.keys() ?? []], ["zh", "en"],
      "after recovery the dictionaries are registered exactly once, in both languages");
    assert.deepEqual(slots.injections, ["settings.section.icon", "settings.section"],
      "the settings section is registered again after recovery");

    // Teardown stays symmetric (existing behavior preserved).
    await teardown();
    assert.equal(dictionaryCount(locale), 0, "a normal teardown still removes the dictionaries");
    assert.equal(remote.unmounts.length, 2, "a normal teardown still unmounts the remote namespace");
    assert.deepEqual(slots.injections, [], "a normal teardown still removes the slot injection");
  }

  // ── Scenario B: a persistent failure keeps reporting the REAL error ──────
  {
    const locale = makeLocaleFace();
    const remote = makeRemoteFace();
    const slots = makeSlotsFace(() => true);
    const ctx = makeCtx({ locale, remote, slots });

    let firstError = null;
    try {
      await entry.apply(ctx);
    } catch (error) {
      firstError = error;
    }
    let retryError = null;
    try {
      await entry.apply(ctx);
    } catch (error) {
      retryError = error;
    }
    assert.match(firstError?.message ?? "", /boom: settings\.section unavailable/,
      "the first failure surfaces the real cause");
    assert.match(retryError?.message ?? "", /boom: settings\.section unavailable/,
      "the retry must re-report the original error…");
    assert.doesNotMatch(retryError?.message ?? "", /already has locale/,
      "…and never the misleading duplicate-registration error (issue #37)");
    assert.equal(dictionaryCount(locale), 0,
      "every failed apply leaves no residue behind");
  }

  // Host remote proxies throw on access to services without injection. Both
  // registered surface providers must still render on hosts lacking them.
  {
    const descriptors = new Map();
    const remote = new Proxy(makeRemoteFace(), { get(target, key) {
      if (key === "pluginManager") throw new Error('cannot get property "remote.pluginManager" without inject');
      return target[key];
    } });
    const slots = {
      inject(_name, callback) { callback(); return () => {}; },
      register(descriptor) { descriptors.set(descriptor.name, descriptor); return () => {}; }
    };
    const ctx = makeCtx({ locale: makeLocaleFace(), remote, slots });
    ctx.sidebarRightTabs = { register: () => () => {} };
    ctx.sidebarRight = { openTab() {}, isExpanded: () => false, active: () => null };
    ctx.inject = (services, callback) => { if (services.includes("sidebarRight")) callback(ctx); return () => {}; };
    const dispose = await entry.apply(ctx);
    for (const name of ["settings.section", "sidebar.right.pane.tab"]) {
      assert.ok(descriptors.has(name), `${name} was registered`);
      assert.doesNotThrow(() => descriptors.get(name).inject(), `${name} renders without optional services`);
    }
    await dispose();
  }

  console.log("client apply reentrancy (#37): failure rolls back, retry re-reports the real error: passed");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
