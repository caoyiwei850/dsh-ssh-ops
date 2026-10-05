/**
 * The bilingual message layer (Chinese source, English overlay; engine and
 * dictionary inversion adapted from alexeyfadeev's PR #26). What must hold:
 * - Chinese is the default, so an untouched install reads exactly as before;
 * - a string with no dictionary entry stays Chinese in both languages;
 * - interpolated messages are translated with their values substituted, which
 *   is the part most likely to break silently;
 * - switching language changes the wording without a reload;
 * - every dictionary entry keeps matching segment counts, so the pattern
 *   engine never silently skips a hand-edited entry;
 * - every t() call site has a dictionary entry (the extract checker) and no
 *   user-facing Chinese string bypasses t().
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  DEFAULT_LANGUAGE,
  EN_MESSAGES,
  LANGUAGES,
  LANGUAGE_LABELS,
  getLanguage,
  normalizeLanguage,
  setLanguage,
  subscribeLanguage,
  t
} from "../src/i18n/core.js";

// ── supported languages ────────────────────────────────────────────────────
assert.deepEqual(LANGUAGES, ["zh", "en"], "the plugin supports exactly the two languages DSH can show");
assert.equal(DEFAULT_LANGUAGE, "zh", "Chinese is the source language and the default");
assert.deepEqual(Object.keys(LANGUAGE_LABELS).sort(), ["en", "zh"], "each language has a label for the combobox");

assert.equal(normalizeLanguage("zh"), "zh");
assert.equal(normalizeLanguage("en"), "en");
assert.equal(normalizeLanguage("fr"), DEFAULT_LANGUAGE, "a language DSH may gain later degrades to the default");
assert.equal(normalizeLanguage(undefined), DEFAULT_LANGUAGE);
assert.equal(normalizeLanguage(null), DEFAULT_LANGUAGE);

// ── Chinese is a pass-through ──────────────────────────────────────────────
{
  setLanguage("zh");
  assert.equal(getLanguage(), "zh");
  const chinese = "删除会话日志";
  assert.equal(t(chinese), chinese, "the Chinese wording is what the source already says");
  assert.equal(t("PostgreSQL"), "PostgreSQL", "an unknown string is returned unchanged, never blank");
  assert.equal(t(""), "", "an empty string survives");
  assert.equal(t(undefined), undefined, "a non-string survives so a message is never blanked");
  assert.equal(t(42), 42);
}

// ── English lookup, exact and interpolated ─────────────────────────────────
{
  setLanguage("en");
  assert.equal(t("连接"), "Connect", "an exact dictionary entry translates");
  assert.equal(t("连接服务器"), "Connect to a server", "longer keys stay distinct");
  assert.equal(t("没有这一条"), "没有这一条", "a string without an entry stays Chinese instead of blanking");
  const translated = t("约 42 行");
  assert.equal(translated, "~ 42 rows", "interpolated values ride into the English form");
  assert.equal(t("删除所选（3）"), "Delete selected (3)", "full-width parentheses patterns match too");
  setLanguage("zh");
}

// ── switching notifies subscribers, values re-resolve ──────────────────────
{
  const seen = [];
  const unsubscribe = subscribeLanguage((language) => seen.push(language));
  setLanguage("en");
  assert.deepEqual(seen, ["en"], "subscribers hear the change");
  assert.equal(t("连接"), "Connect");
  setLanguage("zh");
  assert.deepEqual(seen, ["en", "zh"]);
  assert.equal(t("连接"), "连接");
  unsubscribe();
  setLanguage("en");
  assert.deepEqual(seen, ["en", "zh"], "an unsubscribed listener hears nothing more");
  setLanguage("zh");
}

// ── dictionary hygiene: every entry is pattern-compilable ──────────────────
{
  let entries = 0;
  for (const [zh, en] of Object.entries(EN_MESSAGES)) {
    const zhSegments = zh.split(/\$\{[^}]*\}/).length;
    const enSegments = en.split(/\$\{[^}]*\}/).length;
    assert.equal(enSegments, zhSegments, `segment count drift (dictionary is hand-edited): ${zh.slice(0, 50)}`);
    entries += 1;
  }
  assert.ok(entries > 500, `the dictionary is substantial (${entries} entries), not a stub`);
}

// ── every call site is covered, nothing bypasses t() ───────────────────────
{
  const checker = new URL("../scripts/i18n-extract.mjs", import.meta.url);
  try {
    execFileSync(process.execPath, [checker.pathname, "--quiet"], { stdio: "pipe" });
  } catch (error) {
    const output = String(error.stderr ?? error.stdout ?? "");
    assert.fail(`i18n extract checker reports drift:\n${output.slice(0, 2000)}`);
  }
}

console.log("i18n: zh source default, en overlay, interpolation, switching, catalog hygiene, call-site coverage all passed");
