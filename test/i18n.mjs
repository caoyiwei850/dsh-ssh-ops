/**
 * The bilingual message layer.
 *
 * The plugin ships English as its source language and a Chinese dictionary
 * keyed by those English strings. What must hold:
 * - English is the default, so an untouched install reads exactly as before;
 * - a string with no dictionary entry stays English in both languages, because
 *   the pre-translation sources already left technical text in English;
 * - interpolated messages are translated with their values substituted, which
 *   is the part most likely to break silently;
 * - switching language changes the wording without a reload.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  LANGUAGE_LABELS,
  ZH_MESSAGES,
  getLanguage,
  normalizeLanguage,
  setLanguage,
  subscribeLanguage,
  t
} from "../src/i18n/core.js";

// ── supported languages ────────────────────────────────────────────────────
assert.deepEqual(LANGUAGES, ["zh", "en"], "the plugin supports exactly the two languages DSH can show");
assert.equal(DEFAULT_LANGUAGE, "en", "English is the source language and the default");
assert.deepEqual(Object.keys(LANGUAGE_LABELS).sort(), ["en", "zh"], "each language has a label for the combobox");

assert.equal(normalizeLanguage("zh"), "zh");
assert.equal(normalizeLanguage("en"), "en");
assert.equal(normalizeLanguage("fr"), DEFAULT_LANGUAGE, "a language DSH may gain later degrades to the default");
assert.equal(normalizeLanguage(undefined), DEFAULT_LANGUAGE);
assert.equal(normalizeLanguage(null), DEFAULT_LANGUAGE);

// ── English is a pass-through ──────────────────────────────────────────────
{
  setLanguage("en");
  assert.equal(getLanguage(), "en");
  const english = "Delete the SSH resource?";
  assert.equal(t(english), english, "the English wording is what the source already says");
  assert.equal(t("PostgreSQL"), "PostgreSQL", "an unknown string is returned unchanged, never blank");
  assert.equal(t(""), "", "an empty string survives");
  assert.equal(t(undefined), undefined, "a non-string survives so a message is never blanked");
  assert.equal(t(42), 42);
}

// ── Chinese lookup, exact and interpolated ─────────────────────────────────
{
  setLanguage("zh");
  assert.equal(getLanguage(), "zh");

  // Exact entry.
  assert.equal(t("SSH Resources"), ZH_MESSAGES["SSH Resources"]);
  assert.notEqual(t("SSH Resources"), "SSH Resources", "a translated string is really translated");

  // An entry with no dictionary coverage stays English by design.
  assert.equal(t("SHA256:"), "SHA256:");
  assert.equal(t("PostgreSQL"), "PostgreSQL");

  // Interpolation: the value must be spliced back into the Chinese form.
  const name = "prod-db-1";
  const translated = t(`Delete the SSH resource "${name}"?`);
  assert.ok(translated.includes(name), `the interpolated value survives: ${translated}`);
  assert.notEqual(translated, `Delete the SSH resource "${name}"?`, "the interpolated message is translated");

  // Several placeholders, including one at the very start of the message.
  const multi = t(`${name} (double-click to open)`);
  assert.ok(multi.startsWith(name), `a leading placeholder is preserved: ${multi}`);

  // A pattern must not match a longer, unrelated sentence that merely starts
  // the same way, or a wrong Chinese message would be shown.
  const unrelated = `${name} (double-click to open) and then do something else entirely`;
  assert.equal(t(unrelated), unrelated, "a pattern is anchored, so a longer sentence is left alone");
}

// ── switching notifies subscribers ─────────────────────────────────────────
{
  setLanguage("zh");
  const seen = [];
  const unsubscribe = subscribeLanguage((language) => seen.push(language));

  assert.equal(setLanguage("en"), "en");
  assert.deepEqual(seen, ["en"], "changing the language notifies listeners");

  setLanguage("en");
  assert.deepEqual(seen, ["en"], "re-selecting the same language does not notify");

  setLanguage("zh");
  assert.deepEqual(seen, ["en", "zh"]);

  unsubscribe();
  setLanguage("en");
  assert.deepEqual(seen, ["en", "zh"], "an unsubscribed listener stops hearing about changes");
  setLanguage("zh");
}

// ── the dictionary itself is sound ─────────────────────────────────────────
{
  const entries = Object.entries(ZH_MESSAGES);
  assert.ok(entries.length > 400, `the dictionary carries the whole interface (${entries.length} entries)`);

  const placeholders = (text) => (text.match(/\$\{/g) ?? []).length;
  const mismatched = entries.filter(([en, zh]) => placeholders(en) !== placeholders(zh));
  assert.deepEqual(mismatched, [], "every template keeps the same number of placeholders as its source");

  // A dictionary key that is itself Chinese would mean an untranslated source.
  const cjk = /[\u4e00-\u9fff]/;
  const chineseKeys = entries.filter(([en]) => cjk.test(en)).map(([en]) => en);
  assert.deepEqual(chineseKeys, [], "no source string is still Chinese");

  const emptyValues = entries.filter(([, zh]) => typeof zh !== "string" || zh === "");
  assert.deepEqual(emptyValues, [], "no entry translates to an empty string");
}

// ── the client half is wired to the shared dictionary ──────────────────────
{
  const clientLocale = readFileSync(new URL("../src/client/locale.js", import.meta.url), "utf8");
  assert.match(clientLocale, /from "\.\.\/i18n\/core\.js"/, "the browser half reuses the shared core");
  assert.match(clientLocale, /useSyncExternalStore\(subscribeLanguage/, "components subscribe to language changes");
  assert.match(clientLocale, /getSnapshot\?\.\(\)/, "DSH's active locale is read through getSnapshot()");
  assert.doesNotMatch(clientLocale, /const zh = \{/, "the old duplicated dictionary is gone");

  const panel = readFileSync(new URL("../src/client/SshPanel.jsx", import.meta.url), "utf8");
  assert.match(panel, /import \{ t \} from "\.\.\/i18n\/core\.js"/, "the panel uses the shared dictionary");
  assert.doesNotMatch(panel, /const t = zhDict/, "the panel no longer shadows t with a frozen dictionary");
  assert.doesNotMatch(panel, /const zhDict = \{/, "the panel's duplicate dictionary is gone");

  const resources = readFileSync(new URL("../src/client/SshResources.jsx", import.meta.url), "utf8");
  assert.match(resources, /useLanguage\(\)/, "the settings page re-renders on a language change");
  assert.match(resources, /api\.languageGet\(\)/, "the stored language is loaded on mount");
  assert.match(resources, /api\.languageSave\(/, "a choice is persisted");
  assert.match(resources, /LANGUAGES\.map/, "the combobox offers exactly the supported languages");
  assert.match(resources, /readHostLanguage\(locale\)/, "a first run adopts DSH's own language");
}

// ── the host half exposes and honours the setting ──────────────────────────
{
  const host = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  assert.match(host, /language: z\.enum\(\["zh", "en"\]\)\.optional\(\)/, "the stored language field is optional for older records");
  assert.match(host, /async languageGet\(\)/, "the host answers languageGet");
  assert.match(host, /async languageSave\(request\)/, "the host answers languageSave");
  assert.match(host, /setLanguage\(this\.language\)/, "a stored language is applied to the host half at boot");

  const descriptors = readFileSync(new URL("../src/descriptors.js", import.meta.url), "utf8");
  assert.match(descriptors, /def\("languageGet"/, "languageGet is a registered remote method");
  assert.match(descriptors, /def\("languageSave"/, "languageSave is a registered remote method");

  // Host errors translate once, in the envelope, rather than at 100+ call sites.
  const envelope = readFileSync(new URL("../src/envelope.js", import.meta.url), "utf8");
  assert.match(envelope, /message: t\(message\)/, "fail() translates its message");
  assert.match(envelope, /code, message: t\(message\)/, "failResult() translates its message");
}

console.log(`i18n: ${Object.keys(ZH_MESSAGES).length} entries, exact/interpolated lookup, switching and wiring all passed`);
