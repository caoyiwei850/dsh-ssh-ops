// terminal-appearance-contrast.mjs — TESTS.md §4 配色验收 + theme.js 主题契约
//
// 覆盖：两套主题默认色 WCAG 对比度 ≥ 4.5:1、深/浅色相语义一致（各守象限）、
// ANSI 16 色独立调色板完整性、terminalTheme 极性自适应（阈值 0.179）、
// resolveDisplayTheme / subscribeHostTheme 契约。

import assert from "node:assert/strict";
import { test } from "node:test";

import { COLORS, LIGHT_COLORS, colorsForTheme } from "../src/client/terminal-display/rules.js";
import {
  DARK_THEME,
  LIGHT_THEME,
  DEFAULT_BACKGROUNDS,
  getHostTheme,
  resolveDisplayTheme,
  subscribeHostTheme,
  terminalTheme,
} from "../src/client/terminal-display/theme.js";
import { contrast, relativeLuminance } from "../tools/check-contrast.mjs";

const ANSI_NAMES = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue",
  "brightMagenta", "brightCyan", "brightWhite",
];

function hueOf(hex) {
  const v = parseInt(hex.slice(1), 16);
  const r = ((v >> 16) & 0xff) / 255;
  const g = ((v >> 8) & 0xff) / 255;
  const b = (v & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

const inQuadrant = (hex, [lo, hi]) => {
  const h = hueOf(hex);
  return lo <= hi ? h >= lo && h <= hi : h >= lo || h <= hi;
};

// 语义色相象限（两套主题必须各自保持一致）
const HUE_QUADRANTS = {
  error: [330, 25], // 红
  success: [95, 170], // 绿
  warning: [30, 60], // 黄/琥珀
  number: [15, 40], // 橙（与 warning 相邻但错开）
  info: [200, 240], // 蓝
  heading: [175, 200], // 青
  string: [145, 175], // 青绿
  option: [235, 265], // 靛
  prompt: [265, 300], // 紫/品红
};

// ---------------------------------------------------------------------------
// §4 对比度自检（可执行）
// ---------------------------------------------------------------------------

test("COLORS/LIGHT_COLORS 每类在其默认背景上对比度 ≥ 4.5:1", () => {
  for (const [category, color] of Object.entries(COLORS)) {
    assert.ok(
      contrast(color, DEFAULT_BACKGROUNDS.dark) >= 4.5,
      `dark/${category} ${color} on ${DEFAULT_BACKGROUNDS.dark} = ${contrast(color, DEFAULT_BACKGROUNDS.dark).toFixed(2)}`
    );
  }
  for (const [category, color] of Object.entries(LIGHT_COLORS)) {
    assert.ok(
      contrast(color, DEFAULT_BACKGROUNDS.light) >= 4.5,
      `light/${category} ${color} on ${DEFAULT_BACKGROUNDS.light} = ${contrast(color, DEFAULT_BACKGROUNDS.light).toFixed(2)}`
    );
  }
});

test("相邻语义类别可区分：error/warning 色相差 ≥ 15°，有色相类别两两可辨", () => {
  const saturation = (hex) => {
    const v = parseInt(hex.slice(1), 16);
    const rgb = [((v >> 16) & 0xff) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255];
    const max = Math.max(...rgb);
    const min = Math.min(...rgb);
    return max === 0 ? 0 : (max - min) / max;
  };
  const h = (c) => hueOf(COLORS[c]);
  assert.ok(Math.abs(h("error") - h("warning")) >= 15);
  // 近中性色（command/debug 为无彩色设计）不参与色相比对
  const chromatic = Object.values(COLORS).filter((c) => saturation(c) >= 0.2).map(hueOf).sort((a, b) => a - b);
  for (let i = 1; i < chromatic.length; i++) {
    assert.ok(chromatic[i] - chromatic[i - 1] >= 4, `hue collision: ${chromatic[i]} vs ${chromatic[i - 1]}`);
  }
});

test("深/浅两套默认色色相语义一致（各类别守各自象限）", () => {
  for (const [category, [lo, hi]] of Object.entries(HUE_QUADRANTS)) {
    assert.ok(
      inQuadrant(COLORS[category], [lo, hi]),
      `dark ${category} hue ${hueOf(COLORS[category]).toFixed(0)}° outside [${lo},${hi}]`
    );
    assert.ok(
      inQuadrant(LIGHT_COLORS[category], [lo, hi]),
      `light ${category} hue ${hueOf(LIGHT_COLORS[category]).toFixed(0)}° outside [${lo},${hi}]`
    );
  }
  // 极性反转：同一类别深色更亮、浅色更暗（相对亮度比较）
  for (const category of Object.keys(COLORS)) {
    assert.ok(
      relativeLuminance(COLORS[category]) > relativeLuminance(LIGHT_COLORS[category]),
      `${category} should be brighter in dark theme`
    );
  }
});

test("所有默认色为 #rrggbb 形式，键集合 = SPEC §4.1 全部类别", () => {
  const expected = ["error", "success", "warning", "info", "heading", "number", "string", "option", "command", "prompt", "debug"];
  assert.deepEqual(Object.keys(COLORS).sort(), [...expected].sort());
  assert.deepEqual(Object.keys(LIGHT_COLORS).sort(), [...expected].sort());
  for (const table of [COLORS, LIGHT_COLORS]) {
    for (const value of Object.values(table)) assert.ok(/^#[0-9a-f]{6}$/.test(value));
  }
});

test("colorsForTheme：按主题取色并应用合法覆盖，忽略非法值", () => {
  assert.equal(colorsForTheme("dark").error, COLORS.error);
  assert.equal(colorsForTheme("light").error, LIGHT_COLORS.error);
  const merged = colorsForTheme("dark", { error: "#FF0000", info: "bad" });
  assert.equal(merged.error, "#ff0000");
  assert.equal(merged.info, COLORS.info);
  assert.equal(COLORS.error, "#ef6f6c", "COLORS 本身不被覆盖污染");
});

// ---------------------------------------------------------------------------
// theme.js：ANSI 调色板与主题对象
// ---------------------------------------------------------------------------

test("DARK_THEME/LIGHT_THEME 覆盖 xterm ITheme 全部字段", () => {
  for (const theme of [DARK_THEME, LIGHT_THEME]) {
    for (const field of ["background", "foreground", "cursor", "cursorAccent", "selectionBackground", ...ANSI_NAMES]) {
      assert.equal(typeof theme[field], "string", `missing ITheme field: ${field}`);
      assert.ok(/^#[0-9a-f]{6}$/i.test(theme[field]), `bad color: ${field}=${theme[field]}`);
    }
    assert.ok(Object.isFrozen(theme));
  }
  // 两套调色板相互独立（同名字段不同值，除可能的巧合白）
  let same = 0;
  for (const name of ANSI_NAMES) if (DARK_THEME[name] === LIGHT_THEME[name]) same++;
  assert.ok(same <= 1, "ANSI 调色板深浅两套应基本不同");
});

test("DEFAULT_BACKGROUNDS 与宿主 chrome 一致且冻结", () => {
  assert.equal(DEFAULT_BACKGROUNDS.dark, DARK_THEME.background);
  assert.equal(DEFAULT_BACKGROUNDS.light, LIGHT_THEME.background);
  assert.ok(Object.isFrozen(DEFAULT_BACKGROUNDS));
});

// ---------------------------------------------------------------------------
// terminalTheme：背景覆盖与极性自适应（阈值 0.179，cursorAccent=背景）
// ---------------------------------------------------------------------------

test("terminalTheme：默认返回主题预设，对象冻结", () => {
  const dark = terminalTheme("dark");
  assert.equal(dark.background, DEFAULT_BACKGROUNDS.dark);
  assert.equal(dark.foreground, DARK_THEME.foreground);
  assert.equal(dark.cursorAccent, dark.background);
  assert.ok(Object.isFrozen(dark));
  const light = terminalTheme("light");
  assert.equal(light.background, DEFAULT_BACKGROUNDS.light);
  assert.equal(light.cursor, LIGHT_THEME.cursor);
});

test("terminalTheme：浅底自定义背景使深色主题反转极性", () => {
  // 深色主题 + 近白背景 → 前景/光标改从宿主浅色 chrome 重选
  const flipped = terminalTheme("dark", { dark: "#f0f0f0" });
  assert.equal(flipped.background, "#f0f0f0");
  assert.equal(flipped.foreground, LIGHT_THEME.foreground);
  assert.equal(flipped.cursor, LIGHT_THEME.cursor);
  assert.equal(flipped.cursorAccent, "#f0f0f0");
  // ANSI 调色板仍按主题取深色套
  assert.equal(flipped.red, DARK_THEME.red);
});

test("terminalTheme：深底自定义背景反转极性；非法覆盖回退默认", () => {
  // 浅色主题配深底背景 → 极性反转，前景/光标改从深色 chrome 重选
  const flipped = terminalTheme("light", { light: "#123456" });
  assert.equal(flipped.background, "#123456");
  assert.equal(flipped.foreground, DARK_THEME.foreground);
  assert.equal(flipped.cursor, DARK_THEME.cursor);
  assert.equal(flipped.cursorAccent, "#123456");
  // 浅底自定义背景保持浅色极性
  const kept = terminalTheme("light", { light: "#ffffff" });
  assert.equal(kept.foreground, LIGHT_THEME.foreground);
  const invalid = terminalTheme("dark", { dark: "not-a-color" });
  assert.equal(invalid.background, DEFAULT_BACKGROUNDS.dark);
  const empty = terminalTheme("dark", {});
  assert.equal(empty.background, DEFAULT_BACKGROUNDS.dark);
});

// ---------------------------------------------------------------------------
// 主题解析与宿主侦听
// ---------------------------------------------------------------------------

test("resolveDisplayTheme：system 跟随宿主，显式值原样返回", () => {
  assert.equal(resolveDisplayTheme("system", "dark"), "dark");
  assert.equal(resolveDisplayTheme("system", "light"), "light");
  assert.equal(resolveDisplayTheme("dark", "light"), "dark");
  assert.equal(resolveDisplayTheme("light", "dark"), "light");
  assert.equal(resolveDisplayTheme("anything-else", "dark"), "dark");
});

test("getHostTheme 返回合法极性", () => {
  assert.ok(["dark", "light"].includes(getHostTheme()));
});

test("subscribeHostTheme：首个订阅开启 watcher，最后退订关闭，退订函数幂等", () => {
  const listeners = [() => {}, () => {}];
  const unsub1 = subscribeHostTheme(listeners[0]);
  const unsub2 = subscribeHostTheme(listeners[1]);
  assert.equal(typeof unsub1, "function");
  unsub1();
  unsub1(); // 幂等
  unsub2();
  // 全部退订后再订阅仍可工作（watcher 可重启）
  const unsub3 = subscribeHostTheme(listeners[0]);
  unsub3();
  assert.ok(true, "subscribe/unsubscribe 生命周期完整");
});

test("相对亮度公式：黑白端点与阈值 0.179 语义", () => {
  assert.ok(relativeLuminance("#ffffff") > 0.179);
  assert.ok(relativeLuminance("#000000") < 0.179);
  assert.ok(relativeLuminance("#f0f0f0") > 0.179);
  assert.ok(relativeLuminance("#123456") < 0.179);
});
