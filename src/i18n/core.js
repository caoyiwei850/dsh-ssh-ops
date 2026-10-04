/**
 * Two-language message layer shared by the host half and the browser half.
 *
 * English is the source language: every user-facing string stays in the code as
 * an English literal and is passed through `t()`. `messages.zh.js` maps those
 * literals to the Chinese wording the plugin shipped before it was translated,
 * so a string only changes language when it has an entry there. Anything
 * without an entry is English in both languages, which is deliberate: the
 * plugin's pre-translation sources already mixed English technical text
 * (driver ids, `SHA256:`, `CSV`, error codes) with Chinese prose, and only the
 * Chinese prose is bilingual.
 *
 * Messages that interpolate values are keyed by their *template source*, e.g.
 * `` `Delete ${name}?` ``, while `t()` receives the already-interpolated string
 * `Delete prod-1?`. Those entries are compiled into anchored patterns and the
 * captured values are substituted back into the Chinese form, so the result is
 * Chinese prose with the original data in place.
 *
 * This module must stay free of React and of browser globals: the host bundle
 * imports it too.
 */
import { zh } from "./messages.zh.js";

/** Languages the plugin ships dictionaries for. */
export const LANGUAGES = ["zh", "en"];

/** Language used until something explicitly selects another one. */
export const DEFAULT_LANGUAGE = "en";

/** Human-readable names, shown in the settings combobox. */
export const LANGUAGE_LABELS = { zh: "中文", en: "English" };

let language = DEFAULT_LANGUAGE;
const listeners = new Set();

/** Coerce anything into a supported language id. */
export function normalizeLanguage(value) {
  return LANGUAGES.includes(value) ? value : DEFAULT_LANGUAGE;
}

export function getLanguage() {
  return language;
}

/**
 * Select the active language and notify subscribers. Returns the language that
 * is active afterwards, so callers can compare it with what they asked for.
 */
export function setLanguage(next) {
  const normalized = normalizeLanguage(next);
  if (normalized === language) return language;
  language = normalized;
  clearMemo();
  for (const listener of [...listeners]) {
    try {
      listener(language);
    } catch (error) {
      // A broken subscriber must not stop the others from updating.
      console.error("[dsh-ssh-ops] language listener failed:", error);
    }
  }
  return language;
}

/** Subscribe to language changes; returns the unsubscribe function. */
export function subscribeLanguage(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ── pattern engine ─────────────────────────────────────────────────────────

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Split a message template into its literal parts. `${...}` groups are matched
 * with brace counting so an interpolation that itself contains an object
 * literal or a nested call still ends at the right brace.
 */
function splitTemplate(pattern) {
  const parts = [];
  let literal = "";
  let index = 0;
  while (index < pattern.length) {
    const start = pattern.indexOf("${", index);
    if (start === -1) {
      literal += pattern.slice(index);
      break;
    }
    literal += pattern.slice(index, start);
    let depth = 0;
    let cursor = start + 1;
    for (; cursor < pattern.length; cursor++) {
      if (pattern[cursor] === "{") depth++;
      else if (pattern[cursor] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    parts.push(literal);
    literal = "";
    index = cursor + 1;
  }
  parts.push(literal);
  return parts;
}

/**
 * Bucket patterns by the first word of their leading literal so a lookup only
 * tests the handful that could possibly match. Patterns that begin with an
 * interpolation land in the "" bucket and are always tried; there are few.
 */
function bucketKey(pattern) {
  const head = pattern.split("${")[0].trim();
  if (!head) return "";
  const word = head.split(/\s+/)[0];
  return word.slice(0, 12).toLowerCase();
}

let compiled = null;

function compileCatalog() {
  if (compiled !== null) return compiled;
  const byBucket = new Map();
  for (const [key, value] of Object.entries(zh)) {
    if (!key.includes("${")) continue;
    const enParts = splitTemplate(key);
    const zhParts = splitTemplate(value);
    // The dictionaries are generated in pairs, so the placeholder counts match;
    // a mismatch would mean a hand-edited entry, and that entry is skipped
    // rather than producing a mangled message.
    if (enParts.length !== zhParts.length) continue;
    const entry = {
      regexp: new RegExp(`^${enParts.map(escapeRegExp).join("([\\s\\S]*?)")}$`),
      zhParts
    };
    const key12 = bucketKey(key);
    const bucket = byBucket.get(key12);
    if (bucket === undefined) byBucket.set(key12, [entry]);
    else bucket.push(entry);
  }
  compiled = byBucket;
  return compiled;
}

/** Memo of already-resolved strings; UI text repeats on every render. */
const memo = new Map();
const MEMO_LIMIT = 4000;

function clearMemo() {
  memo.clear();
}

function translate(text) {
  const exact = zh[text];
  if (exact !== undefined) return exact;

  const cached = memo.get(text);
  if (cached !== undefined) return cached;

  const byBucket = compileCatalog();
  const candidates = [
    ...(byBucket.get(bucketKey(text)) ?? []),
    ...(byBucket.get("") ?? [])
  ];
  for (const entry of candidates) {
    const match = entry.regexp.exec(text);
    if (match === null) continue;
    let out = entry.zhParts[0];
    for (let i = 1; i < entry.zhParts.length; i++) out += (match[i] ?? "") + entry.zhParts[i];
    if (memo.size >= MEMO_LIMIT) memo.clear();
    memo.set(text, out);
    return out;
  }

  if (memo.size >= MEMO_LIMIT) memo.clear();
  memo.set(text, text);
  return text;
}

/**
 * Translate one user-facing string. Non-strings and strings without a Chinese
 * entry are returned unchanged, so a missed string degrades to English instead
 * of rendering blank.
 */
export function t(text) {
  if (typeof text !== "string" || text === "") return text;
  if (language !== "zh") return text;
  return translate(text);
}

/** Whether `text` has a Chinese wording (used by the catalog coverage test). */
export function hasTranslation(text) {
  if (typeof text !== "string") return false;
  return zh[text] !== undefined || compileCatalog().size > 0 && translate(text) !== text;
}

/** The raw dictionary, for tests and tooling. */
export const ZH_MESSAGES = zh;
