/**
 * Terminal font-size zoom (issue #36): Ctrl+wheel (and the trackpad pinch,
 * which browsers deliver as a wheel event with ctrlKey) resizes every pooled
 * terminal. The size persists in localStorage so it survives reloads.
 *
 * Pure logic lives here so it can be unit-tested without a DOM; SshPanel.jsx
 * wires it to the container and the terminal pool.
 */

export const TERMINAL_FONT_SIZE_KEY = "dsh-ssh-ops.terminal-font-size.v1";
export const DEFAULT_TERMINAL_FONT_SIZE = 13;
export const MIN_TERMINAL_FONT_SIZE = 8;
export const MAX_TERMINAL_FONT_SIZE = 28;

/** Integer font size inside the supported range; garbage lands on the default. */
export function clampFontSize(value) {
  const size = Math.round(Number(value));
  if (!Number.isFinite(size)) return DEFAULT_TERMINAL_FONT_SIZE;
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, size));
}

export function loadTerminalFontSize(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem?.(TERMINAL_FONT_SIZE_KEY);
    if (raw === null || raw === undefined || raw === "") return DEFAULT_TERMINAL_FONT_SIZE;
    return clampFontSize(raw);
  } catch {
    return DEFAULT_TERMINAL_FONT_SIZE;
  }
}

export function saveTerminalFontSize(size, storage = globalThis.localStorage) {
  try { storage?.setItem?.(TERMINAL_FONT_SIZE_KEY, String(clampFontSize(size))); } catch {}
}

/**
 * Turn wheel events into zoom steps. Returns null when the event is not a zoom
 * gesture (no Ctrl → let the terminal scroll), 0 when it is a zoom gesture
 * that has not yet accumulated a full step (still swallow it so the page does
 * not zoom), +1 / -1 for one step in / out.
 *
 * Accumulating matters for the trackpad pinch, which fires many small deltas
 * per gesture: stepping on every event would jump several sizes at once.
 */
export function createWheelZoom({ threshold = 24 } = {}) {
  let accumulated = 0;
  return (event) => {
    if (!event?.ctrlKey) return null;
    const deltaY = Number(event.deltaY) || 0;
    // deltaMode 1 = lines (mice on some platforms): one line is a full step.
    accumulated += event.deltaMode === 1 ? deltaY * threshold : deltaY;
    if (Math.abs(accumulated) < threshold) return 0;
    const step = accumulated < 0 ? 1 : -1;
    accumulated = 0;
    return step;
  };
}
