// terminal-appearance-migration.mjs — MIGRATION.md §1.3 迁移矩阵逐条 + scheme.js 契约
//
// 覆盖：迁移矩阵每一行在 getScheme 上的行为、旧 word/auto 模式归一化、
// normalizeScheme 脏数据容错、patternProblem 错误标识、compileScheme 管线
// 契约（自动识别/纯正则优先级/string 规则位置/context 项）、导入导出往返。

import assert from "node:assert/strict";
import { test } from "node:test";
import { matchText } from "../src/client/terminal-display/matcher.js";

import { COLORS, LIGHT_COLORS, colorsForTheme, HIGHLIGHT_RULES } from "../src/client/terminal-display/rules.js";
import {
  MAX_SCHEME_ENTRIES,
  MAX_SCHEME_TEXT,
  MAX_PATTERN_LENGTH,
  MAX_PATTERNS,
  defaultScheme,
  splitPatterns,
  patternProblem,
  normalizeScheme,
  getScheme,
  compileScheme,
  exportScheme,
  parseSchemeBackup,
} from "../src/client/terminal-display/scheme.js";

const BUILTIN_IDS = Object.keys(COLORS);

test("legacy contains rules preserve literal punctuation through migration and compilation", () => {
  for (const settings of [
    { builtinEnabled: false, customRules: [{ id: "literal", text: "app[1].log", color: "error", match: "contains" }] },
    { schemes: { dark: [{ id: "custom:literal", text: "app[1].log", color: COLORS.error, mode: "contains" }] } },
  ]) {
    const compiled = compileScheme(getScheme(settings, "dark"));
    assert.equal(matchText("app[1].log", compiled.rules, compiled.colors).length, 1);
    assert.equal(matchText("app1Xlog", compiled.rules, compiled.colors).length, 0);
  }
});

test("text limit applies per entry without dropping later saved rules", () => {
  const entries = [0, 1].map((id) => ({ id: `custom:${id}`, text: "x".repeat(5000), color: COLORS.error, mode: "regex" }));
  assert.equal(normalizeScheme(entries).length, 2);
});

function entryOf(scheme, id) {
  return scheme.find((e) => e.id === id);
}

// ---------------------------------------------------------------------------
// 迁移矩阵（MIGRATION.md §1.3 逐条）
// ---------------------------------------------------------------------------

test("矩阵① 全新安装：无 v1 记录 → 直接获得新默认方案", () => {
  for (const theme of ["dark", "light"]) {
    const scheme = getScheme(undefined, theme);
    assert.equal(scheme.length, BUILTIN_IDS.length);
    const colors = colorsForTheme(theme);
    for (const id of BUILTIN_IDS) {
      const entry = entryOf(scheme, id);
      assert.equal(entry.color, colors[id], `${theme}/${id} 应为新默认色`);
      assert.equal(entry.enabled, true);
      assert.equal(typeof entry.text, "string");
      assert.ok(entry.text.length > 0, `${id} 应有新默认匹配文本`);
    }
    // 外观开关默认关、旧布尔键迁移由 settings.js 承载；此处验证"仅开关/主题的
    // v1 默认记录"（矩阵②）同样走默认分支
    const minimal = getScheme({ highlightEnabled: false, theme: "system" }, theme);
    assert.deepEqual(minimal, scheme);
  }
});

test("矩阵③ v1 只有 colors 覆盖 → 保留用户色，未编辑文本采用新默认文本", () => {
  const scheme = getScheme({ colors: { dark: { error: "#ff0000", info: "#123456" } } }, "dark");
  assert.equal(entryOf(scheme, "error").color, "#ff0000");
  assert.equal(entryOf(scheme, "info").color, "#123456");
  assert.equal(entryOf(scheme, "success").color, COLORS.success);
  // 匹配文本未被用户编辑 → 新默认文本（与 defaultScheme 完全一致）
  for (const id of BUILTIN_IDS) {
    assert.equal(entryOf(scheme, id).text, entryOf(defaultScheme("dark"), id).text);
  }
  // 非法颜色值被忽略
  const dirty = getScheme({ colors: { dark: { error: "red", success: "#abc" } } }, "dark");
  assert.equal(entryOf(dirty, "error").color, COLORS.error);
  assert.equal(entryOf(dirty, "success").color, COLORS.success);
});

test("矩阵④ v1 存在 customRules → 原样保留，类别色按新色表解析，未知类别回退", () => {
  const settings = {
    customRules: [
      { id: "r1", text: "myapp", color: "error", match: "contains", caseSensitive: true, enabled: true },
      { id: "r2", text: "boom", color: "no-such-category", match: "regex", caseSensitive: false, enabled: true },
      { id: "r3", text: "quiet", color: "info", match: "regex", caseSensitive: false, enabled: false },
    ],
  };
  const scheme = getScheme(settings, "light");
  const customs = scheme.filter((e) => e.id.startsWith("custom:"));
  assert.equal(customs.length, 3);
  const r1 = entryOf(scheme, "custom:r1");
  assert.equal(r1.name, "myapp");
  assert.equal(r1.text, "myapp");
  assert.equal(r1.color, LIGHT_COLORS.error);
  assert.equal(r1.caseSensitive, true);
  assert.equal(r1.enabled, true);
  // 未知类别名 → 实现定义回退（info 默认色）
  assert.equal(entryOf(scheme, "custom:r2").color, LIGHT_COLORS.info);
  // 用户覆盖色优先于新色表
  const withOverride = getScheme(
    { colors: { light: { error: "#ff0000" } }, customRules: settings.customRules },
    "light"
  );
  assert.equal(entryOf(withOverride, "custom:r1").color, "#ff0000");
});

test("矩阵⑤ 完整 schemes[theme] → 颜色保留；文本=新默认走自动识别，≠按用户编辑保留", () => {
  const defaults = defaultScheme("dark");
  const userEntries = defaults.map((e) => ({ ...e, color: "#aa0000" }));
  // 用户编辑过 error 的匹配文本
  userEntries[0] = { ...userEntries[0], text: "my own pattern" };
  const scheme = getScheme({ schemes: { dark: userEntries } }, "dark");
  assert.equal(scheme.length, defaults.length);
  for (const e of scheme) assert.equal(e.color, "#aa0000", "条目颜色保留");
  assert.equal(entryOf(scheme, "error").text, "my own pattern", "用户编辑文本保留");
  assert.equal(entryOf(scheme, "success").text, entryOf(defaults, "success").text, "未编辑文本=新默认");
  // 编译：error 变纯正则且优先于自动识别；success 仍自动识别
  const compiled = compileScheme(scheme);
  assert.equal(compiled.automatic, true);
  const firstCustom = compiled.rules.findIndex((r) => r.id === "error");
  const firstAuto = compiled.rules.findIndex((r) => r.pattern instanceof RegExp && HIGHLIGHT_RULES.includes(r));
  assert.ok(firstCustom >= 0 && (firstAuto < 0 || firstCustom < firstAuto), "纯正则优先于自动识别");
  assert.ok(!compiled.rules.some((r) => r.id === "error" && HIGHLIGHT_RULES.includes(r)));
});

test("矩阵⑥ builtinEnabled=false → 仅自定义规则生效", () => {
  const scheme = getScheme(
    {
      builtinEnabled: false,
      customRules: [{ id: "r1", text: "myapp", color: "error", match: "contains", caseSensitive: false, enabled: true }],
    },
    "dark"
  );
  assert.equal(scheme.length, 1);
  assert.equal(scheme[0].id, "custom:r1");
  // 显式方案同样过滤内置条目
  const explicit = getScheme(
    { builtinEnabled: false, schemes: { dark: [...defaultScheme("dark")] } },
    "dark"
  );
  assert.equal(explicit.length, 0);
});

test("矩阵⑦ backgrounds 原样保留（exportScheme 原样带出）", () => {
  const settings = { backgrounds: { dark: "#101010", light: "#fefefe" } };
  const exported = JSON.parse(exportScheme(settings, "dark"));
  assert.equal(exported.background, "#101010");
  const exportedLight = JSON.parse(exportScheme(settings, "light"));
  assert.equal(exportedLight.background, "#fefefe");
  // 非法背景值不进入导出：回落该主题的 DSH 默认背景
  const bad = JSON.parse(exportScheme({ backgrounds: { dark: "black" } }, "dark"));
  assert.equal(bad.background, "#101418");
});

// ---------------------------------------------------------------------------
// 旧持久化模式归一化（word/auto → regex）
// ---------------------------------------------------------------------------

test("旧 word/auto 模式条目归一化为 regex 条目", () => {
  const entries = [
    { id: "custom:old1", color: "#ff0000", enabled: true, text: "foo\nbar", mode: "word", caseSensitive: false, name: "foo" },
    { id: "custom:old2", color: "#00ff00", enabled: true, text: "baz.*", mode: "auto", caseSensitive: true },
  ];
  const scheme = getScheme({ schemes: { dark: entries } }, "dark");
  assert.equal(entryOf(scheme, "custom:old1").mode, "regex");
  assert.equal(entryOf(scheme, "custom:old1").text, "(?<![\\p{L}\\p{N}_])(?:foo)(?![\\p{L}\\p{N}_])\n(?<![\\p{L}\\p{N}_])(?:bar)(?![\\p{L}\\p{N}_])");
  assert.equal(entryOf(scheme, "custom:old2").mode, "regex");
  assert.equal(entryOf(scheme, "custom:old2").text, "baz.*");
  assert.equal(entryOf(scheme, "custom:old2").caseSensitive, true);
});

// ---------------------------------------------------------------------------
// normalizeScheme / patternProblem / splitPatterns（TESTS.md §3）
// ---------------------------------------------------------------------------

test("splitPatterns：按行拆分、trim、去重、去空", () => {
  assert.deepEqual([...splitPatterns(" foo \n\nbar\nfoo\n  ")], ["foo", "bar"]);
  assert.deepEqual([...splitPatterns("")], []);
  assert.deepEqual([...splitPatterns(undefined)], []);
});

test("patternProblem：合法/超长/非法正则的错误标识", () => {
  assert.equal(patternProblem("foo\nbar|baz"), "");
  assert.equal(patternProblem(""), "");
  assert.equal(patternProblem("a".repeat(MAX_PATTERN_LENGTH)), "");
  assert.equal(patternProblem("a".repeat(MAX_PATTERN_LENGTH + 1)), "pattern-too-long");
  assert.equal(patternProblem("ok\n" + "b".repeat(MAX_PATTERN_LENGTH + 1)), "pattern-too-long");
  assert.equal(patternProblem("["), "invalid-regex");
  assert.equal(patternProblem("good\n(bad"), "invalid-regex");
  assert.equal(patternProblem("x".repeat(MAX_SCHEME_TEXT + 1)), "pattern-too-long");
  const tooMany = Array.from({ length: MAX_PATTERNS + 1 }, (_, i) => `p${i}`).join("\n");
  assert.equal(patternProblem(tooMany), "pattern-too-long");
});

test("normalizeScheme：未知输入 → undefined；脏数据过滤；结果冻结", () => {
  assert.equal(normalizeScheme(undefined), undefined);
  assert.equal(normalizeScheme(null), undefined);
  assert.equal(normalizeScheme("nope"), undefined);
  assert.equal(normalizeScheme({}), undefined);
  // 超长数组：非法条目全部过滤 → 空数组；合法条目按上限截断
  assert.deepEqual([...normalizeScheme(Array(MAX_SCHEME_ENTRIES + 1).fill({}))], []);
  const many = Array.from({ length: MAX_SCHEME_ENTRIES + 1 }, (_, i) => ({
    id: `custom:${i}`, color: "#ff0000", enabled: true, text: "x", mode: "regex", caseSensitive: false,
  }));
  assert.equal(normalizeScheme(many).length, MAX_SCHEME_ENTRIES);

  const dirty = normalizeScheme([
    { id: "error", color: "#FF0000", enabled: true, text: "x", mode: "regex", caseSensitive: false },
    { id: "", color: "#ff0000", enabled: true, text: "x", mode: "regex", caseSensitive: false },
    { id: "ok", color: "red", enabled: true, text: "x", mode: "regex", caseSensitive: false },
    { id: "ctl", color: "#ff0000", enabled: true, text: "a\x07b", mode: "regex", caseSensitive: false },
    { id: "badmode", color: "#ff0000", enabled: true, text: "x", mode: "nonsense", caseSensitive: false },
  ]);
  assert.equal(dirty.length, 2, "非法条目被过滤，未知 mode 回退 regex");
  assert.equal(dirty[0].color, "#ff0000", "颜色归一化为小写");
  assert.equal(dirty[1].id, "badmode");
  assert.equal(dirty[1].mode, "regex");
  assert.ok(Object.isFrozen(dirty));
  assert.ok(Object.isFrozen(dirty[0]));
});

// ---------------------------------------------------------------------------
// compileScheme 管线契约（INTERFACES §4）
// ---------------------------------------------------------------------------

test("compileScheme：默认方案 → 全量自动识别 + context 项", () => {
  const compiled = compileScheme(defaultScheme("dark"));
  assert.equal(compiled.automatic, true);
  assert.deepEqual(compiled.context, ["command", "prompt", "string"]);
  // colors 覆盖全部内置类别
  for (const id of BUILTIN_IDS) {
    assert.equal(compiled.colors[id], COLORS[id]);
  }
  // 规则来自内置规则集，末尾为 context 项
  const contextItem = compiled.rules[compiled.rules.length - 1];
  assert.deepEqual(contextItem, { id: "context", context: ["command", "prompt", "string"] });
  for (const rule of compiled.rules.slice(0, -1)) {
    assert.ok(HIGHLIGHT_RULES.includes(rule), `自动规则应来自内置规则集: ${rule.id}`);
  }
});

test("compileScheme：自定义正则优先，其余保留内置 token 优先级", () => {
  const entries = defaultScheme("dark").map((e) =>
    e.id === "error" ? { ...e, text: "my own error pattern" } : e
  );
  const compiled = compileScheme(entries);
  const idxCustom = compiled.rules.findIndex((r) => r.id === "error");
  assert.equal(idxCustom, 0);
  assert.deepEqual(compiled.rules.filter((r) => HIGHLIGHT_RULES.includes(r)),
    HIGHLIGHT_RULES.filter((r) => r.color !== "error"));
  // 用户编辑的 error 编译为纯正则
  assert.equal(compiled.rules[idxCustom].pattern.source, "(?:my own error pattern)");
  assert.ok(compiled.rules[idxCustom].pattern.global);
  assert.ok(compiled.rules[idxCustom].pattern.ignoreCase, "条目不区分大小写设置保留");
  // 大小写敏感变体即使文本相同也不走自动识别
  const sensitive = compileScheme(
    defaultScheme("dark").map((e) => (e.id === "number" ? { ...e, caseSensitive: true } : e))
  );
  assert.ok(sensitive.rules.some((r) => r.id === "number" && !HIGHLIGHT_RULES.includes(r)));
});

test("compileScheme：禁用条目不出规则但保留颜色；损坏方案回退为空", () => {
  const entries = defaultScheme("dark").map((e) => (e.id === "error" ? { ...e, enabled: false } : e));
  const compiled = compileScheme(entries);
  assert.equal(compiled.colors.error, COLORS.error);
  assert.ok(!compiled.rules.some((r) => r.id === "error"));
  // context 项仍产生（command/prompt/string 均默认启用）
  assert.deepEqual(compiled.context, ["command", "prompt", "string"]);

  // string/prompt/command 任一被禁用或编辑 → 不产生 context 项
  const noString = defaultScheme("dark").map((e) =>
    e.id === "string" ? { ...e, text: "custom string pattern" } : e
  );
  assert.equal(compileScheme(noString).context, undefined);
});

test("compileScheme：合法正则运行、非法正则跳过", () => {
  const compiled = compileScheme([
    { id: "custom:x", color: "#ff0000", enabled: true, text: "hello|world", mode: "regex", caseSensitive: false },
    { id: "custom:bad", color: "#ff0000", enabled: true, text: "(broken", mode: "regex", caseSensitive: false },
  ]);
  const ids = compiled.rules.map((r) => r.id);
  assert.ok(ids.includes("custom:x"));
  assert.ok(!ids.includes("custom:bad"));
  assert.ok(compiled.rules.find((r) => r.id === "custom:x").pattern.test("HELLO"));
});

// ---------------------------------------------------------------------------
// 导入导出往返（SPEC §6 / MIGRATION §1.4）
// ---------------------------------------------------------------------------

test("exportScheme：格式标识、版本 2、往返一致", () => {
  const settings = {
    colors: { error: "#ff0000" },
    backgrounds: { dark: "#101010" },
    customRules: [{ id: "r1", text: "myapp", color: "success", match: "word", caseSensitive: false, enabled: true }],
  };
  const json = exportScheme(settings, "dark");
  const parsed = JSON.parse(json);
  assert.equal(parsed.format, "dsh-ssh-ops.color-scheme");
  assert.equal(parsed.version, 2);
  assert.equal(parsed.theme, "dark");
  assert.equal(parsed.background, "#101010");
  // 往返：导出的条目可被 normalizeScheme 接受且语义一致
  const roundTrip = normalizeScheme(parsed.entries);
  assert.ok(roundTrip !== undefined);
  assert.deepEqual([...roundTrip], [...getScheme(settings, "dark")]);
  // word 模式自定义规则在 getScheme 映射时已归一化为整词正则
  const r1 = entryOf(roundTrip, "custom:r1");
  assert.equal(r1.text, "(?<![\\p{L}\\p{N}_])(?:myapp)(?![\\p{L}\\p{N}_])");
  assert.equal(r1.mode, "regex");
  // 旧版本/缺字段的导出形状不爆炸
  assert.equal(normalizeScheme({ format: "dsh-ssh-ops.color-scheme", version: 1 }), undefined);
});

test("backup import validates all entries and preserves theme and background", () => {
  const json = exportScheme({ backgrounds: { light: "#123456" } }, "light");
  const result = parseSchemeBackup(json);
  assert.equal(result.theme, "light");
  assert.equal(result.background, "#123456");
  assert.deepEqual(result.entries, getScheme({}, "light"));
  const malformed = JSON.parse(json);
  malformed.entries.push(malformed.entries[0]);
  assert.throws(() => parseSchemeBackup(JSON.stringify(malformed)), /invalid-backup/);
  malformed.entries.pop(); malformed.background = "bad";
  assert.throws(() => parseSchemeBackup(JSON.stringify(malformed)), /invalid-backup/);
  assert.throws(() => parseSchemeBackup("not json"), /invalid-backup/);
});
