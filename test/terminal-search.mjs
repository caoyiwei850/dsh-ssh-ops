// Terminal search: the label logic and decoration options are pure, and the
// pane wiring is asserted at the source level (the search itself runs inside
// xterm's addon in a browser, which this suite cannot drive).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SEARCH_DECORATIONS, SEARCH_FIND_OPTIONS, SEARCH_FIND_OPTIONS_PLAIN, isMacPlatform, runFind, searchResultLabel, searchShortcutLabel, searchShortcutMatches } from "../src/client/terminal-search.js";

// ── the count label ─────────────────────────────────────────────────────────
assert.equal(searchResultLabel({ resultIndex: 2, resultCount: 7 }, "error"), "3/7", "the addon indexes matches from 0; readers count from 1");
assert.equal(searchResultLabel({ resultIndex: 0, resultCount: 1 }, "x"), "1/1");
assert.equal(searchResultLabel({ resultIndex: -1, resultCount: 0 }, "nope"), "无匹配");
assert.equal(searchResultLabel(null, "nope"), "无匹配");
assert.equal(searchResultLabel({ resultIndex: 1, resultCount: 3 }, "   "), "", "an empty query says nothing");
assert.equal(searchResultLabel({ resultIndex: -1, resultCount: 3 }, "a"), "1/3", "an unpositioned result reads as the first match");
assert.equal(searchResultLabel({ resultIndex: 5, resultCount: 3 }, "a"), "1/3", "an out-of-range index never prints nonsense");

// ── decorations read on both themes and mark the active match ───────────────
assert.match(SEARCH_DECORATIONS.matchBackground, /rgba\(/, "all-match wash stays translucent so text keeps contrast");
assert.match(SEARCH_DECORATIONS.matchOverviewRuler, /^#/, "the overview ruler needs a solid colour");
assert.notEqual(SEARCH_DECORATIONS.activeMatchBackground, SEARCH_DECORATIONS.matchBackground, "the focused match is distinguishable");
// Green was chosen deliberately: an opaque amber fill made white terminal text
// unreadable. Both fills must be green-weighted and the active one translucent
// too, so the text colour underneath keeps its contrast in either theme.
{
  const channels = (value) => value.match(/\d+/g).slice(0, 3).map(Number);
  for (const [name, value] of [["match", SEARCH_DECORATIONS.matchBackground], ["active", SEARCH_DECORATIONS.activeMatchBackground]]) {
    const [r, g, b] = channels(value);
    assert.ok(g > r && g > b, `${name} fill leans green (got ${value})`);
    assert.equal(value.startsWith("rgba("), true, `${name} fill stays translucent`);
    assert.ok(Number(value.match(/[\d.]+\)$/)[0].slice(0, -1)) < 1, `${name} alpha is below 1`);
  }
}
assert.equal(SEARCH_FIND_OPTIONS.decorations, SEARCH_DECORATIONS, "next/previous share one option set");
assert.equal(SEARCH_FIND_OPTIONS.incremental, true, "typing re-searches from the current position");

// ── the shortcut is a platform convention, not a Windows rebinding ──────────
{
  assert.equal(isMacPlatform("MacIntel"), true);
  assert.equal(isMacPlatform("Win32"), false);
  assert.equal(isMacPlatform(undefined), false);
  assert.equal(searchShortcutLabel(true), "⌘F");
  assert.equal(searchShortcutLabel(false), "Ctrl+F");

  const press = (event) => searchShortcutMatches(event, event.isMac);
  assert.equal(press({ key: "f", metaKey: true, isMac: true }), true, "macOS uses Command+F");
  assert.equal(press({ key: "f", ctrlKey: true, isMac: true }), false, "macOS leaves Ctrl+F to readline's forward-char");
  assert.equal(press({ key: "f", ctrlKey: true, isMac: false }), true, "other platforms use Ctrl+F");
  assert.equal(press({ key: "f", metaKey: true, isMac: false }), false);
  assert.equal(press({ key: "f", ctrlKey: true, shiftKey: true, isMac: true }), true, "Ctrl+Shift+F is the terminal-native binding everywhere");
  assert.equal(press({ key: "f", ctrlKey: true, shiftKey: true, isMac: false }), true);
  assert.equal(press({ key: "g", ctrlKey: true, isMac: false }), false);
  assert.equal(press({}, false), false);
}

// ── runFind: decorated first, plain on refusal (xterm's proposed-API gate) ──
{
  const calls = [];
  const working = {
    findNext: (query, options) => { calls.push({ query, options }); return true; },
    findPrevious: (query, options) => { calls.push({ query, options, back: true }); return true; }
  };
  assert.deepEqual(runFind(working, "error"), { ok: true, decorated: true });
  assert.equal(calls[0].options, SEARCH_FIND_OPTIONS, "the first attempt asks for highlights");
  calls.length = 0;
  runFind(working, "error", { backwards: true });
  assert.equal(calls[0].back, true, "backwards uses findPrevious");

  // A build whose decorations are refused throws; the retry must still find.
  const refusing = {
    findNext: (query, options) => {
      calls.push({ query, options });
      if (options.decorations !== undefined) throw new Error("You must set the allowProposedApi option to true to use proposed API");
      return true;
    }
  };
  calls.length = 0;
  const warnings = [];
  const degraded = runFind(refusing, "error", { warn: (...args) => warnings.push(args) });
  assert.deepEqual(degraded, { ok: true, decorated: false }, "the retry still finds the match");
  assert.equal(calls.length, 2, "one decorated attempt, one plain retry");
  assert.equal(calls[1].options, SEARCH_FIND_OPTIONS_PLAIN);
  assert.equal(warnings.length, 1, "the degradation is reported once");

  assert.deepEqual(runFind({ findNext: () => { throw new Error("boom"); } }, "x", { warn: () => {} }),
    { ok: false, decorated: false }, "a broken addon reports no match instead of throwing into React");
  assert.deepEqual(runFind(working, "   "), { ok: false, decorated: false }, "an empty query never searches");
}

// ── the pane wiring ─────────────────────────────────────────────────────────
{
  const panel = await readFile(new URL("../src/client/SshPanel.jsx", import.meta.url), "utf8");
  const checks = [
    [/import \{ SearchAddon \} from "@xterm\/addon-search"/, "the addon is imported"],
    [/const search = new SearchAddon\(\);\s*\n\s*term\.loadAddon\(search\);/, "each pooled terminal loads the addon once"],
    [/return \{ term, fit, search \};/, "the pool entry exposes it"],
    [/search\?\.onDidChangeResults\?\.\(/, "the pane subscribes to live match results"],
    [/event\.shiftKey/, "Shift+Enter walks backwards"],
    [/event\.key === "Escape"/, "Esc closes the bar"],
    [/allowProposedApi: true/, "the terminal opts into the proposed API the highlight decorations need"],
    [/runFind\(search, text, \{ warn: console\.warn \}\)/, "typing searches through the degrading helper"],
    [/searchShortcutMatches\(event, isMac\)/, "the shortcut goes through the platform-aware matcher"],
    [/aria-label="在终端里查找"[\s\S]{0,120}<svg/, "a visible magnifier button is the entry point"],
    [/title=\{`在终端里查找（\$\{searchShortcutLabel\(/, "the button's tooltip teaches the shortcut"],
    [/runFind\(search, query, \{ backwards, warn: console\.warn \}\)/, "Enter/Shift+Enter search through the same helper"],
    [/clearDecorations\?\.\(\)/, "closing clears the highlights"],
    [/searchResultLabel\(searchResults, query\)/, "the count comes from the label helper"],
    [/placeholder="在终端里查找…"/, "the bar is labelled for the reader"]
  ];
  for (const [pattern, label] of checks) {
    assert.match(panel, pattern, `SshPanel.jsx: ${label}`);
  }
}

console.log("terminal search: label logic, decorations and pane wiring all passed");
