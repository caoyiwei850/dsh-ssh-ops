import assert from "node:assert/strict";
import { applyTerminalTheme, createTerminalThemeWatcher, getTerminalTheme } from "../src/client/terminal-theme.js";

function fakeRoot({ className = "", colorScheme = "normal" } = {}) {
  return {
    className, style: {}, colorScheme,
    getAttribute(name) { return name === "class" ? this.className : ""; }
  };
}

// A dark host must give plain xterm output an explicit readable foreground.
{
  const theme = getTerminalTheme({ root: fakeRoot({ className: "theme-dark" }), getComputedStyle: (node) => node });
  assert.deepEqual(theme, {
    background: "#101418", foreground: "#e6edf3", cursor: "#e6edf3",
    cursorAccent: "#101418", selectionBackground: "#315a92", selectionForeground: "#ffffff"
  });
}

// A light host is not merely a dark terminal with a new surrounding panel.
{
  const theme = getTerminalTheme({ root: fakeRoot({ colorScheme: "light" }), getComputedStyle: (node) => node });
  assert.equal(theme.background, "#f7f8fa");
  assert.equal(theme.foreground, "#1d2128");
  assert.notEqual(theme.foreground, theme.background);
}

// Theme application redraws existing pooled xterm instances immediately.
{
  const calls = [];
  const term = { rows: 24, options: {}, refresh: (...args) => calls.push(args) };
  applyTerminalTheme(term, { background: "#fff", foreground: "#111" });
  assert.deepEqual(term.options.theme, { background: "#fff", foreground: "#111" });
  assert.deepEqual(calls, [[0, 23]]);
}

// Theme changes from either DSH root attributes or the system media query are observed.
{
  const observerInstances = [];
  let mediaListener;
  class FakeObserver {
    constructor(callback) { this.callback = callback; observerInstances.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  const media = { matches: false, addEventListener: (_name, listener) => { mediaListener = listener; }, removeEventListener: () => {} };
  const root = fakeRoot({ colorScheme: "light" });
  const seen = [];
  const stop = createTerminalThemeWatcher({
    root, body: {}, getComputedStyle: (node) => node, media, MutationObserver: FakeObserver,
    apply: (theme) => seen.push(theme)
  });
  root.colorScheme = "dark";
  observerInstances[0].callback();
  mediaListener({ matches: false });
  assert.equal(seen.length, 3);
  assert.equal(seen[1].background, "#101418");
  stop();
  assert.equal(observerInstances[0].disconnected, true);
}

console.log("terminal theme: explicit contrast and live theme synchronization passed");
