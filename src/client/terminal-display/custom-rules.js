import { COLORS } from "./rules.js";

export const MAX_CUSTOM_RULES = 32;
export const MAX_RULE_TEXT = 128;

// Literal text only: users never need regex escaping, and a saved pattern
// cannot introduce unbounded regular-expression backtracking on terminal data.
export function normalizeCustomRules(value) {
  if (!Array.isArray(value)) return [];
  const ids = new Set(), rules = [];
  for (const entry of value) {
    if (rules.length >= MAX_CUSTOM_RULES) break;
    if (!entry || typeof entry.id !== "string" || !entry.id || entry.id.length > 80 || ids.has(entry.id)
      || typeof entry.text !== "string" || !entry.text.trim() || entry.text.length > MAX_RULE_TEXT
      || /[\r\n\x00-\x1f]/.test(entry.text) || !Object.hasOwn(COLORS, entry.color)) continue;
    ids.add(entry.id);
    rules.push(Object.freeze({ id: entry.id, text: entry.text, color: entry.color,
      match: entry.match === "word" ? "word" : "contains",
      caseSensitive: entry.caseSensitive === true, enabled: entry.enabled !== false }));
  }
  return rules;
}

export function compileCustomRules(rules) {
  return normalizeCustomRules(rules).filter((rule) => rule.enabled).map((rule) => {
    const literal = rule.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return { id: `custom:${rule.id}`, color: rule.color,
      pattern: new RegExp(rule.match === "word" ? `(?<![\\p{L}\\p{N}_])${literal}(?![\\p{L}\\p{N}_])` : literal,
        rule.caseSensitive ? "gu" : "giu") };
  });
}
