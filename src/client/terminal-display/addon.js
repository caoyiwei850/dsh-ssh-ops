import { spansToRuns, readLogicalLine } from "./matcher.js";
import { terminalTheme, resolveDisplayTheme, subscribeHostTheme } from "./theme.js";
import { getScheme } from "./scheme.js";
import { acquireRegexMatcher } from "./regex-runner.js";
import { getDisplaySettings, subscribeDisplaySettings } from "./settings.js";
import { applyTerminalTheme } from "../terminal-theme.js";

// A scan decorates at most this many runs. Every decoration makes xterm
// full-refresh the viewport and creates one absolutely positioned element, so
// the cap is a rendering budget, not a correctness limit: when it is reached
// the newest (bottom) rows keep their colours and the oldest visible rows are
// left plain (see groupRunsByRow).
export const MAX_DECORATIONS = 1024;
// Events are coalesced into one scan per window. A leading throttle (not a
// debounce) keeps colours flowing during a long scroll instead of waiting for
// the wheel to stop.
export const COALESCE_MS = 60;
// Belt and braces for environments where xterm does not report a viewport
// scroll (user wheel scrolling suppresses `term.onScroll` in xterm 5.5, see
// Viewport.handleWheel -> BufferService.scrollLines). A cheap position poll
// recovers within one interval even when no render/scroll event arrives.
export const VIEWPORT_POLL_MS = 250;
// Failure backoff: a broken worker or a timed-out scheme must not make every
// terminal scan (and clear) 16 times per second forever.
const RETRY_DELAYS = [500, 1000, 2000, 5000];

/**
 * Turn worker span results into per-row runs, filling the decoration budget
 * from the bottom row up. New output appears at the bottom of the viewport, so
 * when the budget runs out the newest rows must stay highlighted and the
 * oldest visible rows lose their colour first.
 */
export function groupRunsByRow(logicals, lines, start, end, maxDecorations = MAX_DECORATIONS, offset = 0) {
  const byRow = new Map();
  let remaining = Math.max(0, maxDecorations);
  for (let index = logicals.length - 1; index >= 0 && remaining > 0; index--) {
    const runs = spansToRuns(logicals[index], lines[index], start, end, remaining);
    if (!runs.length) continue;
    for (const run of runs) {
      if (remaining <= 0) break;
      // `offset` rebases captured rows onto the current buffer after a
      // scrollback trim shifted every absolute line number.
      run.y -= offset;
      if (!byRow.has(run.y)) byRow.set(run.y, []);
      byRow.get(run.y).push(run);
      remaining--;
    }
  }
  for (const runs of byRow.values()) runs.sort((a, b) => a.x - b.x);
  return byRow;
}

export class OutputHighlightAddon {
  constructor({ acquireMatcher = acquireRegexMatcher, coalesceMs = COALESCE_MS, viewportPollMs = VIEWPORT_POLL_MS, now = Date.now } = {}) {
    this.acquireMatcher = acquireMatcher;
    this.coalesceMs = coalesceMs;
    this.viewportPollMs = viewportPollMs;
    this.now = now;
    this.generation = 0;
  }
  activate(term) {
    this.term = term;
    this.resources = [];
    this.rows = [];
    this.disposed = false;
    this.failed = false;
    this.retryIndex = 0;
    this.retryAt = 0;
    this.lastError = "";
    this.viewportY = undefined;
    this.originalTheme = term.options.theme;
    this.matcher = this.acquireMatcher();
    try {
      this.resources.push({ dispose: subscribeHostTheme(() => {
        if (getDisplaySettings().theme === "system") this.syncDisplay();
      }) });
      this.applyTheme();
      this.resources.push(term.onWriteParsed(() => this.request()));
      this.resources.push(term.onScroll(() => this.request()));
      // User wheel scrolling and scrollbar dragging bypass term.onScroll in
      // xterm 5.5 (Viewport suppresses that event), but they always repaint the
      // viewport. Watch the viewport position after a render and request a scan
      // when it moved, so scrolling into history re-highlights what is visible.
      this.resources.push(term.onRender(() => this.syncViewport()));
      this.resources.push(term.onResize(() => this.invalidate()));
      this.resources.push(term.buffer.onBufferChange(() => this.invalidate()));
      this.resources.push({ dispose: subscribeDisplaySettings(() => this.syncDisplay()) });
      this.startViewportPoll();
      this.request();
    } catch { this.fail(); }
  }
  /**
   * Poll the viewport position for scrolls that do not repaint or fire an
   * event (hidden panes, browsers that throttle rendering). The interval is
   * unref'd so it never keeps a Node test process alive.
   */
  startViewportPoll() {
    if (this.pollTimer !== undefined || typeof setInterval !== "function") return;
    this.pollTimer = setInterval(() => this.syncViewport(), this.viewportPollMs);
    this.pollTimer?.unref?.();
  }
  /** Request a scan when the viewport moved since the last known position. */
  syncViewport() {
    if (this.disposed || this.failed) return;
    const buffer = this.term?.buffer?.active;
    if (!buffer) return;
    if (this.viewportY === undefined) { this.viewportY = buffer.viewportY; return; }
    if (this.viewportY === buffer.viewportY) return;
    this.viewportY = buffer.viewportY;
    this.request();
  }
  /** Geometry/theme/buffer changed: in-flight results are no longer valid. */
  invalidate() {
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.clear();
    this.request();
  }
  syncDisplay() {
    try {
      this.applyTheme();
      this.matcher?.clearQuarantine?.();
      // Editing the scheme is an explicit recovery: drop the failure backoff so
      // the next request scans immediately instead of waiting up to 5 s.
      this.retryIndex = 0;
      this.retryAt = 0;
      this.lastError = "";
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      this.invalidate();
    } catch { this.fail(); }
  }
  applyTheme() {
    // A decoration failure must not disable the user's theme preference.
    if (this.disposed) return;
    const settings = getDisplaySettings();
    const theme = this.term.options.theme, next = terminalTheme(settings.theme, settings.backgrounds);
    if (Object.entries(next).some(([key, value]) => theme?.[key] !== value)) applyTerminalTheme(this.term, { ...next });
  }
  request() {
    if (this.disposed || this.failed) return;
    if (this.now() < this.retryAt) return;
    if (!getDisplaySettings().highlightEnabled || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.scan().catch(() => this.fail());
    }, this.coalesceMs);
    this.timer?.unref?.();
  }
  disposeRow(row) {
    for (const decoration of row.decorations) decoration.dispose();
    row.marker.dispose();
  }
  clear() {
    for (const row of this.rows ?? []) this.disposeRow(row);
    this.rows = [];
  }
  async scan() {
    if (this.disposed || this.failed) return;
    clearTimeout(this.timer); this.timer = undefined;
    const term = this.term, buffer = term.buffer.active;
    const settings = getDisplaySettings();
    if (!settings.highlightEnabled || buffer.type !== "normal") { this.clear(); return; }
    // Do not invalidate on plain events here: a result computed a few rows ago
    // is still positionally valid because markers are anchored to absolute
    // lines. Only geometry changes (invalidate()) retire in-flight results.
    const generation = this.generation;
    this.viewportY = buffer.viewportY;
    const entries = getScheme(settings, resolveDisplayTheme(settings.theme));
    const start = buffer.viewportY, end = Math.min(buffer.length, start + Math.min(term.rows, 200));
    let y = start, backtrack = 0;
    while (y > 0 && buffer.getLine(y)?.isWrapped && backtrack++ < 256) y--;
    // Anchor an xterm marker on the first captured line. If the scrollback
    // trims during the worker round-trip, xterm keeps this marker pointing at
    // the same line and shifts its number, so the captured rows are still
    // usable after subtracting that shift. A disposed anchor means the row
    // itself was trimmed away and the result must be recomputed.
    let anchor;
    try { anchor = term.registerMarker(start - buffer.baseY - buffer.cursorY); } catch { anchor = undefined; }
    let shift = 0;
    const logicals = [];
    while (y < end) {
      const logical = readLogicalLine(buffer, y);
      logicals.push(logical); y = Math.max(y + 1, logical.next);
    }
    let result;
    try {
      result = await this.matcher.match(entries, logicals.map((line) => line.text));
      if (this.disposed || this.failed || generation !== this.generation || result.cancelled) return;
      const current = this.term.buffer.active;
      if (current !== buffer) { this.request(); return; }
      if (anchor) {
        if (anchor.isDisposed) { this.request(); return; }
        shift = start - anchor.line;
        if (shift < 0) { this.request(); return; }
      }
    } finally {
      // The anchor only guards the round trip; never leak it, including when
      // the matcher rejects or the addon is disposed mid-scan.
      anchor?.dispose();
    }
    if (result.error) { this.handleError(result.error); return; }
    this.retryIndex = 0; this.retryAt = 0; this.lastError = "";
    // The captured rows may have moved up by `shift` while the worker ran;
    // rebase them onto the current buffer coordinates before registering.
    const byRow = groupRunsByRow(logicals, result.lines, start, end, MAX_DECORATIONS, shift);
    this.viewportY = this.term.buffer.active.viewportY;
    // Reuse unchanged row decorations: high-throughput output should not
    // churn thousands of markers and DOM nodes for already-visible history.
    for (const row of [...this.rows]) {
      if (row.marker.isDisposed) { this.disposeRow(row); this.rows.splice(this.rows.indexOf(row), 1); }
    }
    const previous = new Map(this.rows.map((row) => [row.marker.line, row]));
    for (const [line, runs] of byRow) {
      // Markers track row movement when scrollback trims. Absolute y would
      // invalidate otherwise identical decorations on every trimmed line.
      const signature = JSON.stringify(runs.map(({ x, width, foregroundColor }) => ({ x, width, foregroundColor })));
      const old = previous.get(line);
      if (old && !old.marker.isDisposed && old.signature === signature) { previous.delete(line); continue; }
      if (old) { this.disposeRow(old); this.rows.splice(this.rows.indexOf(old), 1); previous.delete(line); }
      const marker = term.registerMarker(line - buffer.baseY - buffer.cursorY);
      if (!marker) continue;
      const row = { marker, signature, decorations: [] };
      this.rows.push(row); // Own the marker before any fallible API call.
      for (const { x, width, foregroundColor } of runs) {
        const decoration = term.registerDecoration({ marker, x, width, foregroundColor, layer: "bottom" });
        if (decoration) row.decorations.push(decoration);
      }
    }
    for (const row of previous.values()) { this.disposeRow(row); this.rows.splice(this.rows.indexOf(row), 1); }
  }
  /**
   * A failed scan keeps the last good decorations instead of blinking to
   * plain text, warns once per distinct cause, and backs off so a permanent
   * failure does not cost a scan every 60 ms. The retry is unref'd; the
   * viewport poll and the next user/output event also bring it back.
   */
  handleError(code) {
    if (code === "invalid-regex") { this.clear(); return; }
    const delay = RETRY_DELAYS[Math.min(this.retryIndex, RETRY_DELAYS.length - 1)];
    this.retryIndex++;
    this.retryAt = this.now() + delay;
    if (this.lastError !== code) {
      this.lastError = code;
      console.warn(`[dsh-ssh-ops] Semantic highlighting unavailable (${code}); retrying in ${delay} ms`);
    }
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.request();
    }, delay + 16);
    this.retryTimer?.unref?.();
  }
  fail() {
    if (this.failed) return;
    this.failed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.clear();
    console.warn("[dsh-ssh-ops] Semantic highlighting disabled for this terminal");
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.matcher?.release();
    clearTimeout(this.timer);
    this.timer = undefined;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.clear();
    for (const resource of this.resources ?? []) resource.dispose();
    try { this.term.options.theme = this.originalTheme; } catch {}
  }
}
