#!/usr/bin/env node
// check-contrast.mjs — 独立设计的终端外观对比度自检
//
// 用法：node tools/check-contrast.mjs
// 校验两套主题（dark/light）下每个内置类别的默认前景色在其主题默认终端背景上
// 满足 WCAG AA 正文对比度 ≥ 4.5:1（WCAG 2.x 相对亮度公式）。
// 任一类别不达标时打印明细并以非零码退出。

import { COLORS, LIGHT_COLORS } from "../src/client/terminal-display/rules.js";
import { DEFAULT_BACKGROUNDS } from "../src/client/terminal-display/theme.js";

const RATIO_MIN = 4.5;

function channelValue(c) {
  c /= 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a #rrggbb color: ${hex}`);
  const v = parseInt(m[1], 16);
  const r = channelValue((v >> 16) & 0xff);
  const g = channelValue((v >> 8) & 0xff);
  const b = channelValue(v & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(hexFg, hexBg) {
  const l1 = relativeLuminance(hexFg);
  const l2 = relativeLuminance(hexBg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

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

export function checkPalette(colors, background, label) {
  const rows = [];
  let ok = true;
  for (const [category, color] of Object.entries(colors)) {
    const ratio = contrast(color, background);
    const pass = ratio >= RATIO_MIN;
    if (!pass) ok = false;
    rows.push({ label, category, color, background, ratio, hue: hueOf(color), pass });
  }
  return { ok, rows };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
if (isMain) {
  const checks = [
    checkPalette(COLORS, DEFAULT_BACKGROUNDS.dark, "dark"),
    checkPalette(LIGHT_COLORS, DEFAULT_BACKGROUNDS.light, "light"),
  ];
  let allOk = true;
  for (const { ok, rows } of checks) {
    allOk &&= ok;
    for (const r of rows) {
      const flag = r.pass ? "PASS" : "FAIL";
      console.log(
        `${flag} ${r.label.padEnd(5)} ${r.category.padEnd(8)} ${r.color} on ${r.background} ` +
          `ratio=${r.ratio.toFixed(2)} hue=${r.hue.toFixed(0)}°`
      );
    }
  }
  console.log(allOk ? "\nAll palettes meet WCAG AA 4.5:1." : "\nSome colors fall below 4.5:1.");
  process.exit(allOk ? 0 : 1);
}
