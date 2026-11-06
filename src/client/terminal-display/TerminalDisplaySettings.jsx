import * as React from "react";
import { t } from "../../i18n/core.js";
import { useLanguage } from "../locale.js";
import { getDisplaySettings, setDisplaySettings, subscribeDisplaySettings, updateScheme, resetScheme, setDisplayBackground, resetDisplayBackground } from "./settings.js";
import { terminalTheme, resolveDisplayTheme, subscribeHostTheme, getHostTheme, DEFAULT_BACKGROUNDS } from "./theme.js";
import { getScheme, exportScheme, MAX_SCHEME_ENTRIES } from "./scheme.js";
import { EditablePreview } from "./EditablePreview.jsx";
import { PatternTags } from "./PatternTags.jsx";
import { dropSlot, dropIndex, previewShifts, insertionOffset } from "./drag-order.js";
import { DEFAULT_PREVIEW_TEXT } from "./preview-text.js";
const button = { padding: "5px 8px", borderRadius: 5, cursor: "pointer", fontSize: 12, color: "inherit", background: "transparent", border: "1px solid var(--dsh-ssh-ops-border, #3a414b)" };
const field = { boxSizing: "border-box", minWidth: 0, padding: "6px 8px", borderRadius: 5, fontSize: 12, color: "inherit",
  background: "var(--dsh-ssh-ops-input, #101418)", border: "1px solid var(--dsh-ssh-ops-border, #3a414b)" };
const DRAG_THRESHOLD = 6;

/**
 * Appearance/scheme styles. The drag visuals live here (not inline) because the
 * moved rows are driven by direct DOM writes during the pointer move: React
 * renders only the idle tree plus the one dragged row's placeholder state.
 */
const STYLES = `
.dsh-scheme-list { position: relative; overscroll-behavior: contain; scrollbar-gutter: stable;
  flex: 1 1 380px; min-height: 120px; max-height: min(40vh, 380px); overflow-y: auto; overflow-x: hidden; }
/* Height-adaptive shell: the dialog caps its own height, so only the scheme
   list scrolls; the theme switch, add button and preview stay on screen on
   laptop-height (windowed) windows instead of being scrolled out of view. */
.dsh-appearance-body { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; overflow: hidden; }
.dsh-appearance-section { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0;
  padding: 4px 20px 18px; color: var(--dsh-ssh-ops-text, #d7dbe2); }
/* The fieldset only carries the disabled semantics: display:contents keeps it
   out of layout so .dsh-scheme-fill is a normal flex item that can shrink;
   Chrome will not shrink flex children through a fieldset content box. */
.dsh-scheme-fieldset { display: contents; }
.dsh-scheme-fill { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; width: 100%; }
@media (max-height: 780px) {
  .dsh-appearance-section { padding-bottom: 10px; }
  /* Rows carry inline padding/row-gap; the compact spacing must win there. */
  .dsh-scheme-row { padding-top: 6px !important; padding-bottom: 6px !important; row-gap: 4px !important; }
}
/* Very short windows fall back to one scrolling dialog rather than clipping. */
@media (max-height: 620px) {
  .dsh-appearance-body { overflow-y: auto; }
  .dsh-appearance-section { flex: 0 0 auto; }
  .dsh-scheme-fill { flex: 0 0 auto; }
  .dsh-scheme-list { flex: 0 0 auto; }
}
.dsh-scheme-list[data-dragging="true"] { user-select: none; -webkit-user-select: none; }
.dsh-scheme-row { position: relative; touch-action: pan-y; transition: transform .22s cubic-bezier(.22,.61,.36,1), background-color .16s ease, box-shadow .16s ease, border-color .16s ease; }
.dsh-scheme-row:hover { background: color-mix(in srgb, var(--dsh-ssh-ops-text, #d7dbe2) 5%, transparent); border-radius: 8px; }
.dsh-scheme-list[data-dragging="true"] .dsh-scheme-row:hover { background: transparent; }
.dsh-scheme-row[data-drag-source="true"] { border: 1px dashed #2d6cdf !important; border-radius: 8px;
  background: color-mix(in srgb, rgba(45,108,223,.10)) !important; }
.dsh-scheme-row[data-drag-source="true"] > * { visibility: hidden; }
.dsh-scheme-row[data-drop-target="true"] { box-shadow: inset 0 0 0 1px color-mix(in srgb, rgba(45,108,223,.55)); border-radius: 8px; }
.dsh-drag-handle { display: grid; place-items: center; width: 28px; height: 34px; padding: 0; border: 0; border-radius: 6px;
  background: transparent; color: var(--dsh-ssh-ops-muted, #8b93a1); cursor: grab; touch-action: none; }
.dsh-drag-handle:hover, .dsh-drag-handle:focus-visible { background: color-mix(in srgb, var(--dsh-ssh-ops-text, #d7dbe2) 10%, transparent); color: var(--dsh-ssh-ops-text, #d7dbe2); }
.dsh-drag-handle:active, .dsh-scheme-list[data-dragging="true"] .dsh-drag-handle { cursor: grabbing; }
.dsh-scheme-ghost { position: fixed; z-index: 2147483000; pointer-events: none; opacity: .97;
  background: var(--dsh-ssh-ops-surface, #161b21); color: var(--dsh-ssh-ops-text, #d7dbe2);
  border: 1px solid #2d6cdf; border-radius: 8px;
  box-shadow: 0 18px 40px rgba(0,0,0,.38), 0 2px 8px rgba(0,0,0,.24);
  animation: dsh-ghost-in .16s cubic-bezier(.22,.61,.36,1); will-change: left, top; }
@keyframes dsh-ghost-in { from { opacity: 0; box-shadow: 0 2px 8px rgba(0,0,0,.2); } }
.dsh-quick-hint { position: fixed; z-index: 2147483001; pointer-events: none; transform: translateX(-50%);
  padding: 4px 8px; font-size: 11px; line-height: 1.6; white-space: nowrap; color: var(--dsh-ssh-ops-text, #d7dbe2);
  background: var(--dsh-ssh-ops-surface, #161b21); border: 1px solid var(--dsh-ssh-ops-border, #3a414b);
  border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,.28); }
.dsh-drop-indicator { position: absolute; top: 0; left: 0; right: 0; height: 2px; margin-top: -1px; border-radius: 2px;
  background: #2d6cdf; box-shadow: 0 0 0 1px color-mix(in srgb, rgba(45,108,223,.30));
  pointer-events: none; display: none; will-change: transform; }
.dsh-scheme-list[data-dragging="true"] { cursor: grabbing; }
.dsh-scheme-list[data-settling="true"] .dsh-scheme-row { transition: none !important; }
.dsh-delete-entry { display: inline-flex; align-items: center; justify-content: center; height: 30px; padding: 0 8px;
  border: 1px solid rgba(229,72,77,.5); border-radius: 5px; background: transparent; color: #e5484d; font-size: 11px; cursor: pointer; }
.dsh-delete-entry:hover, .dsh-delete-entry:focus-visible { background: rgba(229,72,77,.12); border-color: #e5484d; }
.dsh-case-toggle { display: inline-flex; align-items: center; gap: 4px; height: 30px; padding: 0 8px; border-radius: 5px;
  border: 1px solid var(--dsh-ssh-ops-border, #3a414b); background: transparent; color: var(--dsh-ssh-ops-muted, #8b93a1);
  font-size: 11px; cursor: pointer; white-space: nowrap; }
.dsh-case-toggle[aria-pressed="true"] { background: #2d6cdf; border-color: #2d6cdf; color: #fff; }
.dsh-case-toggle:disabled { cursor: not-allowed; opacity: .5; }
.dsh-theme-badge { display: inline-flex; align-items: center; gap: 6px; padding: 1px 8px; border-radius: 999px; white-space: nowrap;
  border: 1px solid var(--dsh-ssh-ops-border, #3a414b); color: var(--dsh-ssh-ops-muted, #8b93a1); font-size: 11px; line-height: 1.7; }
.dsh-theme-dot { width: 8px; height: 8px; flex: none; border-radius: 50%; border-width: 1px; border-style: solid; }
.dsh-export-toast { position: absolute; right: 0; top: calc(100% + 6px); z-index: 41; width: max-content; max-width: min(340px, 60vw); padding: 6px 10px;
  font-size: 11px; line-height: 1.5; color: var(--dsh-ssh-ops-text, #d7dbe2); background: var(--dsh-ssh-ops-surface, #161b21);
  border: 1px solid #2d6cdf; border-radius: 7px; box-shadow: 0 10px 30px rgba(0,0,0,.28);
  pointer-events: none; animation: dsh-toast-in .16s ease-out; }
@keyframes dsh-toast-in { from { opacity: 0; transform: translateY(-4px); } }
.dsh-scheme-fieldset:disabled input, .dsh-scheme-fieldset:disabled button { cursor: not-allowed; }
.dsh-case-wrap > button:disabled { pointer-events: none; }
.dsh-reset-popover { position: absolute; right: 0; top: calc(100% + 6px); z-index: 40; width: min(440px, 100%);
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 12px; font-size: 12px;
  background: var(--dsh-ssh-ops-surface, #161b21); border: 1px solid #2d6cdf; border-radius: 8px;
  box-shadow: 0 10px 30px rgba(0,0,0,.28); }
@media (max-width: 720px) { .dsh-reset-popover { left: 0; right: 0; width: auto; } }
@media (prefers-reduced-motion: reduce) {
  .dsh-scheme-row { transition: none; }
  .dsh-scheme-ghost { animation: none; transform: none; }
  .dsh-export-toast { animation: none; }
}
@media (max-width: 720px) {
  .dsh-scheme-row { grid-template-columns: 28px minmax(0, 1fr) 34px 26px !important;
    grid-template-areas: "grip name color del" "case case case case" "hex hex hex hex" "tags tags tags tags" !important; }
}
`;

/** Background colour swatch + HEX for the active theme, with a reset affordance. */
function BackgroundField({ label, value, onChange, onReset, resetLabel }) {
  const [hex, setHex] = React.useState(value);
  const id = React.useId();
  React.useEffect(() => setHex(value), [value]);
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
    <label htmlFor={id} style={{ color: "var(--dsh-ssh-ops-muted, #8b93a1)" }}>{label}</label>
    <input id={id} type="color" aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}
      style={{ width: 30, height: 24, padding: 2, boxSizing: "border-box", background: "transparent",
        border: "1px solid var(--dsh-ssh-ops-border, #3a414b)", borderRadius: 4 }} />
    <input aria-label={label + " HEX"} value={hex} maxLength={7} spellCheck={false}
      onChange={(event) => { setHex(event.target.value); if (/^#[0-9a-f]{6}$/i.test(event.target.value)) onChange(event.target.value); }}
      onBlur={() => setHex(value)}
      style={{ ...field, height: 24, width: 78, padding: "0 6px", fontFamily: "monospace" }} />
    {onReset && <button type="button" aria-label={resetLabel} title={resetLabel} onClick={onReset}
      style={{ ...field, display: "inline-flex", alignItems: "center", justifyContent: "center",
        height: 24, width: 24, padding: 0, cursor: "pointer", fontSize: 13, color: "var(--dsh-ssh-ops-muted, #8b93a1)" }}>↺</button>}
  </span>;
}

function SchemeEntry({ entry, label, onChange, onDelete, dragging, onHandlePointerDown, onShowHint, onHideHint, rowRef }) {
  const [hex, setHex] = React.useState(entry.color);
  const toggleId = React.useId();
  React.useEffect(() => setHex(entry.color), [entry.color]);
  // Every control in the first row shares the same box height so the row reads
  // as one strip instead of four differently sized widgets.
  const control = { height: 30, boxSizing: "border-box" };
  const caseHint = entry.caseSensitive ? t("区分大小写：已开启") : t("区分大小写：已关闭");
  return <div ref={rowRef} className="dsh-scheme-row" data-scheme-id={entry.id} data-drag-source={dragging ? "true" : undefined}
    aria-grabbed={dragging ? "true" : undefined}
    style={{ display: "grid", width: "100%", boxSizing: "border-box",
      gridTemplateColumns: "28px minmax(120px, 220px) 34px 84px auto auto minmax(0, 1fr)",
      gridTemplateAreas: '"grip name color hex case del rest" "tags tags tags tags tags tags tags"',
      columnGap: 8, rowGap: 6, alignItems: "center",
      padding: "10px 6px 10px 2px", borderBottom: "1px solid var(--dsh-ssh-ops-border, #3a414b)" }}>
    <button type="button" data-drag-handle className="dsh-drag-handle" aria-label={t(`拖动排序 ${label}`)}
      onPointerDown={onHandlePointerDown}
      onPointerEnter={(event) => onShowHint(event, t("鼠标拖动或键盘聚焦后 Alt+↑/↓ 排序"), true)} onPointerLeave={onHideHint}
      onFocus={(event) => onShowHint(event, t("鼠标拖动或键盘聚焦后 Alt+↑/↓ 排序"), true)} onBlur={onHideHint}
      style={{ gridArea: "grip" }}>
      <svg width="14" height="16" viewBox="0 0 14 16" fill="currentColor" aria-hidden="true"><circle cx="4" cy="4" r="1"/><circle cx="10" cy="4" r="1"/><circle cx="4" cy="8" r="1"/><circle cx="10" cy="8" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="10" cy="12" r="1"/></svg>
    </button>
    <div style={{ gridArea: "name", display: "flex", alignItems: "center", gap: 6, minWidth: 0, height: 30 }}>
      <input id={toggleId} type="checkbox" checked={entry.enabled} aria-label={t(`启用 ${label}`)} onChange={(event) => onChange({ enabled: event.target.checked })} />
      {onDelete
        ? <input aria-label={t("配色项名称")} value={entry.name} placeholder={t("自定义配色项")} maxLength={80} onChange={(event) => onChange({ name: event.target.value })} style={{ ...field, ...control, width: "100%", padding: "0 6px" }} />
        : <label htmlFor={toggleId} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</label>}
    </div>
    <input type="color" aria-label={label} value={entry.color} disabled={!entry.enabled} onChange={(event) => onChange({ color: event.target.value })}
      style={{ ...control, gridArea: "color", width: 34, padding: 2, background: "transparent", border: "1px solid var(--dsh-ssh-ops-border, #3a414b)", borderRadius: 4 }} />
    <input aria-label={label + " HEX"} value={hex} disabled={!entry.enabled} maxLength={7} spellCheck={false}
      onChange={(event) => { setHex(event.target.value); if (/^#[0-9a-f]{6}$/i.test(event.target.value)) onChange({ color: event.target.value }); }} onBlur={() => setHex(entry.color)}
      style={{ ...field, ...control, gridArea: "hex", width: 84, padding: "0 6px", fontFamily: "monospace" }} />
    {/* The wrapper carries the state hint: a disabled control swallows its
        native title tooltip, so the hint has to hang off an element that still
        hovers while the toggle or the whole scheme is disabled. */}
    <span className="dsh-case-wrap"
      onPointerEnter={(event) => onShowHint(event, caseHint)} onPointerLeave={onHideHint}
      onFocus={(event) => onShowHint(event, caseHint)} onBlur={onHideHint} onClick={onHideHint}
      style={{ gridArea: "case", display: "inline-flex" }}>
      <button type="button" className="dsh-case-toggle" disabled={!entry.enabled} aria-label={t(`${label} 区分大小写`)} aria-pressed={entry.caseSensitive}
        onClick={() => onChange({ caseSensitive: !entry.caseSensitive })}>
        <span aria-hidden="true" style={{ fontFamily: "monospace", fontWeight: 600, fontSize: 12 }}>Aa</span>
      </button>
    </span>
    {onDelete
      ? <button type="button" className="dsh-delete-entry" style={{ gridArea: "del", justifySelf: "end" }} aria-label={t(`删除配色项 ${label}`)} title={t(`删除配色项 ${label}`)} onClick={onDelete}>{t("删除")}</button>
      : <span style={{ gridArea: "del" }} />}
    <div style={{ gridArea: "tags", display: "flex", gap: 6, alignItems: "flex-start", minWidth: 0 }}>
      <div style={{ flex: 1, minWidth: 0 }}><PatternTags label={label} text={entry.text} disabled={!entry.enabled} onChange={(text) => onChange({ text, mode: "regex" })} /></div>
    </div>
  </div>;
}

export function TerminalDisplaySettings() {
  useLanguage();
  const settings = React.useSyncExternalStore(subscribeDisplaySettings, getDisplaySettings);
  React.useSyncExternalStore(subscribeHostTheme, getHostTheme);
  const [preview, setPreview] = React.useState(DEFAULT_PREVIEW_TEXT);
  const [exported, setExported] = React.useState(false);
  const [confirmReset, setConfirmReset] = React.useState(false);
  const [dragId, setDragId] = React.useState(null);
  const exportTimer = React.useRef(null);
  const showExported = () => {
    setExported(true);
    clearTimeout(exportTimer.current);
    exportTimer.current = setTimeout(() => setExported(false), 3200);
  };
  React.useEffect(() => () => clearTimeout(exportTimer.current), []);
  const radioName = React.useId(), resolved = resolveDisplayTheme(settings.theme), activeTheme = terminalTheme(settings.theme, settings.backgrounds);
  // The reset affordance only appears once the theme's background differs from
  // the DSH default, so a pristine install shows just the picker and HEX.
  const customBackground = typeof settings.backgrounds?.[resolved] === "string"
    && settings.backgrounds[resolved] !== DEFAULT_BACKGROUNDS[resolved];
  const entries = React.useMemo(() => getScheme(settings, resolved), [settings, resolved]);
  const listRef = React.useRef(null);
  const rows = React.useRef(new Map());
  const indicator = React.useRef(null);
  const drag = React.useRef(null);
  const suppressClick = React.useRef(0);
  const labels = { error: t("错误与否定"), success: t("成功与肯定"), warning: t("警示状态"), info: t("信息关键词"),
    heading: t("地址、时间与符号"), number: t("数字"), string: t("字符串与路径"), option: t("命令选项"), command: t("命令名称"), debug: t("文件类型"), prompt: t("提示符") };
  const change = (id, patch) => updateScheme(resolved, (scheme) => scheme.map((entry) => entry.id === id ? { ...entry, ...patch } : entry));

  const move = (id, target, side = "before") => updateScheme(resolved, (scheme) => {
    const moved = scheme.find((entry) => entry.id === id);
    if (!moved || id === target) return scheme;
    const next = scheme.filter((entry) => entry.id !== id), index = next.findIndex((entry) => entry.id === target);
    if (index < 0) return scheme;
    next.splice(index + (side === "after" ? 1 : 0), 0, moved); return next;
  });
  const backup = () => {
    const url = URL.createObjectURL(new Blob([exportScheme(getDisplaySettings(), resolved)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url;
    link.download = `dsh-ssh-ops-${resolved}-scheme-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showExported();
  };

  const resetRef = React.useRef(null);
  const confirmRef = React.useRef(null);
  const pendingEntry = entries.find((entry) => !Object.hasOwn(labels, entry.id) && !(entry.text || "").trim());
  // The reset confirmation is a floating popover anchored to its button, so
  // opening it never reflows the rows below (dismiss on outside click/Esc).
  React.useEffect(() => {
    if (!confirmReset) return undefined;
    const onPointerDown = (event) => {
      if (confirmRef.current?.contains(event.target) || resetRef.current?.contains(event.target)) return;
      setConfirmReset(false);
    };
    const onKeyDown = (event) => { if (event.key === "Escape") { event.preventDefault(); setConfirmReset(false); } };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [confirmReset]);
  const addEntry = () => {
    // Only one unnamed/unconfigured draft at a time: the button stays disabled
    // until the new entry has at least one match tag.
    if (pendingEntry) { rows.current.get(pendingEntry.id)?.querySelector("[data-pattern-input]")?.focus(); return; }
    if (entries.length >= MAX_SCHEME_ENTRIES) return;
    const id = `custom:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
    updateScheme(resolved, (scheme) => [...scheme, { id, name: "", enabled: true,
      color: scheme.find((entry) => entry.id === "error")?.color ?? "#f44747", mode: "regex", caseSensitive: false, text: "" }]);
    // The new row is appended at the bottom (outside the visible list window):
    // scroll it into view and focus its first tag input.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const list = listRef.current;
      if (list) list.scrollTop = list.scrollHeight;
      rows.current.get(id)?.querySelector("[data-pattern-input]")?.focus();
    }));
  };

  // ---- pointer drag reorder -------------------------------------------------
  const rowElements = () => Array.from(rows.current.values()).filter((element) => element?.isConnected);
  const measureRows = () => {
    const list = listRef.current;
    const listRect = list.getBoundingClientRect();
    return entries.map((entry) => {
      const element = rows.current.get(entry.id);
      const rect = element.getBoundingClientRect();
      return { id: entry.id, top: rect.top - listRect.top + list.scrollTop, height: rect.height };
    });
  };
  const clearVisuals = (state, keepGhost = false) => {
    for (const element of rowElements()) {
      element.style.transform = ""; element.style.zIndex = "";
      element.removeAttribute("data-drop-target"); element.removeAttribute("data-drag-source");
    }
    if (indicator.current) { indicator.current.style.display = "none"; indicator.current.style.transform = ""; }
    if (!keepGhost) state?.ghost?.remove();
    if (listRef.current) listRef.current.removeAttribute("data-dragging");
  };
  const applyShifts = (state, shifts) => {
    for (const row of state.rows) {
      const element = rows.current.get(row.id);
      if (!element) continue;
      const shift = shifts.get(row.id);
      element.style.transform = shift ? `translateY(${shift}px)` : "";
    }
    for (const element of rowElements()) element.removeAttribute("data-drop-target");
    const target = state.slot ? rows.current.get(state.slot.id) : undefined;
    if (target) target.setAttribute("data-drop-target", "true");
  };
  const updateSlot = () => {
    const state = drag.current;
    if (!state?.active) return;
    const list = listRef.current;
    const listRect = list.getBoundingClientRect();
    const slot = dropSlot(state.rows, state.pointerY - listRect.top + list.scrollTop);
    if (!slot || (state.slot && slot.id === state.slot.id && slot.side === state.slot.side)) return;
    state.slot = slot;
    const shifts = previewShifts(state.rows, state.id, slot);
    applyShifts(state, shifts);
    const offset = insertionOffset(state.rows, state.id, slot);
    if (indicator.current) {
      if (offset == null) indicator.current.style.display = "none";
      else { indicator.current.style.display = "block"; indicator.current.style.transform = `translateY(${offset - list.scrollTop}px)`; }
    }
  };
  const autoScroll = (state) => {
    const list = listRef.current;
    const rect = list.getBoundingClientRect();
    const edge = 30;
    const delta = state.pointerY < rect.top + edge ? -14 : state.pointerY > rect.bottom - edge ? 14 : 0;
    if (!delta) return;
    const before = list.scrollTop;
    list.scrollTop = Math.max(0, Math.min(list.scrollHeight - list.clientHeight, before + delta));
    if (list.scrollTop !== before) updateSlot();
  };
  const dragFrame = () => {
    const state = drag.current;
    if (!state?.active) { state && (state.frame = undefined); return; }
    autoScroll(state);
    if (state.ghost) {
      const left = state.pointerX - state.offsetX, top = state.pointerY - state.offsetY;
      state.ghost.style.left = `${left}px`; state.ghost.style.top = `${top}px`;
    }
    state.frame = window.requestAnimationFrame(dragFrame);
  };
  const startGhost = (state, element) => {
    const dialog = element.closest("dialog") ?? document.body;
    const rect = element.getBoundingClientRect();
    const ghost = element.cloneNode(true);
    ghost.removeAttribute("data-scheme-id"); ghost.removeAttribute("data-drag-source"); ghost.setAttribute("aria-hidden", "true");
    ghost.classList.add("dsh-scheme-ghost");
    for (const node of ghost.querySelectorAll("[id]")) node.removeAttribute("id");
    for (const node of ghost.querySelectorAll("input,button,select,textarea")) node.setAttribute("tabindex", "-1");
    ghost.style.left = `${rect.left}px`; ghost.style.top = `${rect.top}px`;
    ghost.style.width = `${rect.width}px`; ghost.style.minHeight = `${rect.height}px`;
    dialog.appendChild(ghost);
    state.ghost = ghost;
  };
  const detachDrag = () => {
    window.removeEventListener("pointermove", onPointerMove, { passive: false });
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    window.removeEventListener("keydown", onDragKey, true);
    if (drag.current?.frame) window.cancelAnimationFrame(drag.current.frame);
  };
  const onHandlePointerDown = (event, id) => {
    if (event.button !== 0 || !event.isPrimary) return;
    hideQuickHint();
    const element = rows.current.get(id);
    const list = listRef.current;
    if (!element || !list) return;
    const rowRect = element.getBoundingClientRect();
    drag.current = { id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      pointerX: event.clientX, pointerY: event.clientY, offsetX: event.clientX - rowRect.left, offsetY: event.clientY - rowRect.top,
      active: false, ghost: undefined, rows: measureRows(), slot: undefined, frame: undefined };
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("keydown", onDragKey, true);
  };
  const onPointerMove = (event) => {
    const state = drag.current;
    if (!state || event.pointerId !== state.pointerId) return;
    state.pointerX = event.clientX; state.pointerY = event.clientY;
    if (!state.active) {
      if (Math.hypot(event.clientX - state.startX, event.clientY - state.startY) < DRAG_THRESHOLD) return;
      state.active = true;
      state.rows = measureRows();
      setDragId(state.id);
      const element = rows.current.get(state.id);
      if (element) { element.setAttribute("data-drag-source", "true"); startGhost(state, element); }
      if (listRef.current) listRef.current.setAttribute("data-dragging", "true");
      state.frame = window.requestAnimationFrame(dragFrame);
    }
    event.preventDefault();
    updateSlot();
  };
  const finish = async (commitMove) => {
    const state = drag.current;
    if (!state) return;
    detachDrag();
    drag.current = null;
    const wasActive = state.active;
    if (wasActive) suppressClick.current = Date.now() + 400;
    const ghost = state.ghost;
    const list = listRef.current;
    // Freeze the row transitions while the DOM settles: the rows are already
    // at their previewed offsets, so removing the transforms and committing the
    // new order does not visibly jump, and the destination rect can be measured
    // at its final position (a running transition would return a mid-flight
    // rect, which is why the ghost used to land short of the slot).
    list?.setAttribute("data-settling", "true");
    clearVisuals(state, true);
    setDragId(null);
    if (!wasActive) { list?.removeAttribute("data-settling"); ghost?.remove(); return; }
    if (commitMove && state.slot) {
      const sourceIndex = state.rows.findIndex((row) => row.id === state.id);
      if (dropIndex(state.rows, state.id, state.slot) !== sourceIndex && state.slot.id !== state.id) {
        move(state.id, state.slot.id, state.slot.side);
      }
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    list?.removeAttribute("data-settling");
    const destination = rows.current.get(state.id);
    if (!ghost || !ghost.isConnected || !destination) { ghost?.remove(); return; }
    // The ghost is placed with left/top and tilted with a CSS transform. Glide
    // from its untilted box (left/top + offset size) so the end position is the
    // row's rect exactly, independent of the tilt.
    const to = destination.getBoundingClientRect();
    const fromLeft = Number.parseFloat(ghost.style.left) || 0;
    const fromTop = Number.parseFloat(ghost.style.top) || 0;
    // Only one floating box while the copy glides back: hide the row it is
    // about to land on (keeping its space as an empty slot) and reveal it once
    // the copy has landed.
    destination.style.visibility = "hidden";
    try {
      const animation = ghost.animate([
        { transform: "translate(0, 0)", opacity: 0.92 },
        { transform: `translate(${to.left - fromLeft}px, ${to.top - fromTop}px)`, opacity: 1 }
      ], { duration: 220, easing: "cubic-bezier(.22,.61,.36,1)" });
      try { await animation.finished; } catch { /* interrupted */ }
    } finally {
      ghost.remove();
      destination.style.visibility = "";
    }
    // A plain row div is not focusable, and the drag hides the handle's focus
    // target; give focus back to the handle so keyboard users keep their place.
    destination.querySelector("[data-drag-handle]")?.focus();
  };
  const onPointerUp = (event) => {
    const state = drag.current;
    if (!state || event.pointerId !== state.pointerId) return;
    void finish(true);
  };
  const onPointerCancel = () => { void finish(false); };
  const onDragKey = (event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); void finish(false); } };
  const onKeyboardMove = (id, direction) => {
    const index = entries.findIndex((entry) => entry.id === id);
    const target = entries[index + direction];
    if (!target) return;
    move(id, target.id, direction > 0 ? "after" : "before");
    window.setTimeout(() => rows.current.get(id)?.querySelector("[data-drag-handle]")?.focus(), 0);
  };
  const onListClickCapture = (event) => {
    if (Date.now() < suppressClick.current) { event.preventDefault(); event.stopPropagation(); }
  };

  // Tooltips are rendered as fixed elements on the dialog instead of native
  // `title`s, whose ~1 s OS delay felt too slow; 160 ms keeps them snappy and
  // the list's scroll container cannot clip them. Shared by the drag handle and
  // the case-sensitivity toggle.
  const quickHint = React.useRef(undefined);
  const quickHintTimer = React.useRef(undefined);
  const hintAnchor = React.useRef(null);
  const clearQuickHint = () => {
    clearTimeout(quickHintTimer.current);
    quickHint.current?.remove();
    quickHint.current = undefined;
  };
  const hideQuickHint = () => { clearQuickHint(); hintAnchor.current = null; };
  const showQuickHint = (event, text, sortable = false) => {
    const target = event.currentTarget;
    hintAnchor.current = sortable ? target : null;
    clearTimeout(quickHintTimer.current);
    quickHintTimer.current = setTimeout(() => {
      if (!target.isConnected) return;
      clearQuickHint();
      hintAnchor.current = sortable ? target : null;
      const dialog = target.closest("dialog") ?? document.body;
      const tip = document.createElement("div");
      tip.className = "dsh-quick-hint";
      tip.setAttribute("role", "tooltip");
      tip.textContent = text;
      dialog.appendChild(tip);
      quickHint.current = tip;
      const rect = target.getBoundingClientRect();
      tip.style.left = `${Math.round(rect.left + rect.width / 2)}px`;
      const below = rect.bottom + 6;
      tip.style.top = `${Math.round(below + 30 > window.innerHeight ? rect.top - 32 : below)}px`;
    }, 160);
  };
  React.useEffect(() => () => { clearTimeout(quickHintTimer.current); quickHint.current?.remove(); }, []);

  // Alt+Up/Down while a scheme row is focused or hovered reorders it. This
  // listens on the window so the shortcut also works right after hovering the
  // handle (the dialog autofocus stays on its close button), and it prevents
  // the browser default: Chrome on macOS maps Option+Up/Down to page scrolling.
  const keyboardMoveRef = React.useRef(null);
  keyboardMoveRef.current = onKeyboardMove;
  React.useEffect(() => {
    const onKeyDown = (event) => {
      if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      const active = document.activeElement;
      if (active?.matches?.("input, textarea, select")) return;
      // Only a focused drag handle (or one under the pointer) owns the shortcut:
      // pressing Alt+arrows in another row control should keep its native meaning.
      const anchor = (active?.matches?.("[data-drag-handle]") ? active : null) ?? hintAnchor.current;
      const id = anchor?.closest?.("[data-scheme-id]")?.getAttribute?.("data-scheme-id");
      if (!id) return;
      event.preventDefault();
      event.stopPropagation();
      keyboardMoveRef.current?.(id, event.key === "ArrowUp" ? -1 : 1);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  return <section aria-label={t("终端显示")} className="dsh-appearance-section">
    <style>{STYLES}</style>
    <p style={{ margin: "0 0 10px", flexShrink: 0, fontSize: 12, lineHeight: 1.6, color: "var(--dsh-ssh-ops-muted, #8b93a1)" }}>{t("适用于所有 SSH 终端，修改后自动保存。")}</p>
    <fieldset style={{ border: 0, padding: 0, margin: "0 0 8px", flexShrink: 0, display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 18px" }}>
      <legend style={{ float: "left", fontSize: 12, color: "var(--dsh-ssh-ops-muted, #8b93a1)", marginRight: 2 }}>{t("终端主题")}</legend>
      {[["system", t("跟随 DSH")], ["dark", t("深色")], ["light", t("浅色")]].map(([value, label]) => <label key={value} style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 12 }}>
        <input type="radio" name={radioName} value={value} checked={settings.theme === value} onChange={() => { setDisplaySettings({ theme: value }); setExported(false); setConfirmReset(false); }} />{label}
      </label>)}
      <span aria-hidden="true" style={{ width: 1, height: 15, background: "var(--dsh-ssh-ops-border, #3a414b)" }} />
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
        <input type="checkbox" checked={settings.highlightEnabled} onChange={(event) => { setDisplaySettings({ highlightEnabled: event.target.checked }); setConfirmReset(false); setExported(false); }} />{t("启用语义高亮")}
      </label>
    </fieldset>
    {/* Theme-scoped row: the heading, badge and terminal background stay usable
        while semantic highlighting is off; only the scheme actions dim below. */}
    <div style={{ position: "relative", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, margin: "16px 0 8px", flexShrink: 0 }}>
      <h4 style={{ fontSize: 13, margin: 0 }}>{t("配色方案")}</h4>
      <span className="dsh-theme-badge">
        <span aria-hidden="true" className="dsh-theme-dot" style={{ background: activeTheme.background, borderColor: activeTheme.foreground }} />
        {resolved === "light" ? t("浅色主题") : t("深色主题")}
      </span>
      {/* The terminal background belongs to the theme, not to highlighting: it
          stays editable while the scheme list below is dimmed and disabled. */}
      <BackgroundField label={t("终端背景")} value={activeTheme.background}
        onChange={(color) => setDisplayBackground(resolved, color)}
        onReset={customBackground ? () => resetDisplayBackground(resolved) : undefined} resetLabel={t("恢复 DSH 默认背景")} />
      <div style={{ display: "inline-flex", alignItems: "center", gap: 8, marginLeft: "auto",
        opacity: settings.highlightEnabled ? 1 : 0.55, transition: "opacity .15s ease" }}>
        <button ref={resetRef} type="button" style={button} disabled={!settings.highlightEnabled}
          aria-expanded={confirmReset} aria-haspopup="dialog"
          onClick={() => setConfirmReset((open) => !open)}>{t("恢复当前主题默认配色方案")}</button>
        <span style={{ position: "relative", display: "inline-flex" }}>
          <button type="button" style={button} disabled={!settings.highlightEnabled} onClick={backup}>{t("备份当前配色方案")}</button>
          {exported && <span className="dsh-export-toast" role="status" aria-live="polite">{t("已导出当前主题配色方案（JSON）。")}</span>}
        </span>
      </div>
      {confirmReset && <div ref={confirmRef} className="dsh-reset-popover" role="alertdialog" aria-label={t("恢复默认配色方案确认")}>
        <span style={{ flex: "1 1 200px", lineHeight: 1.5 }}>{t("将恢复当前主题的默认配色方案，当前修改会被覆盖。建议先备份。")}</span>
        <button type="button" style={button} onClick={backup}>{t("先备份")}</button>
        <button type="button" style={{ ...button, borderColor: "#2d6cdf", color: "#2d6cdf" }} onClick={() => { resetScheme(resolved); setConfirmReset(false); }}>{t("恢复默认")}</button>
        <button type="button" style={button} onClick={() => setConfirmReset(false)}>{t("取消")}</button>
      </div>}
    </div>
    {/* Stays mounted and greys out when highlighting is off. Hiding the block
        made the dialog jump on every toggle and hid configuration that is
        still saved, so disabling is both calmer and more honest. */}
    <fieldset disabled={!settings.highlightEnabled} className="dsh-scheme-fieldset" style={{ display: "contents" }}>
      <div className="dsh-scheme-fill" style={{ opacity: settings.highlightEnabled ? 1 : 0.55, transition: "opacity .15s ease" }}>
      <p style={{ fontSize: 11, lineHeight: 1.6, margin: "0 0 8px", flexShrink: 0, color: "var(--dsh-ssh-ops-muted, #8b93a1)" }}>{t("拖动左侧手柄排序，点击标签编辑。")}</p>
      <div ref={listRef} className="dsh-scheme-list" onClickCapture={onListClickCapture} onScroll={hideQuickHint}
        style={{ paddingRight: 6, borderTop: "1px solid var(--dsh-ssh-ops-border, #3a414b)" }}>
        {entries.map((entry) => {
          const custom = !Object.hasOwn(labels, entry.id), label = custom ? (entry.name || t("自定义配色项")) : labels[entry.id];
          return <SchemeEntry key={`${resolved}:${entry.id}`} entry={entry} label={label} dragging={dragId === entry.id}
            rowRef={(element) => { if (element) rows.current.set(entry.id, element); else rows.current.delete(entry.id); }}
            onChange={(patch) => change(entry.id, patch)}
            onHandlePointerDown={(event) => onHandlePointerDown(event, entry.id)}
            onShowHint={showQuickHint} onHideHint={hideQuickHint}
            onDelete={custom ? () => updateScheme(resolved, (scheme) => scheme.filter((item) => item.id !== entry.id)) : undefined} />;
        })}
        <div ref={indicator} className="dsh-drop-indicator" aria-hidden="true" />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10, flexShrink: 0 }}>
        <button type="button" disabled={entries.length >= MAX_SCHEME_ENTRIES || Boolean(pendingEntry)} style={{ ...button, marginTop: 0 }}
          title={pendingEntry ? t("先填写新建的配色项") : undefined} onClick={addEntry}>{t("添加配色项")}</button>
      </div>
      </div>
    </fieldset>
    {/* The preview stays live while the scheme is disabled: it is the sandbox
        for trying colors, so editing and coloring must work even when semantic
        highlighting is off (that is exactly when a user wants to evaluate a
        scheme before turning it on). */}
    <div style={{ fontSize: 12, margin: "16px 0 8px", flexShrink: 0 }}>{t("配色预览")}</div>
    <EditablePreview text={preview} onChange={setPreview} theme={activeTheme}
      entries={settings.highlightEnabled ? entries : []} />
  </section>;
}
