import assert from "node:assert/strict";
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_KEY,
  clampFontSize,
  createWheelZoom,
  loadTerminalFontSize,
  saveTerminalFontSize
} from "../src/client/terminal-zoom.js";

// 终端 Ctrl+滚轮缩放（issue #36-1）的纯逻辑：范围钳制、持久化、滚轮累积判步。

// ── clamp ───────────────────────────────────────────────────────────────────
assert.equal(clampFontSize(13), 13);
assert.equal(clampFontSize(13.4), 13);
assert.equal(clampFontSize("16"), 16);
assert.equal(clampFontSize(MIN_TERMINAL_FONT_SIZE - 5), MIN_TERMINAL_FONT_SIZE);
assert.equal(clampFontSize(MAX_TERMINAL_FONT_SIZE + 50), MAX_TERMINAL_FONT_SIZE);
assert.equal(clampFontSize(NaN), DEFAULT_TERMINAL_FONT_SIZE);
assert.equal(clampFontSize("garbage"), DEFAULT_TERMINAL_FONT_SIZE);
assert.equal(clampFontSize(undefined), DEFAULT_TERMINAL_FONT_SIZE);

// ── persistence ─────────────────────────────────────────────────────────────
{
  const store = new Map();
  const storage = { getItem: (k) => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, v) };
  assert.equal(loadTerminalFontSize(storage), DEFAULT_TERMINAL_FONT_SIZE, "nothing stored → default");
  saveTerminalFontSize(17, storage);
  assert.equal(store.get(TERMINAL_FONT_SIZE_KEY), "17");
  assert.equal(loadTerminalFontSize(storage), 17);
  store.set(TERMINAL_FONT_SIZE_KEY, "999");
  assert.equal(loadTerminalFontSize(storage), MAX_TERMINAL_FONT_SIZE, "stored garbage is clamped, not trusted");
  store.set(TERMINAL_FONT_SIZE_KEY, "abc");
  assert.equal(loadTerminalFontSize(storage), DEFAULT_TERMINAL_FONT_SIZE);

  const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
  assert.equal(loadTerminalFontSize(broken), DEFAULT_TERMINAL_FONT_SIZE, "a throwing storage degrades to the default");
  assert.doesNotThrow(() => saveTerminalFontSize(14, broken));
  assert.equal(loadTerminalFontSize(undefined), DEFAULT_TERMINAL_FONT_SIZE, "no storage at all (SSR/tests) → default");
}

// ── wheel → zoom steps ──────────────────────────────────────────────────────
{
  const zoom = createWheelZoom({ threshold: 24 });
  assert.equal(zoom({ ctrlKey: false, deltaY: -100 }), null, "plain wheel is not a zoom gesture — let the terminal scroll");
  assert.equal(zoom({ ctrlKey: true, deltaY: -100, deltaMode: 0 }), 1, "one mouse notch up (Ctrl) zooms in");
  assert.equal(zoom({ ctrlKey: true, deltaY: 100, deltaMode: 0 }), -1, "one mouse notch down (Ctrl) zooms out");

  // Trackpad pinch: many small deltas accumulate into one step, and the
  // intermediate events are still swallowed (0, not null).
  const pinch = createWheelZoom({ threshold: 24 });
  assert.equal(pinch({ ctrlKey: true, deltaY: -10, deltaMode: 0 }), 0);
  assert.equal(pinch({ ctrlKey: true, deltaY: -10, deltaMode: 0 }), 0);
  assert.equal(pinch({ ctrlKey: true, deltaY: -10, deltaMode: 0 }), 1, "third small delta crosses the threshold");
  assert.equal(pinch({ ctrlKey: true, deltaY: -10, deltaMode: 0 }), 0, "accumulator resets after a step");

  // Reversing direction mid-gesture cancels what was accumulated.
  const reverse = createWheelZoom({ threshold: 24 });
  assert.equal(reverse({ ctrlKey: true, deltaY: -20, deltaMode: 0 }), 0);
  assert.equal(reverse({ ctrlKey: true, deltaY: 20, deltaMode: 0 }), 0);
  assert.equal(reverse({ ctrlKey: true, deltaY: -20, deltaMode: 0 }), 0);
  assert.equal(reverse({ ctrlKey: true, deltaY: -5, deltaMode: 0 }), 1);

  // Line-mode wheels (deltaMode 1) count one line as a full step.
  const lines = createWheelZoom({ threshold: 24 });
  assert.equal(lines({ ctrlKey: true, deltaY: -1, deltaMode: 1 }), 1);
  assert.equal(lines({ ctrlKey: true, deltaY: 3, deltaMode: 1 }), -1);

  assert.equal(zoom({ ctrlKey: true, deltaY: 0 }), 0, "a zero delta with Ctrl is swallowed, never a step");
  assert.equal(zoom(undefined), null);
}

console.log("terminal-zoom ok");
