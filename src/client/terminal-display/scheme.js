// scheme.js — 配色方案：默认值、归一化、编译、用户配置迁移、导入导出
//
// 本文件为整文件重写的独立设计产物：默认方案的配色与匹配文本来自新
// rules.js（独立推导），不携带任何旧实现的默认文本常量；用户自己的数据
//（显式改过/新增的颜色、匹配文本、自定义规则、背景）按 MIGRATION.md §1.3
// 原样保留。

import { COLORS, HIGHLIGHT_RULES, colorsForTheme } from "./rules.js";
import { DEFAULT_BACKGROUNDS } from "./theme.js";

// ---------------------------------------------------------------------------
// 常量（INTERFACES §4）
// ---------------------------------------------------------------------------

export const MAX_SCHEME_ENTRIES = 43; // 32 条自定义 + 11 条内置
export const MAX_SCHEME_TEXT = 8192;
export const MAX_PATTERN_LENGTH = 512;
export const MAX_PATTERNS = 64;

const HEX6 = /^#[0-9a-f]{6}$/i;
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const ENTRY_MODES = new Set(["regex", "word", "contains", "auto"]);
const CUSTOM_MATCH_MODES = new Set(["word", "contains", "regex"]);
// word 模式的匹配文本是字面量：包裹整词边界前先转义正则元字符。
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const BUILTIN_IDS = Object.freeze(Object.keys(COLORS));
const isBuiltinId = (id) => BUILTIN_IDS.includes(id);

// ---------------------------------------------------------------------------
// 默认匹配文本：由新内置规则集生成（每行一条模式的正则源，SPEC §6）
// ---------------------------------------------------------------------------

const DEFAULT_TEXTS = Object.freeze(
  Object.fromEntries(
    BUILTIN_IDS.map((category) => [
      category,
      HIGHLIGHT_RULES.filter((rule) => rule.color === category)
        .map((rule) => rule.pattern.source)
        .join("\n"),
    ])
  )
);

const defaultTextFor = (id) => DEFAULT_TEXTS[id];

const defaultSchemeCache = new Map();

export function defaultScheme(theme) {
  const t = theme === "light" ? "light" : "dark";
  if (!defaultSchemeCache.has(t)) {
    const colors = colorsForTheme(t);
    const entries = BUILTIN_IDS.map((category) =>
      Object.freeze({
        id: category,
        color: colors[category],
        enabled: true,
        text: DEFAULT_TEXTS[category],
        mode: "regex",
        caseSensitive: false,
      })
    );
    defaultSchemeCache.set(t, Object.freeze(entries));
  }
  return defaultSchemeCache.get(t);
}

// ---------------------------------------------------------------------------
// 模式文本工具（INTERFACES §4）
// ---------------------------------------------------------------------------

export function splitPatterns(text) {
  if (typeof text !== "string") return Object.freeze([]);
  const seen = new Set();
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return Object.freeze(out);
}

export function patternProblem(source) {
  if (typeof source !== "string") return "invalid-regex";
  if (source.length > MAX_SCHEME_TEXT) return "pattern-too-long";
  const lines = splitPatterns(source);
  if (lines.length > MAX_PATTERNS) return "pattern-too-long";
  for (const line of lines) {
    if (line.length > MAX_PATTERN_LENGTH) return "pattern-too-long";
  }
  for (const line of lines) {
    try {
      new RegExp(line, "u");
    } catch {
      return "invalid-regex";
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// 归一化（INTERFACES §4：未知输入 → undefined；合法 → 冻结条目数组）
// ---------------------------------------------------------------------------

function normalizeEntry(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const id = raw.id;
  if (typeof id !== "string" || id.length === 0 || id.length > 64) return undefined;
  if (typeof raw.color !== "string" || !HEX6.test(raw.color)) return undefined;
  if (typeof raw.text !== "string" || raw.text.length > MAX_SCHEME_TEXT) return undefined;
  if (CONTROL_CHARS.test(raw.text)) return undefined;
  const entry = {
    id,
    color: raw.color.toLowerCase(),
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    text: raw.text.replace(/\r\n?/g, "\n"),
    mode: ENTRY_MODES.has(raw.mode) ? raw.mode : "regex",
    caseSensitive: typeof raw.caseSensitive === "boolean" ? raw.caseSensitive : false,
  };
  if (typeof raw.name === "string" && raw.name.length > 0 && raw.name.length <= 128) {
    entry.name = raw.name;
  }
  return entry;
}

export function normalizeScheme(value) {
  if (!Array.isArray(value)) return undefined;
  const entries = [];
  const ids = new Set();
  for (const raw of value) {
    const entry = normalizeEntry(raw);
    if (entry === undefined) continue; // 过滤非法条目
    if (ids.has(entry.id)) continue; // 重复 id 只保留首条
    ids.add(entry.id);
    if (entries.length >= MAX_SCHEME_ENTRIES) break;
    entries.push(Object.freeze(entry));
  }
  return Object.freeze(entries);
}

// ---------------------------------------------------------------------------
// 用户配置迁移（MIGRATION.md §1.3）
// ---------------------------------------------------------------------------

function sanitizeColorOverrides(colors) {
  const out = {};
  if (colors === null || typeof colors !== "object" || Array.isArray(colors)) return out;
  for (const [id, value] of Object.entries(colors)) {
    if (isBuiltinId(id) && typeof value === "string" && HEX6.test(value)) {
      out[id] = value.toLowerCase();
    }
  }
  return out;
}

// word 模式的文本转为等价整词正则（MIGRATION.md §1.3 归一化为 regex 条目）。
// 整词边界必须用 Unicode 感知的前后查找：CJK 不在 \w 内，\b 永远不匹配其边缘。
const wordLineToRegex = (line) => `(?<![\\p{L}\\p{N}_])(?:${escapeRegExp(line)})(?![\\p{L}\\p{N}_])`;
function wordTextToRegex(text) {
  const lines = splitPatterns(text);
  if (lines.length === 0) return "";
  return lines.map(wordLineToRegex).join("\n");
}

// 旧持久化 word/auto 模式 → regex 条目
function normalizeLegacyMode(entry) {
  if (entry.mode === "word") {
    return { ...entry, mode: "regex", text: wordTextToRegex(entry.text) };
  }
  if (entry.mode === "auto") {
    return { ...entry, mode: "regex" };
  }
  if (entry.mode === "contains") {
    return { ...entry, mode: "regex", text: splitPatterns(entry.text).map(escapeRegExp).join("\n") };
  }
  return entry;
}

// 按 INTERFACES §8 契约消费 custom-rules 形状的数据（不读其源码，宽松校验）
function normalizeCustomRuleLoose(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  if (typeof raw.id !== "string" || raw.id.length === 0 || raw.id.length > 64) return undefined;
  if (typeof raw.text !== "string" || raw.text.length === 0 || raw.text.length > 128) return undefined;
  if (CONTROL_CHARS.test(raw.text)) return undefined;
  const match = CUSTOM_MATCH_MODES.has(raw.match) ? raw.match : "regex";
  return Object.freeze({
    id: raw.id,
    text: raw.text,
    color: typeof raw.color === "string" ? raw.color : "info",
    match,
    caseSensitive: raw.caseSensitive === true,
    enabled: raw.enabled !== false,
  });
}

function customRuleToEntry(rule, theme, overrides) {
  const defaults = colorsForTheme(theme);
  // 类别色按新色表解析，未知类别名回退到 info 默认色（实现定义）
  const color = Object.hasOwn(defaults, rule.color)
    ? (overrides[rule.color] ?? defaults[rule.color])
    : defaults.info;
  const isWord = rule.match === "word";
  return Object.freeze({
    id: `custom:${rule.id}`,
    name: rule.text,
    color,
    enabled: rule.enabled,
    text: isWord ? wordTextToRegex(rule.text) : rule.match === "contains" ? escapeRegExp(rule.text) : rule.text,
    mode: "regex",
    caseSensitive: rule.caseSensitive,
  });
}

// 显式方案逐条 reconcile：颜色保留；旧模式归一化；文本保留（与新默认相同的
// 文本在 compileScheme 中走自动识别，不同的按用户编辑的纯正则处理）
function reconcileEntry(entry) {
  return Object.freeze(normalizeLegacyMode(entry));
}

export function getScheme(settings, theme) {
  const t = theme === "light" ? "light" : "dark";
  const s = settings !== null && typeof settings === "object" ? settings : {};
  const builtinOff = s.builtinEnabled === false;

  // 分支 1：显式保存的用户方案（v1 存在完整 schemes[theme]）
  const explicit = normalizeScheme(s.schemes?.[t]);
  if (explicit !== undefined) {
    const entries = explicit.map(reconcileEntry);
    const filtered = builtinOff ? entries.filter((e) => !isBuiltinId(e.id)) : entries;
    return Object.freeze(filtered);
  }

  // 分支 2：合成——新默认 + 用户颜色覆盖 + 自定义规则映射
  const overrides = sanitizeColorOverrides(s.colors?.[t]);
  const hasColors = Object.keys(overrides).length > 0;
  const customRules = (Array.isArray(s.customRules) ? s.customRules : [])
    .map(normalizeCustomRuleLoose)
    .filter((rule) => rule !== undefined)
    .map((rule) => customRuleToEntry(rule, t, overrides));

  // 无任何定制 → 直接获得新默认方案
  if (!hasColors && customRules.length === 0 && !builtinOff) {
    return defaultScheme(t);
  }

  const out = [];
  if (!builtinOff) {
    for (const entry of defaultScheme(t)) {
      const override = overrides[entry.id];
      out.push(override !== undefined ? Object.freeze({ ...entry, color: override }) : entry);
    }
  }
  out.push(...customRules);
  return Object.freeze(out);
}

// ---------------------------------------------------------------------------
// 编译（INTERFACES §4：条目数组 → matcher 消费对象）
// ---------------------------------------------------------------------------

function compileEntryPattern(entry) {
  let lines = splitPatterns(entry.text);
  if (lines.length === 0) return undefined;
  if (entry.mode === "word") {
    lines = lines.map(wordLineToRegex);
  } else if (entry.mode === "contains") {
    lines = lines.map(escapeRegExp);
  }
  const source = lines.map((line) => `(?:${line})`).join("|");
  try {
    return new RegExp(source, `g${entry.caseSensitive ? "" : "i"}u`);
  } catch {
    return undefined; // 入口校验：非法正则在编译时跳过
  }
}

export function compileScheme(entries) {
  const list = normalizeScheme(entries) ?? [];
  const colors = {};
  const customRules = [];
  const automaticIds = new Set();
  let automatic = false;

  for (const entry of list) {
    // colors 以条目 id 为键（含 custom:* 条目），matcher 用 colors[rule.color] 解析。
    colors[entry.id] = entry.color;
    if (entry.enabled === false) continue;
    const defaultText = defaultTextFor(entry.id);
    const isAutomatic =
      defaultText !== undefined &&
      entry.caseSensitive === false &&
      entry.mode !== "word" &&
      entry.text.trim() === defaultText.trim();
    if (isAutomatic) {
      automatic = true;
      automaticIds.add(entry.id);
      continue;
    }
    const pattern = compileEntryPattern(entry);
    if (pattern === undefined) continue;
    customRules.push({ id: entry.id, color: entry.id, pattern, name: entry.name });
  }

  // Keep the independently designed token priority: quoted strings precede
  // commands, and commands precede paths. User patterns take priority.
  const autoRules = HIGHLIGHT_RULES.filter((rule) => automaticIds.has(rule.color));
  const rules = [...customRules, ...autoRules];

  // context 项仅在 command/prompt/string 默认启用时产生
  let context;
  if (["command", "prompt", "string"].every((id) => automaticIds.has(id))) {
    context = ["command", "prompt", "string"];
    rules.push({ id: "context", context });
  }

  return { colors, rules, automatic, context };
}

// ---------------------------------------------------------------------------
// 导入导出（SPEC §6 / MIGRATION §1.4：format 标识 + version 2 往返一致）
// ---------------------------------------------------------------------------

export function exportScheme(settings, theme) {
  const t = theme === "light" ? "light" : "dark";
  const s = settings !== null && typeof settings === "object" ? settings : {};
  const rawBg = s.backgrounds?.[t];
  const background = typeof rawBg === "string" && HEX6.test(rawBg) ? rawBg.toLowerCase() : DEFAULT_BACKGROUNDS[t];
  return JSON.stringify(
    {
      format: "dsh-ssh-ops.color-scheme",
      version: 2,
      theme: t,
      background,
      entries: getScheme(s, t),
    },
    null,
    2
  );
}

/** Validate a complete exported backup before replacing any preferences. */
export function parseSchemeBackup(text) {
  if (typeof text !== "string" || text.length > 1024 * 1024) throw new Error("invalid-backup");
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("invalid-backup"); }
  if (!value || value.format !== "dsh-ssh-ops.color-scheme" || value.version !== 2
    || !["dark", "light"].includes(value.theme) || typeof value.background !== "string"
    || !HEX6.test(value.background) || !Array.isArray(value.entries) || value.entries.length > MAX_SCHEME_ENTRIES) throw new Error("invalid-backup");
  const entries = normalizeScheme(value.entries);
  if (!entries || entries.length !== value.entries.length) throw new Error("invalid-backup");
  return { theme: value.theme, background: value.background.toLowerCase(), entries };
}
