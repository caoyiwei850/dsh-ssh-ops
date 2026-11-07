import { acquireTestMatcher } from "./helpers/highlight-worker.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import xterm from "@xterm/xterm";
import { createDisplaySettings, getDisplaySettings, setDisplaySettings, setDisplayColor, resetDisplayColors, saveDisplayRule, deleteDisplayRule, moveDisplayRule, setDisplayBackground, resetDisplayBackground, resetDisplayBackgrounds } from "../src/client/terminal-display/settings.js";
import { OutputHighlightAddon } from "../src/client/terminal-display/addon.js";
import { COLORS, LIGHT_COLORS } from "../src/client/terminal-display/rules.js";
import { DARK_THEME, LIGHT_THEME, resolveDisplayTheme, terminalTheme } from "../src/client/terminal-display/theme.js";
const KEY = "dsh-ssh-ops.terminal-display.v1";
function fixture(entries = {}) {
  const values = new Map(Object.entries(entries)), listeners = new Set();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  const eventTarget = { addEventListener: (_name, fn) => listeners.add(fn), removeEventListener: (_name, fn) => listeners.delete(fn) };
  return { storage, eventTarget, listeners, dispatch: (value, key = KEY) => {
    if (value === null) storage.removeItem(KEY); else storage.setItem(KEY, value);
    for (const fn of listeners) fn({ key, newValue: value, storageArea: storage });
  } };
}
test("migrate the previous highlight preference and persist both settings together", () => {
  const f = fixture({ "dsh-ssh-ops.private-output-highlight.enabled": "false" });
  const store = createDisplaySettings(f);
  assert.deepEqual(store.getSnapshot(), { highlightEnabled: false, theme: "system" });
  store.update({ theme: "light" });
  assert.deepEqual(createDisplaySettings(f).getSnapshot(), { highlightEnabled: false, theme: "light" });
  store.update({ highlightEnabled: true });
  assert.deepEqual(JSON.parse(f.storage.getItem(KEY)), { highlightEnabled: true, theme: "light" });
});
test("stable snapshots, multiple subscribers, other-window updates and clear", () => {
  const f = fixture(), store = createDisplaySettings(f);
  let updates = 0;
  const a = store.subscribe(() => updates++), b = store.subscribe(() => updates++);
  const first = store.getSnapshot();
  store.update({ theme: "system" }); assert.equal(store.getSnapshot(), first);
  store.update({ theme: "light" }); assert.equal(updates, 2);
  f.dispatch(JSON.stringify({ highlightEnabled: false, theme: "dark" }));
  assert.deepEqual(store.getSnapshot(), { highlightEnabled: false, theme: "dark" });
  assert.equal(updates, 4);
  f.dispatch(null, null); assert.deepEqual(store.getSnapshot(), { highlightEnabled: false, theme: "system" });
  a(); b(); assert.equal(f.listeners.size, 0);
});
test("invalid stored settings degrade safely and blocked storage stays usable", () => {
  for (const value of ["{broken", 'null', '{"theme":"unknown","highlightEnabled":true}']) {
    assert.deepEqual(createDisplaySettings(fixture({ [KEY]: value })).getSnapshot(), { highlightEnabled: false, theme: "system" });
  }
  const store = createDisplaySettings({ storage: { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } }, eventTarget: {} });
  const stop = store.subscribe(() => {});
  store.update({ theme: "light", highlightEnabled: false });
  assert.deepEqual(store.getSnapshot(), { highlightEnabled: false, theme: "light" }); stop();
});

test("resubscribing observes storage deletion and keeps unsaved changes after quota errors", () => {
  const f = fixture({ [KEY]: JSON.stringify({ theme: "light", highlightEnabled: false }) });
  const store = createDisplaySettings(f);
  store.subscribe(() => {})();
  f.storage.removeItem(KEY);
  const stop = store.subscribe(() => {});
  assert.deepEqual(store.getSnapshot(), { theme: "system", highlightEnabled: false });
  stop();

  f.storage.setItem(KEY, JSON.stringify({ theme: "dark", highlightEnabled: true }));
  const blocked = createDisplaySettings({ ...f, storage: { ...f.storage, setItem() { throw Error("quota"); } } });
  blocked.update({ theme: "light" });
  const off = blocked.subscribe(() => {});
  assert.equal(blocked.getSnapshot().theme, "light");
  off();
});

test("updates merge the latest other-window settings before queued storage events arrive", () => {
  const f = fixture(), store = createDisplaySettings(f);
  const stop = store.subscribe(() => {});
  f.storage.setItem(KEY, JSON.stringify({ theme: "light", highlightEnabled: true, colors: { light: { error: "#123456" } } }));
  store.update({ highlightEnabled: false });
  assert.deepEqual(store.getSnapshot(), { theme: "light", highlightEnabled: false, colors: { light: { error: "#123456" } } });
  // A delayed event contains an older value; the on-disk value wins.
  for (const listener of f.listeners) listener({ key: KEY, newValue: null, storageArea: f.storage });
  assert.equal(store.getSnapshot().highlightEnabled, false);
  stop();
});
function contrast(hex, background) {
  const luminance = (color) => {
    const c = color.slice(1).match(/../g).map((value) => parseInt(value, 16) / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
  };
  const a = luminance(hex), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
test("light semantic palette maintains readable contrast on the DSH light background", () => {
  // The semantic (category) colors are the readability-critical set; the ANSI
  // palette has no minimum text-contrast guarantee.
  for (const [name, color] of Object.entries(LIGHT_COLORS)) {
    assert.ok(contrast(color, LIGHT_THEME.background) >= 4.5, `${name}: ${color}`);
  }
});
test("theme and highlighting apply to all live terminals, including while disabled", async () => {
  const original = getDisplaySettings();
  setDisplaySettings({ theme: "dark", highlightEnabled: true });
  const terminals = [new xterm.Terminal({ cols: 40, rows: 3, allowProposedApi: true }), new xterm.Terminal({ cols: 40, rows: 3, allowProposedApi: true })];
  const addons = terminals.map((term) => { const addon = new OutputHighlightAddon({ acquireMatcher: acquireTestMatcher }); term.loadAddon(addon); return addon; });
  try {
    for (const term of terminals) await new Promise((resolve) => term.write('ERROR 42 SUCCESS', resolve));
    for (const addon of addons) await addon.scan();
    const before = addons.map((addon) => addon.rows[0].signature);
    assert.ok(before.every((signature) => signature.includes(COLORS.error)));
    setDisplaySettings({ theme: "light" });
    for (let i = 0; i < terminals.length; i++) {
      assert.equal(terminals[i].options.theme.background, LIGHT_THEME.background);
      await addons[i].scan(); assert.ok(addons[i].rows[0].signature.includes(LIGHT_COLORS.error));
    }
    setDisplaySettings({ highlightEnabled: false });
    assert.ok(addons.every((addon) => addon.rows.length === 0));
    setDisplaySettings({ theme: "dark" });
    assert.ok(terminals.every((term) => term.options.theme.background === DARK_THEME.background));
    setDisplaySettings({ backgrounds: { dark: "#000000" } });
    assert.ok(terminals.every((term) => term.options.theme.background === "#000000"), "live terminals take the custom background");
    assert.ok(terminals.every((term) => term.options.theme.foreground === "#e6edf3"), "a dark custom background keeps a light foreground");
    resetDisplayBackgrounds();
    assert.ok(terminals.every((term) => term.options.theme.background === DARK_THEME.background), "resetting returns to the DSH background");
    const added = new xterm.Terminal({ allowProposedApi: true }); added.loadAddon(new OutputHighlightAddon({ acquireMatcher: acquireTestMatcher }));
    assert.equal(added.options.theme.background, DARK_THEME.background); added.dispose();
  } finally { terminals.forEach((term) => term.dispose()); setDisplaySettings(original); }
});

test("custom colors are validated and survive recreation independently for each theme", () => {
  const f = fixture(), store = createDisplaySettings(f);
  store.update({ colors: { dark: { error: "#FF8800", unknown: "#ffffff", info: "red" }, light: { error: "#0055aa", number: "#xyz123" } } });
  const expected = { dark: { error: "#ff8800" }, light: { error: "#0055aa" } };
  assert.deepEqual(store.getSnapshot().colors, expected);
  assert.deepEqual(createDisplaySettings(f).getSnapshot().colors, expected);
  store.update({ colors: { ...store.getSnapshot().colors, dark: {} } });
  assert.deepEqual(store.getSnapshot().colors, { light: { error: "#0055aa" } });
  store.update({ colors: {} }); assert.equal(store.getSnapshot().colors, undefined);
});

test("custom color updates propagate across windows even when base settings are unchanged", () => {
  const f = fixture(), store = createDisplaySettings(f);
  let updates = 0;
  const stop = store.subscribe(() => updates++);
  f.dispatch(JSON.stringify({ theme: "dark", highlightEnabled: true, colors: { dark: { error: "#123456" } } }));
  assert.equal(updates, 1);
  assert.equal(store.getSnapshot().colors.dark.error, "#123456");
  stop();
});

test("all live terminals recolor immediately, reset per theme, and reject invalid user colors", async () => {
  const original = getDisplaySettings();
  setDisplaySettings({ theme: "dark", highlightEnabled: true, colors: {} });
  const terminals = Array.from({ length: 2 }, () => new xterm.Terminal({ cols: 30, rows: 3, allowProposedApi: true }));
  const addons = terminals.map((term) => { const addon = new OutputHighlightAddon({ acquireMatcher: acquireTestMatcher }); term.loadAddon(addon); return addon; });
  try {
    for (const term of terminals) await new Promise((resolve) => term.write('ERROR', resolve));
    setDisplayColor("dark", "error", "#FF8800");
    for (const addon of addons) { await addon.scan(); assert.ok(addon.rows[0].signature.includes("#ff8800")); }
    const snapshot = getDisplaySettings();
    setDisplayColor("dark", "error", "red"); setDisplayColor("unknown", "error", "#123456");
    assert.equal(getDisplaySettings(), snapshot);
    setDisplayColor("light", "error", "#0055aa"); resetDisplayColors("dark");
    assert.equal(getDisplaySettings().colors.light.error, "#0055aa");
    for (const addon of addons) { await addon.scan(); assert.ok(addon.rows[0].signature.includes(COLORS.error)); }
    setDisplaySettings({ theme: "light" });
    for (const addon of addons) { await addon.scan(); assert.ok(addon.rows[0].signature.includes("#0055aa")); }
  } finally { terminals.forEach((term) => term.dispose()); setDisplaySettings({ ...original, colors: original.colors ?? {} }); }
});


test("new installs follow the host while saved explicit themes survive migration", () => {
  assert.equal(createDisplaySettings(fixture()).getSnapshot().theme, "system");
  for (const theme of ["dark", "light"]) {
    assert.equal(createDisplaySettings(fixture({ [KEY]: JSON.stringify({ theme, highlightEnabled: true }) })).getSnapshot().theme, theme);
    assert.equal(resolveDisplayTheme(theme, theme === "light" ? "dark" : "light"), theme);
  }
  assert.equal(resolveDisplayTheme("system", "light"), "light");
  assert.equal(resolveDisplayTheme("system", "dark"), "dark");
});

test("custom rule normalization, persistence and cross-window updates", () => {
  const f = fixture(), store = createDisplaySettings(f);
  const valid = { id: "one", text: "业务失败", color: "error", match: "word", enabled: false, caseSensitive: true };
  store.update({ customRules: [valid, { ...valid, id: "bad", text: "" }], builtinEnabled: false });
  assert.deepEqual(store.getSnapshot().customRules, [valid]);
  assert.deepEqual(createDisplaySettings(f).getSnapshot(), store.getSnapshot());
  const off = store.subscribe(() => {});
  f.dispatch(JSON.stringify({ theme: "system", highlightEnabled: true, customRules: [{ ...valid, text: "timeout" }] }));
  assert.equal(store.getSnapshot().customRules[0].text, "timeout");
  assert.equal(store.getSnapshot().builtinEnabled, undefined);
  off();
});

test("rule add/edit/reorder/toggle/delete update every live terminal and preserve remote styles", async () => {
  const original = getDisplaySettings();
  setDisplaySettings({ theme: "dark", highlightEnabled: true, builtinEnabled: false, customRules: [] });
  const terminals = [0, 1].map(() => new xterm.Terminal({ cols: 60, rows: 3, allowProposedApi: true }));
  const addons = terminals.map((term) => { const addon = new OutputHighlightAddon({ acquireMatcher: acquireTestMatcher }); term.loadAddon(addon); return addon; });
  const first = { id: "one", text: "业务失败", color: "error" };
  try {
    for (const term of terminals) await new Promise((resolve) => term.write("业务失败 ERROR \x1b[36m业务失败\x1b[0m", resolve));
    for (const addon of addons) { await addon.scan(); assert.equal(addon.rows.length, 0); }
    assert.equal(saveDisplayRule(first), true);
    for (const addon of addons) { await addon.scan(); assert.ok(addon.rows[0].signature.includes(COLORS.error)); }
    assert.equal(saveDisplayRule({ id: "two", text: "业务失败", color: "success" }), true);
    moveDisplayRule("two", -1);
    for (const addon of addons) { await addon.scan(); assert.ok(addon.rows[0].signature.includes(COLORS.success)); }
    saveDisplayRule({ ...getDisplaySettings().customRules[0], enabled: false });
    for (const addon of addons) { await addon.scan(); assert.ok(addon.rows[0].signature.includes(COLORS.error)); }
    saveDisplayRule({ ...first, color: "info" });
    for (const addon of addons) {
      await addon.scan(); assert.ok(addon.rows[0].signature.includes(COLORS.info));
      assert.equal(addon.rows[0].decorations.length, 1, "the remote-colored copy remains untouched");
    }
    deleteDisplayRule("one");
    for (const addon of addons) { await addon.scan(); assert.equal(addon.rows.length, 0); }
    assert.equal(saveDisplayRule({ ...first, text: "" }), false);
  } finally {
    terminals.forEach((term) => term.dispose());
    setDisplaySettings({ ...original, customRules: original.customRules ?? [], builtinEnabled: original.builtinEnabled !== false });
  }
});

test("default highlighting is off, with explicit and legacy opt-ins preserved", () => {
  assert.deepEqual(createDisplaySettings(fixture()).getSnapshot(), { theme: "system", highlightEnabled: false });
  assert.equal(createDisplaySettings(fixture({ "dsh-ssh-ops.private-output-highlight.enabled": "true" })).getSnapshot().highlightEnabled, true);
  assert.equal(createDisplaySettings(fixture({ [KEY]: JSON.stringify({ theme: "light", highlightEnabled: true }) })).getSnapshot().highlightEnabled, true);
});

test("theme schemes persist, synchronize and reset independently, preserving migrated settings", async () => {
  const { getScheme, defaultScheme, exportScheme } = await import("../src/client/terminal-display/scheme.js");
  const { updateScheme, resetScheme } = await import("../src/client/terminal-display/settings.js");
  const original = getDisplaySettings();
  try {
    setDisplaySettings({ theme: "dark", schemes: {}, colors: { dark: { error: "#123456" }, light: { error: "#654321" } },
      customRules: [{ id: "old", text: "OLD", color: "success", enabled: false }], builtinEnabled: true });
    const migrated = getScheme(getDisplaySettings(), "dark");
    assert.equal(migrated.find((entry) => entry.id === "error").color, "#123456");
    const migratedCustom = migrated.find((entry) => entry.id === "custom:old");
    assert.equal(migratedCustom.text, "OLD"); assert.equal(migratedCustom.enabled, false);
    updateScheme("dark", (entries) => entries.map((entry) => entry.id === "error" ? { ...entry, text: "BROKEN", color: "#abcdef", enabled: false } : entry));
    updateScheme("light", (entries) => entries.map((entry) => entry.id === "error" ? { ...entry, text: "OUTAGE" } : entry));
    const dark = getScheme(getDisplaySettings(), "dark");
    const json = exportScheme(getDisplaySettings(), "dark");
    assert.deepEqual(JSON.parse(json).entries, dark);
    assert.equal(JSON.parse(json).theme, "dark");
    assert.equal(JSON.parse(json).background, "#101418", "the backup carries the DSH dark background");
    assert.equal(JSON.parse(exportScheme(getDisplaySettings(), "light")).background, "#f7f8fa", "each theme backs up its own background");
    setDisplaySettings({ backgrounds: { dark: "#000000" } });
    assert.equal(JSON.parse(exportScheme(getDisplaySettings(), "dark")).background, "#000000", "a custom background is backed up");
    assert.equal(JSON.parse(exportScheme(getDisplaySettings(), "light")).background, "#f7f8fa", "the other theme keeps its default background");
    resetDisplayBackgrounds();
    const f = fixture({ [KEY]: JSON.stringify(getDisplaySettings()) }), store = createDisplaySettings(f);
    assert.deepEqual(getScheme(store.getSnapshot(), "dark"), dark);
    const off = store.subscribe(() => {});
    resetScheme("dark");
    f.dispatch(JSON.stringify(getDisplaySettings()));
    assert.deepEqual(getScheme(store.getSnapshot(), "dark"), defaultScheme("dark"));
    assert.equal(getScheme(store.getSnapshot(), "light").find((entry) => entry.id === "error").text, "OUTAGE");
    off();
  } finally { setDisplaySettings({ ...original, schemes: original.schemes ?? {}, colors: original.colors ?? {}, customRules: original.customRules ?? [], builtinEnabled: original.builtinEnabled !== false }); }
});

test("editing a scheme entry replaces its matching text, toggles locally and updates both terminals", async () => {
  const { updateScheme } = await import("../src/client/terminal-display/settings.js");
  const original = getDisplaySettings();
  setDisplaySettings({ theme: "dark", highlightEnabled: true, schemes: {}, colors: {}, customRules: [], builtinEnabled: true });
  const terminals = [0, 1].map(() => new xterm.Terminal({ cols: 50, rows: 3, allowProposedApi: true }));
  const addons = terminals.map((term) => { const addon = new OutputHighlightAddon({ acquireMatcher: acquireTestMatcher }); term.loadAddon(addon); return addon; });
  try {
    for (const term of terminals) await new Promise((resolve) => term.write("ERROR BROKEN \x1b[36mBROKEN\x1b[0m", resolve));
    updateScheme("dark", (entries) => entries.map((entry) => entry.id === "error" ? { ...entry, text: "BROKEN", color: "#123456" } : entry));
    for (const addon of addons) {
      await addon.scan();
      const runs = JSON.parse(addon.rows[0].signature);
      assert.deepEqual(runs.filter((run) => run.foregroundColor === "#123456"), [{ x: 6, width: 6, foregroundColor: "#123456" }]);
    }
    updateScheme("dark", (entries) => entries.map((entry) => entry.id === "error" ? { ...entry, enabled: false } : entry));
    for (const addon of addons) { await addon.scan(); assert.equal(addon.rows.length, 0); }
    setDisplaySettings({ highlightEnabled: false });
    assert.ok(addons.every((addon) => addon.rows.length === 0));
  } finally {
    terminals.forEach((term) => term.dispose());
    setDisplaySettings({ ...original, schemes: original.schemes ?? {}, colors: original.colors ?? {}, customRules: original.customRules ?? [], builtinEnabled: original.builtinEnabled !== false });
  }
});


test("custom backgrounds are validated, persisted per theme and reset to the DSH defaults", () => {
  const original = getDisplaySettings();
  try {
    setDisplayBackground("dark", "#000000");
    setDisplayBackground("light", "#FFEEDD");
    assert.deepEqual(getDisplaySettings().backgrounds, { dark: "#000000", light: "#ffeedd" });
    setDisplayBackground("dark", "red");           // not a hex colour
    setDisplayBackground("sepia", "#000000");      // not a theme
    assert.deepEqual(getDisplaySettings().backgrounds, { dark: "#000000", light: "#ffeedd" }, "invalid updates are ignored");
    resetDisplayBackground("dark");
    assert.deepEqual(getDisplaySettings().backgrounds, { light: "#ffeedd" }, "one theme can return to the DSH background while the other stays custom");
    resetDisplayBackgrounds();
    assert.equal(getDisplaySettings().backgrounds, undefined, "reset drops every override");
    const f = fixture();
    createDisplaySettings(f).update({ backgrounds: { dark: "#000000", light: "#ffeedd", extra: "#123456" } });
    assert.deepEqual(createDisplaySettings(f).getSnapshot().backgrounds, { dark: "#000000", light: "#ffeedd" });
  } finally { resetDisplayBackgrounds(); setDisplaySettings(original); }
});

test("restoring a backup changes only its own theme and rejects invalid files atomically", async () => {
  const { exportScheme, getScheme } = await import("../src/client/terminal-display/scheme.js");
  const { restoreDisplayBackup } = await import("../src/client/terminal-display/settings.js");
  const original = getDisplaySettings();
  try {
    setDisplayBackground("dark", "#101010");
    const backup = exportScheme(getDisplaySettings(), "dark");
    setDisplayBackground("dark", "#202020");
    setDisplayBackground("light", "#eeeeee");
    restoreDisplayBackup(backup);
    assert.equal(getDisplaySettings().backgrounds.dark, "#101010");
    assert.equal(getDisplaySettings().backgrounds.light, "#eeeeee");
    assert.deepEqual(getScheme(getDisplaySettings(), "dark"), JSON.parse(backup).entries);
    const before = getDisplaySettings();
    assert.throws(() => restoreDisplayBackup('{"version":2}'), /invalid-backup/);
    assert.equal(getDisplaySettings(), before);
  } finally { setDisplaySettings(() => ({ ...original, schemes: original.schemes, backgrounds: original.backgrounds })); }
});

test("restoring a backup preserves the other theme when legacy built-ins are disabled", async () => {
  const { exportScheme, getScheme } = await import("../src/client/terminal-display/scheme.js");
  const { restoreDisplayBackup } = await import("../src/client/terminal-display/settings.js");
  const original = getDisplaySettings();
  try {
    const backup = exportScheme({}, "dark");
    setDisplaySettings({ builtinEnabled: false, schemes: undefined, customRules: [] });
    const other = getScheme(getDisplaySettings(), "light");
    restoreDisplayBackup(backup);
    assert.deepEqual(getScheme(getDisplaySettings(), "light"), other);
    assert.deepEqual(getScheme(getDisplaySettings(), "dark"), JSON.parse(backup).entries);
  } finally { setDisplaySettings(() => ({ ...original, builtinEnabled: original.builtinEnabled, schemes: original.schemes, customRules: original.customRules, backgrounds: original.backgrounds })); }
});

test("terminalTheme merges the DSH chrome with the ANSI palette and re-picks the foreground by luminance", () => {
  assert.equal(terminalTheme("dark").background, DARK_THEME.background);
  assert.equal(terminalTheme("light").background, LIGHT_THEME.background);
  assert.equal(terminalTheme("dark").red, DARK_THEME.red, "ANSI colours are untouched");
  const dark = terminalTheme("dark", { dark: "#000000" });
  assert.equal(dark.background, "#000000");
  assert.equal(dark.foreground, "#e6edf3");
  assert.equal(dark.cursorAccent, "#000000");
  const light = terminalTheme("light", { light: "#fefefe" });
  assert.equal(light.background, "#fefefe");
  assert.equal(light.foreground, "#1d2128");
  const inverted = terminalTheme("dark", { dark: "#fefefe" });
  assert.equal(inverted.foreground, "#1d2128", "a light custom background must not keep the dark preset's light text");
  assert.equal(terminalTheme("dark", { dark: "#12345g" }), DARK_THEME, "an invalid override falls back to the preset");
  assert.equal(terminalTheme("dark", { light: "#000000" }), DARK_THEME, "only the resolved theme's override applies");
});
