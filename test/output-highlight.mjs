import { acquireTestMatcher } from "./helpers/highlight-worker.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import xterm from "@xterm/xterm";
import { matchText, readLogicalLine, matchLogicalLine } from "../src/client/terminal-display/matcher.js";
import { COLORS, HIGHLIGHT_RULES } from "../src/client/terminal-display/rules.js";
import { DARK_THEME, LIGHT_THEME } from "../src/client/terminal-display/theme.js";
import { OutputHighlightAddon } from "../src/client/terminal-display/addon.js";
import { getDisplaySettings, setDisplaySettings } from "../src/client/terminal-display/settings.js";

import { normalizeCustomRules, compileCustomRules, MAX_CUSTOM_RULES } from "../src/client/terminal-display/custom-rules.js";

const write = (term, text) => new Promise((resolve) => term.write(text, resolve));
function colorAt(text, target) {
  const index = text.indexOf(target);
  return matchText(text).find((s) => s.start <= index && s.end > index)?.color;
}
function visibleRuns(term) {
  const buffer = term.buffer.active, runs = [];
  for (let y = 0; y < buffer.length;) {
    const logical = readLogicalLine(buffer, y);
    runs.push(...matchLogicalLine(logical, 0, buffer.length));
    y = logical.next;
  }
  return runs;
}
test("built-in keyword classifications and negative phrase precedence", () => {
  for (const word of ["ERROR", "denied", "FAILED", "FATAL", "invalid"]) assert.equal(colorAt(word, word), COLORS.error);
  for (const word of ["success", "SUCCEEDED", "yes", "ok", "passed"]) assert.equal(colorAt(word, word), COLORS.success);
  assert.equal(colorAt("not supported", "not supported"), COLORS.error);
  assert.notEqual(colorAt("not supported", "supported"), COLORS.success, "the negative phrase keeps its inner positive word uncolored");
  assert.equal(colorAt("debug sudo closed", "debug"), COLORS.debug);
  assert.equal(colorAt("debug sudo closed", "sudo"), COLORS.warning);
  assert.equal(colorAt("connection authenticated", "connection"), COLORS.info);
  assert.equal(colorAt("preFAILED unsuccessful", "preFAILED"), undefined);
});
test("opaque strings, dates, IPv4/IPv6 and MAC win over fragments", () => {
  assert.equal(colorAt('"ERROR 123"', "ERROR"), COLORS.string);
  for (const value of ["192.168.1.5", "2001:db8::1", "::1", "aa:bb:cc:dd:ee:ff", "2026-10-30", "15:30:01", "12:30:15"]) {
    const spans = matchText(value);
    assert.deepEqual(spans, [{ start: 0, end: value.length, color: COLORS.heading }], value);
  }
  assert.notEqual(colorAt("999.2.3.4", "999"), COLORS.heading);
  assert.notEqual(colorAt("2001:db8:123", "2001"), COLORS.heading);
});
test("prompt-only commands and paths, options, numbers and permission cells", () => {
  const text = 'root@host:~$ sudo cat /var/error.log | grep --color=auto "ERROR"';
  assert.equal(colorAt(text, "sudo"), COLORS.warning);
  assert.equal(colorAt(text, "grep"), COLORS.command);
  assert.equal(colorAt(text, "/var/error.log"), COLORS.string);
  assert.equal(colorAt(text, "--color"), COLORS.option);
  assert.equal(colorAt(text, "auto"), undefined, "an option value keeps its own category (here: unclassified)");
  assert.equal(colorAt('plain 42 3.14 0xCAFE', "42"), COLORS.number);
  assert.equal(colorAt('CPU 85% Retry --timeout=30', "Retry"), undefined);
  assert.equal(colorAt('CPU 85% Retry --timeout=30', "85%"), COLORS.number);
  assert.equal(colorAt('host% cat /var/log', "cat"), COLORS.command);
  assert.equal(colorAt('drwxr-xr-x user', "rwx"), COLORS.info);
  assert.equal(colorAt('drwxr-xr-x user', "wx"), COLORS.warning);
  assert.equal(colorAt('drwxr-xr-x user', "d"), COLORS.debug);
});
test("real xterm preserves ANSI palette, truecolor and style, including mixed tokens", async () => {
  const term = new xterm.Terminal({ cols: 100, rows: 5, allowProposedApi: true });
  try {
    await write(term, '\x1b[36mERROR\x1b[0m \x1b[38;2;1;2;3mSUCCESS\x1b[0m \x1b[3mWARN\x1b[0m ERROR');
    const runs = visibleRuns(term);
    assert.deepEqual(runs.map((r) => [r.x, r.width, r.foregroundColor]), [[19, 5, COLORS.error]]);
    await write(term, '\r\x1b[2K\x1b[31mER\x1b[0mROR');
    assert.deepEqual(visibleRuns(term).map((r) => [r.x, r.width]), [[2, 3]]);
  } finally { term.dispose(); }
});

test("background, bold, underline, inverse and hidden cells keep remote attributes", async () => {
  const term = new xterm.Terminal({ cols: 30, rows: 3, allowProposedApi: true });
  try {
    for (const sgr of ['41', '48;2;1;2;3', '1', '2', '4', '7', '8', '9']) {
      await write(term, `\r\x1b[2K\x1b[${sgr}mERROR\x1b[0m ERROR`);
      assert.deepEqual(visibleRuns(term).map((r) => [r.x, r.width]), [[6, 5]], `SGR ${sgr}`);
    }
  } finally { term.dispose(); }
});
test("real xterm automatic wraps, Chinese/emoji and hard newlines", async () => {
  const term = new xterm.Terminal({ cols: 10, rows: 6, allowProposedApi: true });
  try {
    await write(term, '中文😀 ERROR');
    const logical = readLogicalLine(term.buffer.active, 0);
    assert.equal(logical.text.trimEnd(), '中文😀 ERROR');
    // xterm's default Unicode provider renders this emoji as one cell; use
    // its actual buffer widths rather than an external wcwidth assumption.
    const runs = matchLogicalLine(logical, 0, 6).filter((r) => r.foregroundColor === COLORS.error);
    assert.deepEqual(runs.map((r) => [r.x, r.y, r.width]), [[6, 0, 4], [0, 1, 1]]);
    assert.deepEqual(matchLogicalLine(logical, 1, 2).map((r) => [r.x, r.y, r.width]), [[0, 1, 1]]);
    await write(term, '\r\nER\r\nROR');
    assert.equal(visibleRuns(term).filter((r) => r.foregroundColor === COLORS.error).length, 2);
  } finally { term.dispose(); }
});
test("combining characters retain correct cell positions", async () => {
  const term = new xterm.Terminal({ cols: 30, rows: 3, allowProposedApi: true });
  try {
    await write(term, 'e\u0301 ERROR');
    assert.deepEqual(visibleRuns(term).map((r) => [r.x, r.width]), [[2, 5]]);
  } finally { term.dispose(); }
});

test("wide glyph wrap padding is excluded without losing real spaces", async () => {
  const term = new xterm.Terminal({ cols: 5, rows: 5, allowProposedApi: true });
  try {
    await write(term, '1234中ERROR');
    const logical = readLogicalLine(term.buffer.active, 0);
    assert.equal(logical.text.trimEnd(), '1234中ERROR');
    assert.deepEqual(logical.positions[4], { x: 0, y: 1, width: 2, eligible: true });
    await write(term, '\r\n123 中');
    const spaced = readLogicalLine(term.buffer.active, 3);
    assert.equal(spaced.text.trimEnd(), '123 中');
  } finally { term.dispose(); }
});
test("row cache, CR overwrite, alternate buffer, global toggle and disposal", async () => {
  setDisplaySettings({ highlightEnabled: true });
  const term = new xterm.Terminal({ cols: 50, rows: 4, allowProposedApi: true });
  const addon = new OutputHighlightAddon({ acquireMatcher: acquireTestMatcher });
  let creations = 0;
  const register = term.registerDecoration.bind(term);
  term.registerDecoration = (options) => { creations++; return register(options); };
  term.loadAddon(addon);
  try {
    await write(term, 'ERROR 42 SUCCESS'); await addon.scan();
    assert.equal(term.options.theme.background, DARK_THEME.background);
    assert.equal(term.options.theme.red, DARK_THEME.red);
    const initial = creations;
    await addon.scan(); assert.equal(creations, initial);
    assert.equal(addon.rows.length, 1);
    await write(term, '\r\x1b[2Kplain'); await addon.scan(); assert.equal(addon.rows.length, 0);
    await write(term, '\r\x1b[2KERROR'); await addon.scan();
    await write(term, '\x1b[?1049hERROR'); await addon.scan(); assert.equal(addon.rows.length, 0);
    await write(term, '\x1b[?1049l'); await addon.scan(); assert.equal(addon.rows.length, 1);
    setDisplaySettings({ highlightEnabled: false }); assert.equal(addon.rows.length, 0);
    setDisplaySettings({ highlightEnabled: true }); await addon.scan(); assert.equal(addon.rows.length, 1);
  } finally { term.dispose(); }
  assert.equal(addon.rows.length, 0);
});
test("scrollback trimming and continuous output remain bounded", async () => {
  const term = new xterm.Terminal({ cols: 80, rows: 20, scrollback: 30, allowProposedApi: true });
  const addon = new OutputHighlightAddon({ acquireMatcher: acquireTestMatcher }); term.loadAddon(addon);
  try {
    for (let i = 0; i < 10; i++) {
      await write(term, ('2026-10-30 ERROR connection 192.168.1.2 retries=42\r\n').repeat(200)); await addon.scan();
      assert.ok(addon.rows.length <= term.rows);
      assert.ok(term.markers.length <= term.rows);
      assert.ok(addon.rows.reduce((n, r) => n + r.decorations.length, 0) <= 4096);
    }
  } finally { term.dispose(); }
});

test("unchanged visible rows reuse their decorations after scrollback trims", async () => {
  const term = new xterm.Terminal({ cols: 30, rows: 4, scrollback: 3, allowProposedApi: true });
  const addon = new OutputHighlightAddon({ acquireMatcher: acquireTestMatcher }); term.loadAddon(addon);
  try {
    await write(term, 'ERROR 42\r\n'.repeat(8)); await addon.scan();
    const markers = new Set(addon.rows.map((row) => row.marker));
    await write(term, 'ERROR 42\r\n'); await addon.scan();
    assert.ok(addon.rows.some((row) => markers.has(row.marker)), 'scrollback movement should not recreate every visible decoration');
  } finally { term.dispose(); }
});
test("failed decoration API cleans marker and disables only the addon", async () => {
  const original = getDisplaySettings();
  const term = new xterm.Terminal({ cols: 30, rows: 3, allowProposedApi: true });
  const addon = new OutputHighlightAddon({ acquireMatcher: acquireTestMatcher });
  term.registerDecoration = () => { throw Error('unsupported API'); };
  term.loadAddon(addon);
  try {
    await write(term, 'ERROR');
    await addon.scan().catch(() => addon.fail());
    assert.equal(addon.failed, true);
    assert.equal(term.markers.length, 0);
    setDisplaySettings({ theme: "light" });
    assert.equal(term.options.theme.background, LIGHT_THEME.background, "theme updates survive a decoration failure");
    await addon.scan(); assert.equal(addon.rows.length, 0);
    await write(term, '\r\nterminal still usable');
    assert.equal(term.buffer.active.getLine(1).translateToString(true), 'terminal still usable');
  } finally { term.dispose(); setDisplaySettings(original); }
});

test("resize, font zoom, scroll and disposal retain buffer content and release resources", async () => {
  const term = new xterm.Terminal({ cols: 12, rows: 4, scrollback: 30, allowProposedApi: true });
  const addon = new OutputHighlightAddon({ acquireMatcher: acquireTestMatcher }); term.loadAddon(addon);
  try {
    await write(term, 'ERROR connection 42\r\nSUCCESS\r\nplain\r\nlast');
    await addon.scan();
    const content = () => {
      const buffer = term.buffer.active, lines = [];
      for (let y = 0; y < buffer.length;) {
        const logical = readLogicalLine(buffer, y);
        lines.push(logical.text.trimEnd()); y = logical.next;
      }
      return lines.filter(Boolean).join('\n');
    };
    const before = content();
    term.options.fontSize = 18;
    term.resize(24, 4);
    term.scrollToTop(); await addon.scan();
    assert.equal(content(), before);
    for (const row of addon.rows) for (const decoration of row.decorations) {
      assert.ok(decoration.options.x + decoration.options.width <= term.cols);
    }
    addon.dispose(); addon.dispose(); await addon.scan(); addon.request();
    assert.equal(term.markers.length, 0);
    assert.equal(addon.timer, undefined);
    assert.equal(content(), before);
    await write(term, '\r\nstill usable');
    assert.match(content(), /still usable$/);
  } finally { term.dispose(); }
});


test("literal custom rules handle punctuation, Unicode words, case and priority", () => {
  const custom = (text, options = {}) => compileCustomRules([{ id: "custom", text, color: "success", ...options }]);
  assert.deepEqual(matchText("a+b axb", custom("a+b")), [{ start: 0, end: 3, color: COLORS.success }]);
  assert.deepEqual(matchText("(a+)+$", custom("(a+)+$")), [{ start: 0, end: 6, color: COLORS.success }]);
  assert.equal(matchText("WARN warning preWARN WARN_", custom("WARN", { match: "word" })).length, 1);
  assert.equal(matchText("timeout TIMEOUT", custom("timeout", { caseSensitive: true })).length, 1);
  assert.equal(matchText("timeout TIMEOUT", custom("timeout")).length, 2);
  assert.equal(matchText("失败 失败了 未失败", custom("失败", { match: "word" })).length, 1);
  assert.equal(matchText('"ERROR"', [...custom("ERROR"), ...HIGHLIGHT_RULES]).find((span) => span.start === 1)?.color, COLORS.success);
  assert.deepEqual(compileCustomRules([{ id: "off", text: "ERROR", color: "error", enabled: false }]), []);
});

test("stored custom rules reject invalid fields and remain bounded", () => {
  const valid = { id: "a", text: "ERROR", color: "error" };
  const normalized = normalizeCustomRules([null, valid, valid, { ...valid, id: "b", text: "x".repeat(129) },
    { ...valid, id: "c", text: "a\nb" }, { ...valid, id: "d", color: "unknown" }]);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].enabled, true);
  assert.equal(normalizeCustomRules(Array.from({ length: 100 }, (_, i) => ({ ...valid, id: String(i) }))).length, MAX_CUSTOM_RULES);
});

test("default schemes preserve semantic classification and category switches", async () => {
  const { defaultScheme, compileScheme } = await import("../src/client/terminal-display/scheme.js");
  const compiled = compileScheme(defaultScheme("dark"));
  for (const text of ['"ERROR 123"', 'not successful', "can't be supported", '192.168.1.5', 'root@host:~$ cat /var/log | grep --color=auto "ERROR"', 'drwxr-xr-x user']) {
    assert.deepEqual(matchText(text, compiled.rules, compiled.colors), matchText(text), text);
  }
  const disabled = compileScheme(defaultScheme("dark").map((entry) => ({ ...entry, enabled: false })));
  assert.deepEqual(matchText('ERROR 42 "SUCCESS" 192.168.1.1', disabled.rules, disabled.colors), []);
  const custom = compileScheme(defaultScheme("dark").map((entry) => entry.id === "error" ? { ...entry, text: "a\\+b\n业务失败", mode: "regex" } : entry));
  assert.equal(matchText('a+b 业务失败', custom.rules, custom.colors).filter((span) => span.color === COLORS.error).length, 2);
});

test("scheme normalization validates entries and accepts multiline literal text", async () => {
  const { defaultScheme, normalizeScheme, MAX_SCHEME_ENTRIES } = await import("../src/client/terminal-display/scheme.js");
  const valid = { ...defaultScheme("dark")[0], text: "a+b\r\nERROR", color: "#ABCDEF" };
  const normalized = normalizeScheme([valid, valid, { ...valid, id: "bad", color: "red" }, { ...valid, id: "long", text: "x".repeat(8193) }]);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].text, "a+b\nERROR"); assert.equal(normalized[0].color, "#abcdef");
  assert.equal(normalizeScheme(Array.from({ length: 100 }, (_, i) => ({ ...valid, id: `custom:${i}` }))).length, MAX_SCHEME_ENTRIES);
});

test("legacy whole-word schemes retain Unicode boundaries and escape literal metacharacters", async () => {
  const { normalizeScheme, compileScheme } = await import("../src/client/terminal-display/scheme.js");
  const entries = normalizeScheme([{ id: 'custom:old', text: '失败\na+b', mode: 'word', color: '#123456', enabled: true }]);
  const compiled = compileScheme(entries);
  const spans = matchText('失败 未失败 a+b axb', compiled.rules, compiled.colors);
  assert.deepEqual(spans.map(({ start, end }) => [start, end]), [[0, 2], [7, 10]]);
});
