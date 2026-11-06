// theme.js — 终端显示主题：宿主 chrome + 独立设计的 ANSI 调色板 + 背景极性自适应
//
// 本文件的 ANSI 16 色调色板为独立设计产物（SPEC §5.2），依据 WCAG 相对亮度与
// 通用终端惯例自行推导，不含任何第三方终端项目的派生内容。
//
// 终端外观的其余部分（背景、前景、光标、选区）来自宿主 DSH 终端主题
// （../terminal-theme.js，INTERFACES §7），极性反转时从中重选。

import {
  DARK_TERMINAL_THEME,
  LIGHT_TERMINAL_THEME,
  createTerminalThemeWatcher,
  getTerminalTheme,
} from "../terminal-theme.js";

// ---------------------------------------------------------------------------
// 宿主终端 chrome（深色/浅色两套；背景同时作为该极性的默认终端背景）
// ---------------------------------------------------------------------------

const HOST_CHROME = Object.freeze({
  dark: DARK_TERMINAL_THEME,
  light: LIGHT_TERMINAL_THEME,
});

// WCAG 相对亮度：高于该阈值视为浅底极性（SPEC §5.3，阈值取浅底一侧）。
const LIGHT_POLARITY_THRESHOLD = 0.179;

function channelValue(c) {
  c /= 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex) {
  const v = parseInt(hex.slice(1), 16);
  const r = channelValue((v >> 16) & 0xff);
  const g = channelValue((v >> 8) & 0xff);
  const b = channelValue(v & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// ---------------------------------------------------------------------------
// 独立设计的 ANSI 16 色调色板（dark/light 各一套，SPEC §5.2）
// ---------------------------------------------------------------------------

const DARK_ANSI = Object.freeze({
  black: "#23262e",
  red: "#e0605e",
  green: "#5fbf77",
  yellow: "#d9a545",
  blue: "#5e8fe0",
  magenta: "#b07fd9",
  cyan: "#4fb8c9",
  white: "#c9cdd6",
  brightBlack: "#4a505c",
  brightRed: "#ef8a80",
  brightGreen: "#7fd99a",
  brightYellow: "#e6bd66",
  brightBlue: "#82aef0",
  brightMagenta: "#c9a1ef",
  brightCyan: "#76cfe0",
  brightWhite: "#eef0f5",
});

const LIGHT_ANSI = Object.freeze({
  black: "#383b43",
  red: "#c93c37",
  green: "#2e8b52",
  yellow: "#a97b1f",
  blue: "#3b6fd4",
  magenta: "#8a4fc9",
  cyan: "#2e8fa3",
  white: "#e8eaef",
  brightBlack: "#6b7078",
  brightRed: "#d96a5f",
  brightGreen: "#4aa876",
  brightYellow: "#bd8f2e",
  brightBlue: "#5f8ade",
  brightMagenta: "#a373d9",
  brightCyan: "#4fa8bb",
  brightWhite: "#ffffff",
});

// ---------------------------------------------------------------------------
// 主题预设：宿主 chrome + ANSI 调色板（xterm ITheme 全字段）
// ---------------------------------------------------------------------------

export const DARK_THEME = Object.freeze({
  ...HOST_CHROME.dark,
  cursorAccent: HOST_CHROME.dark.background,
  ...DARK_ANSI,
});

export const LIGHT_THEME = Object.freeze({
  ...HOST_CHROME.light,
  cursorAccent: HOST_CHROME.light.background,
  ...LIGHT_ANSI,
});

export const DEFAULT_BACKGROUNDS = Object.freeze({
  dark: HOST_CHROME.dark.background,
  light: HOST_CHROME.light.background,
});

// ---------------------------------------------------------------------------
// 宿主主题侦听：首个订阅者开启 watcher，最后一个退订关闭 watcher
// ---------------------------------------------------------------------------

let hostTheme = getTerminalTheme().background === LIGHT_TERMINAL_THEME.background ? "light" : "dark";
const hostListeners = new Set();
let stopWatcher = null;

export function getHostTheme() {
  return hostTheme;
}

function notifyHostTheme() {
  for (const listener of hostListeners) {
    try {
      listener();
    } catch {
      // 单个监听器异常不影响其他订阅者
    }
  }
}

export function subscribeHostTheme(listener) {
  if (typeof listener !== "function") {
    throw new TypeError("subscribeHostTheme(listener): listener must be a function");
  }
  hostListeners.add(listener);
  if (hostListeners.size === 1 && stopWatcher === null) {
    stopWatcher = createTerminalThemeWatcher({
      apply: (theme) => {
        const next = theme.background === LIGHT_TERMINAL_THEME.background ? "light" : "dark";
        if (next === hostTheme) return;
        hostTheme = next;
        notifyHostTheme();
      },
    });
  }
  return () => {
    hostListeners.delete(listener);
    if (hostListeners.size === 0 && stopWatcher !== null) {
      stopWatcher();
      stopWatcher = null;
    }
  };
}

// ---------------------------------------------------------------------------
// 主题解析与背景极性自适应（SPEC §5.3）
// ---------------------------------------------------------------------------

export function resolveDisplayTheme(theme, host = getHostTheme()) {
  if (theme === "dark" || theme === "light") return theme;
  return host === "light" ? "light" : "dark";
}

const HEX6 = /^#[0-9a-f]{6}$/i;

export function terminalTheme(theme, backgrounds = {}) {
  const resolved = resolveDisplayTheme(theme);
  const preset = resolved === "light" ? LIGHT_THEME : DARK_THEME;

  const override = backgrounds?.[resolved];
  if (typeof override !== "string" || !HEX6.test(override)) return preset;

  // 自定义背景可能反转极性：按背景相对亮度从宿主浅/深两套 chrome 重选前景/光标；
  // cursorAccent 与背景一致。
  const background = override.toLowerCase();
  const polarity = relativeLuminance(background) > LIGHT_POLARITY_THRESHOLD ? "light" : "dark";
  const chrome = HOST_CHROME[polarity];

  return Object.freeze({
    ...preset,
    background,
    foreground: chrome.foreground,
    cursor: chrome.cursor,
    cursorAccent: background,
  });
}
