/**
 * Legacy host for the SSH workspace: the fixed right-side floating drawer used
 * on DSH builds without the official right-Sidebar tab system
 * (`sidebarRightTabs` / `sidebar.right.pane.tab` absent).
 *
 * This component owns ONLY the outer chrome — fixed positioning, drag-resize
 * width, the hide (×) button, and the chat-column reservation CSS. On new DSH
 * it is never registered; width, split, fullscreen and collapse are the
 * Sidebar's business there (`SshSidebarBody.jsx`). Hiding the drawer never
 * disconnects: connections are host-side, and the workspace unmount keeps
 * terminals pooled for the next open.
 */
import * as React from "react";
import { useSshUi, sshUiSetOpen } from "./store.js";
import { SshPanel } from "./SshPanel.jsx";

const { useEffect, useRef, useState } = React;

const PANEL_WIDTH_KEY = "dsh-ssh-ops.panel-width";
const PANEL_MIN_WIDTH = 320;
const PANEL_MAX_WIDTH = 720;
let drawerStylesInjected = false;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function maxPanelWidth() {
  return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, Math.floor(window.innerWidth * 0.7)));
}

function clampPanelWidth(width) {
  return clamp(Math.round(width), PANEL_MIN_WIDTH, maxPanelWidth());
}

function initialPanelWidth() {
  try {
    const stored = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    if (Number.isFinite(stored)) return clampPanelWidth(stored);
  } catch {}
  return 480;
}

/**
 * Whether the plugin runs inside the DSH Desktop shell, whose frameless window
 * draws its own titlebar (and window controls) above the web content.
 */
function isDesktopShell() {
  return (
    (typeof document !== "undefined" && document.body?.classList?.contains("dsh-desktop-windows-titlebar-layout")) ||
    (typeof document !== "undefined" && document.getElementById("dsh-desktop-drag-region") !== null)
  );
}

/**
 * The DSH Desktop shell's window controls (minimize / maximize / close) sit in
 * the top-right of a ~36px frameless titlebar. Align the drawer's top edge with
 * the sidebar "New session" button so the drawer header (×) lands below that
 * titlebar instead of covering the window close button. Falls back to 74px
 * (36px titlebar + sidebar brand row) when the button cannot be measured.
 */
function desktopPanelTop() {
  if (!isDesktopShell()) return 0;
  const sidebar = document.querySelector("[data-dsh-sidebar-root]");
  if (!sidebar) return 74;
  const labelRe = /新建会话|New session/i;
  let best = null;
  for (const button of sidebar.querySelectorAll("button")) {
    if (!labelRe.test(button.getAttribute("aria-label") ?? "")) continue;
    // The brand logo button shares the same aria-label but lives higher in the
    // logo row; the real New Session button is the lower of the two.
    if (best === null || button.getBoundingClientRect().top > best.getBoundingClientRect().top) {
      best = button;
    }
  }
  if (!best) return 74;
  const top = Math.round(best.getBoundingClientRect().top);
  return top > 0 ? top : 74;
}

/**
 * Drawer-only layout CSS. The shell overlay does not reserve layout space on
 * its own, so while the drawer is open the main conversation column yields the
 * drawer width (minus whatever lane DSH-better-sidebar already reserves).
 * None of this applies on new DSH, where the official Sidebar manages the
 * column and this component is not mounted at all.
 */
function ensureDrawerStyles() {
  if (drawerStylesInjected) return;
  drawerStylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
html[data-dsh-ssh-ops-panel-open] [class*="centerCol"] {
  margin-right: var(--dsh-ssh-ops-panel-space, 496px) !important;
  transition: margin-right 160ms ease;
}

/*
 * DSH-better-sidebar reserves its own right-hand lane by publishing
 * --dsh-sidebar-width.  Keep this drawer inside the remaining app frame
 * instead of covering that lane.
 */
html[data-dsh-ssh-ops-panel-open] [data-dsh-ssh-ops-panel] {
  right: var(--dsh-sidebar-width, 0px) !important;
}

body[data-dsh-sidebar-collapsed] [data-dsh-ssh-ops-panel-header] {
  padding-right: 84px !important;
}

/* On narrow screens, preserving a usable conversation column matters more
 * than a permanent split view, so the terminal remains an overlay. */
@media (max-width: 900px) {
  html[data-dsh-ssh-ops-panel-open] [class*="centerCol"] {
    margin-right: 0 !important;
  }
}`;
  document.head.appendChild(style);
}

const drawerStyles = {
  root: {
    position: "fixed",
    top: 0,
    right: 0,
    bottom: 0,
    width: 480,
    maxWidth: "70vw",
    zIndex: 900,
    display: "flex",
    flexDirection: "column",
    background: "#101418",
    borderLeft: "1px solid #262b33",
    boxShadow: "-8px 0 24px rgba(0,0,0,.35)",
    color: "#d7dbe2"
  },
  resizeHandle: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: -5,
    width: 10,
    cursor: "col-resize",
    zIndex: 1,
    touchAction: "none"
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 12px",
    borderBottom: "1px solid #262b33",
    flex: "none"
  },
  title: { fontSize: 13, fontWeight: 600, flex: 1 },
  btnSmall: {
    background: "transparent",
    border: "1px solid #3a414b",
    color: "#d7dbe2",
    borderRadius: 6,
    width: 26,
    height: 26,
    cursor: "pointer",
    fontSize: 14,
    lineHeight: 1
  }
};

export function SshDrawer({ api, credentials }) {
  const ui = useSshUi();
  const [panelWidth, setPanelWidth] = useState(initialPanelWidth);
  const [panelTop, setPanelTop] = useState(() => desktopPanelTop());
  const panelRef = useRef(null);

  // Reserve conversation space while the drawer is open: the chat column's
  // margin tracks the drawer's measured width. Removed again on hide/unmount.
  useEffect(() => {
    if (!ui.open) return undefined;
    ensureDrawerStyles();
    const root = document.documentElement;
    const syncReservedSpace = () => {
      const width = Math.ceil(panelRef.current?.getBoundingClientRect().width || 480);
      // Keep a small breathing gap between the message column and the drawer.
      root.style.setProperty("--dsh-ssh-ops-panel-space", `${width + 16}px`);
    };
    syncReservedSpace();
    root.dataset.dshSshOpsPanelOpen = "true";
    const observer = new ResizeObserver(syncReservedSpace);
    if (panelRef.current) observer.observe(panelRef.current);
    return () => {
      observer.disconnect();
      delete root.dataset.dshSshOpsPanelOpen;
      root.style.removeProperty("--dsh-ssh-ops-panel-space");
    };
  }, [ui.open]);

  useEffect(() => {
    if (!ui.open) return undefined;
    const sync = () => setPanelTop(desktopPanelTop());
    sync();
    window.addEventListener("resize", sync);
    const sidebar = document.querySelector("[data-dsh-sidebar-root]");
    let observer = null;
    if (sidebar) {
      observer = new ResizeObserver(sync);
      observer.observe(sidebar);
    }
    const timer = setInterval(sync, 2000);
    return () => {
      window.removeEventListener("resize", sync);
      observer?.disconnect();
      clearInterval(timer);
    };
  }, [ui.open]);

  useEffect(() => {
    const onWindowResize = () => setPanelWidth((width) => clampPanelWidth(width));
    window.addEventListener("resize", onWindowResize);
    return () => window.removeEventListener("resize", onWindowResize);
  }, []);

  if (!ui.open) return null;

  const beginResize = (event) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panelRef.current?.getBoundingClientRect().width ?? panelWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onPointerMove = (moveEvent) => {
      // The drawer is anchored at the right, so moving its left edge left makes
      // it wider and moving it right makes it narrower.
      setPanelWidth(clampPanelWidth(startWidth + startX - moveEvent.clientX));
    };
    const endResize = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endResize);
      window.removeEventListener("pointercancel", endResize);
      setPanelWidth((width) => {
        try {
          localStorage.setItem(PANEL_WIDTH_KEY, String(width));
        } catch {}
        return width;
      });
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endResize);
    window.addEventListener("pointercancel", endResize);
  };

  return (
    <div ref={panelRef} data-dsh-ssh-ops-panel="true" style={{ ...drawerStyles.root, width: panelWidth, top: panelTop }}>
      <div
        style={drawerStyles.resizeHandle}
        onPointerDown={beginResize}
        role="separator"
        aria-label="调整 SSH 终端宽度"
        aria-orientation="vertical"
        title="拖动以调整 SSH 终端宽度"
      />
      <div data-dsh-ssh-ops-panel-header="true" style={drawerStyles.header}>
        <span style={drawerStyles.title}>SSH 终端</span>
        {/* Hide, not disconnect: connections and pooled terminals survive. */}
        <button onClick={() => sshUiSetOpen(false)} disabled={ui.busy} style={drawerStyles.btnSmall}
          title="隐藏 SSH 终端面板（不断开连接）">×
        </button>
      </div>
      <SshPanel api={api} credentials={credentials} />
    </div>
  );
}
