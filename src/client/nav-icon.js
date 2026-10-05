/**
 * Settings-nav glyph for this plugin's section, drawn over the shell's gear.
 *
 * The host's `settings.section` slot carries no `icon` field, and its nav
 * renderer picks glyphs from a hard-coded id table (`navIcon`) whose fallback
 * is the settings gear — so every extension that wants a recognizable row
 * paints its own. Same technique as dshmarket (`nav-icon.ts`),
 * dsh-better-sidebar and dsh-skill-mcp-panel: a stylesheet hides the gear on
 * the ONE nav row whose visible text equals this plugin's localized section
 * label, and a CSS mask draws our terminal glyph instead. Delete this module
 * the day `settings.section` grows an `icon` field.
 *
 * The mask artwork is our IconTerminal16 sheet scaled 28→16 (outline variant,
 * 1.3px stroke to match the official nav icons' medium stroke).
 */

/** Marks the one nav row this plugin owns. */
const NAV_ICON_MARKER = "data-dsh-ssh-ops-nav-icon";

/** The nav rows of the settings dialog (SettingsPanel in the settings shell). */
const NAV_ROW_SELECTOR = '[role="dialog"] nav button';

/** The terminal glyph as a standalone SVG for a CSS `mask-image` (alpha only). */
function terminalMaskSvg() {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#000">',
    '<rect x="1.6" y="3" width="12.8" height="10" rx="2.4" stroke-width="1.3"/>',
    '<path d="M5 6.17L6.94 8L5 9.83" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
    '<path d="M8.46 9.86H11.03" stroke-width="1.3" stroke-linecap="round"/>',
    '</svg>'
  ].join("");
}

function terminalMaskUrl() {
  return `data:image/svg+xml,${encodeURIComponent(terminalMaskSvg())}`;
}

/** Stylesheet for the marked row: hide the shell's gear, draw the mark. */
function navIconCss(maskUrl) {
  return [
    `[${NAV_ICON_MARKER}] > svg { display: none; }`,
    `[${NAV_ICON_MARKER}]::before {`,
    `  content: '';`,
    `  flex: none;`,
    `  width: 16px;`,
    `  height: 16px;`,
    `  background-color: currentColor;`,
    `  -webkit-mask-image: url("${maskUrl}");`,
    `  mask-image: url("${maskUrl}");`,
    `  -webkit-mask-repeat: no-repeat;`,
    `  mask-repeat: no-repeat;`,
    `  -webkit-mask-position: center;`,
    `  mask-position: center;`,
    `  -webkit-mask-size: 16px 16px;`,
    `  mask-size: 16px 16px;`,
    `}`
  ].join("\n");
}

/** Whether a nav row is ours: visible text equals the current section label. */
function isOwnNavRow(rowText, wantedLabel) {
  const wanted = String(wantedLabel ?? "").trim();
  if (wanted.length === 0) return false;
  return String(rowText ?? "").trim() === wanted;
}

/**
 * Install the nav glyph. `resolveLabel` is the same thunk the
 * `settings.section` registration passes as `label`, re-read on every sync so
 * a language switch re-claims the row without re-registering.
 * @returns the disposer (stylesheet + markers).
 */
export function installSettingsNavIcon(ctx, resolveLabel) {
  if (typeof document === "undefined") return () => {};
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-ssh-ops";
  tag.dataset.pluginCss = "dsh-ssh-ops/settings-nav-icon";
  tag.textContent = navIconCss(terminalMaskUrl());
  document.head.appendChild(tag);

  let disposed = false;
  let scheduled = false;
  const sync = () => {
    scheduled = false;
    if (disposed) return;
    const wanted = resolveLabel();
    for (const row of document.querySelectorAll(NAV_ROW_SELECTOR)) {
      if (isOwnNavRow(row.textContent, wanted)) row.setAttribute(NAV_ICON_MARKER, "");
      else row.removeAttribute(NAV_ICON_MARKER);
    }
  };
  const schedule = () => {
    if (scheduled || disposed) return;
    scheduled = true;
    queueMicrotask(sync);
  };
  sync();
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  return () => {
    disposed = true;
    observer.disconnect();
    for (const row of document.querySelectorAll(`[${NAV_ICON_MARKER}]`)) row.removeAttribute(NAV_ICON_MARKER);
    tag.remove();
  };
}
