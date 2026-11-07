/**
 * The scheme preview is the only place where a user sees what a freshly opened
 * dialog will color. Its seed text therefore has to demonstrate every built-in
 * classification, not just a few, and it has to include CJK characters because
 * the matcher maps them back to terminal cell widths. The text is fixed in
 * src/client/terminal-display/preview-text.js, so this test guards it from
 * drifting when rules change.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PREVIEW_TEXT } from "../src/client/terminal-display/preview-text.js";
import { defaultScheme, compileScheme } from "../src/client/terminal-display/scheme.js";
import { matchText } from "../src/client/terminal-display/matcher.js";

const previewLines = DEFAULT_PREVIEW_TEXT.split("\n");
const HAN = /\p{Script=Han}/u;

/** Map each highlight category (entry id) to whether the seed text shows it. */
function coveredCategories(theme) {
  const compiled = compileScheme(defaultScheme(theme));
  const colorToId = new Map(Object.entries(compiled.colors).map(([id, hex]) => [hex.toLowerCase(), id]));
  const shown = new Set();
  for (const line of previewLines) {
    for (const span of matchText(line, compiled.rules, compiled.colors)) {
      const id = colorToId.get(span.color.toLowerCase());
      if (id) shown.add(id);
    }
  }
  return { all: Object.keys(compiled.colors), shown };
}

test("preview seed text demonstrates every built-in highlight category in both themes", () => {
  for (const theme of ["dark", "light"]) {
    const { all, shown } = coveredCategories(theme);
    const missing = all.filter((id) => !shown.has(id));
    assert.deepEqual(missing, [], `${theme}: preview text is missing categories: ${missing.join(", ")}`);
    // The categories are the ones the settings list exposes; a rule change that
    // drops one must update the seed text (and this list) deliberately.
    assert.deepEqual([...all].sort(), ["command", "debug", "error", "heading", "info", "number",
      "option", "prompt", "string", "success", "warning"], `${theme}: unexpected category set`);
  }
});

test("preview seed text reads as one log excerpt and keeps CJK as quoted string values", () => {
  // Plain logging English stays visible, so the colors are shown on realistic
  // content instead of a mixed bag of tokens.
  assert.match(DEFAULT_PREVIEW_TEXT, /service started/);
  assert.match(DEFAULT_PREVIEW_TEXT, /connection refused/);

  // CJK characters only appear inside double-quoted values (a payload field),
  // never as loose text mixed into the log line.
  const cjkLines = previewLines.filter((line) => HAN.test(line));
  assert.ok(cjkLines.length >= 2, "the excerpt includes quoted CJK payloads");
  for (const line of cjkLines) {
    assert.match(line, /"[^"]*\p{Script=Han}[^"]*"/u, `CJK must be a quoted string value: ${line}`);
  }
});

test("preview seed text fits the preview box without scrolling", () => {
  // The preview box is 188 px tall with 12 px padding and a 20 px line height:
  // eight lines fit exactly, so all built-in categories are visible at once.
  assert.ok(previewLines.length <= 8, `seed text uses at most 8 lines (got ${previewLines.length})`);
  assert.ok(DEFAULT_PREVIEW_TEXT.length < 4096, "seed text stays under the editor's maxLength");
  assert.doesNotMatch(DEFAULT_PREVIEW_TEXT, /[\t\x00-\x08\x0b\x0c\x0e-\x1f]/, "no tabs or control characters");
});
