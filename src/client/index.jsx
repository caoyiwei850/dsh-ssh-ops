/**
 * dsh-ssh-ops browser plugin entry.
 *
 * Two integration modes, chosen per environment:
 *
 * - Official Sidebar mode (new DSH, `sidebarRightTabs` + `sidebarRight`
 *   present): the SSH terminal is a TAB of the official right-Sidebar, beside
 *   the built-in Files tab. Registration follows the same public two-stage
 *   path every tab type uses — the type into `ctx.sidebarRightTabs`, the body
 *   into the keyed `sidebar.right.pane.tab` seat under the type's `id`. The
 *   session-header SSH button opens or focuses that tab (repeated clicks
 *   focus, never duplicate). Width, split, fullscreen and collapse are the
 *   Sidebar's; no floating panel, no chat-column margin, no own resize.
 * - Drawer mode (older DSH): the previous fixed right-side floating panel
 *   (`SshDrawer.jsx` in `shell.overlay`) with its own width and the chat
 *   column reservation — kept as the compatibility fallback.
 *
 * Connection lifetime is independent of the view in both modes: switching
 * tabs, collapsing the Sidebar, closing the SSH tab, or switching chats never
 * disconnects; terminals are pooled client-side (`terminal-pool.js`) and the
 * host replays output buffered while no view was attached.
 */
import * as React from "react";
import { createSshApi } from "./api.js";
import { IconTerminal16 } from "./IconTerminal16.jsx";
import { SshDrawer } from "./SshDrawer.jsx";
import { SshSidebarBody } from "./SshSidebarBody.jsx";
import { SshResources } from "./SshResources.jsx";
import { getSshUiSnapshot, sshUiSetOpen, useSshUi } from "./store.js";
import { activateSidebarWhenAvailable } from "./sidebar-lifecycle.js";
import TYPERT_REMOTE from "../remote.js";

const NS = "ssh-ops";

/** The tab kind this plugin owns in the official Sidebar, and its registry id. */
export const SSH_TAB_KIND = "ssh";
export const SSH_TAB_ID = "dsh-ssh-ops";

export const inject = ["remote", "remote.credentials", "slots", "locale", "connection"];

export async function apply(ctx) {
  const disposers = [];
  /** Track one disposer; on any later failure everything unwinds in reverse. */
  const own = (dispose) => {
    if (typeof dispose === "function") disposers.push(dispose);
    return dispose;
  };
  try {
    const dispose = await ctx.remote.$mount(TYPERT_REMOTE);
    own(dispose);
  } catch (error) {
    for (const d of disposers.reverse()) await d();
    throw error;
  }

  const api = createSshApi(ctx);

  const localeDispose = own(ctx.locale.register(NS, {
    zh: {
      sshAction: "SSH 终端",
      sshActionClose: "关闭 SSH 终端",
      sidebarTabTitle: "SSH 终端",
      openSidebarTab: "打开或聚焦 SSH 终端标签",
      guideTitle: "SSH 终端",
      guideDescription: "连接服务器，使用终端、远程文件、转发、快捷命令与数据库工具"
    },
    en: {
      sshAction: "SSH Terminal",
      sshActionClose: "Close SSH terminal",
      sidebarTabTitle: "SSH Terminal",
      openSidebarTab: "Open or focus the SSH terminal tab",
      guideTitle: "SSH Terminal",
      guideDescription: "Connect to servers with a terminal, remote files, tunnels, snippets, and database tools"
    }
  }));

  const t = ctx.locale.bind(NS);

  // Start with the legacy drawer so older DSH releases remain usable. Newer
  // hosts provide their Sidebar faces asynchronously; a one-time ctx.get()
  // snapshot here races that startup and permanently selects the drawer.
  own(activateSidebarWhenAvailable(ctx, {
    registerLegacy: (legacyCtx) => applyLegacyRegistrations(legacyCtx, { api }),
    registerSidebar: (sidebarCtx) => applySidebarRegistrations(sidebarCtx, { api, t }),
    onSidebarError: (error) => {
      console.error("[dsh-ssh-ops] sidebar tab registration failed; keeping legacy drawer:", error);
    }
  }));

  // A real settings tab owns the durable server resource inventory, in both
  // modes. The header SSH button remains only a terminal visibility toggle.
  own(ctx.slots.inject("settings.plugins.tab", () =>
    ctx.slots.register(
      {
        name: "settings.plugins.tab",
        id: "ssh-ops-resources",
        order: 80,
        label: "SSH 资源",
        locale: NS,
        inject: () => ({ api, credentials: ctx.remote?.credentials })
      },
      SshResources
    )
  ));

  return async () => {
    for (const d of disposers.reverse()) await d();
  };
}

/** Official Sidebar registrations: both stages live under one disposable scope. */
function applySidebarRegistrations(ctx, { api, t }) {
  const disposers = [];
  const own = (dispose) => {
    if (typeof dispose === "function") disposers.push(dispose);
    return dispose;
  };
  try {
    own(ctx.sidebarRightTabs.register({
      id: SSH_TAB_ID,
      kind: SSH_TAB_KIND,
      priority: "extension",
      title: () => t("sidebarTabTitle"),
      guide: [{
        order: 20,
        title: () => t("guideTitle"),
        description: () => t("guideDescription"),
        icon: IconTerminal16
      }]
    }));
    own(ctx.slots.inject("sidebar.right.pane.tab", () =>
      ctx.slots.register(
        {
          name: "sidebar.right.pane.tab",
          key: SSH_TAB_ID,
          locale: NS,
          inject: () => ({ api, credentials: ctx.remote?.credentials })
        },
        SshSidebarBody
      )
    ));
    own(ctx.slots.inject("conversation.session.header.actions", () =>
      ctx.slots.register(
        {
          name: "conversation.session.header.actions",
          id: "ssh-ops-tab-action",
          order: 90,
          locale: NS
        },
        function SshSidebarTabAction() {
          return React.createElement(SshTabButtonHost, {
            press: () => {
              try {
                ctx.sidebarRight.openTab(SSH_TAB_KIND);
              } catch (error) {
                console.warn("[dsh-ssh-ops] openTab failed:", error?.message ?? error);
              }
            },
            isActive: () => {
              try {
                if (!ctx.sidebarRight.isExpanded()) return false;
                return ctx.sidebarRight.active()?.kind === SSH_TAB_KIND;
              } catch {
                return false;
              }
            },
            title: t("openSidebarTab"),
            ariaLabel: t("sidebarTabTitle"),
            watchActive: true
          });
        }
      )
    ));
    return () => {
      for (const dispose of disposers.reverse()) dispose();
    };
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    throw error;
  }
}

/** Drawer-mode registrations (legacy DSH): toggle button + shell.overlay panel. */
function applyLegacyRegistrations(ctx, { api }) {
  const disposers = [];
  const own = (dispose) => {
    if (typeof dispose === "function") disposers.push(dispose);
    return dispose;
  };
  // DSH does not expose an additive slot inside the session tab strip.  This
  // session-scoped contribution mounts a native button beside the existing
  // Conversation/Trajectory tabs, while preserving the current chat view and
  // the resizable right-side terminal drawer.
  own(ctx.slots.inject("conversation.session.header.actions", () =>
    ctx.slots.register(
      {
        name: "conversation.session.header.actions",
        id: "ssh-ops-tab-action",
        order: 90,
        locale: NS
      },
      SshDrawerTabAction
    )
  ));

  // The panel itself: a fixed right-side floating panel, mounted at the shell
  // overlay level so it spans the whole app frame regardless of conversation
  // scroll state.
  own(ctx.slots.inject("shell.overlay", () =>
    ctx.slots.register(
      {
        name: "shell.overlay",
        id: "ssh-ops-panel",
        order: 100,
        locale: NS,
        inject: () => ({ api, credentials: ctx.remote?.credentials })
      },
      SshDrawer
    )
  ));
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}

const SSH_TAB_SELECTOR = '[data-dsh-ssh-ops-tab="true"]';

/**
 * The settings dialog also owns a tablist.  SSH belongs only beside the
 * conversation / trajectory view tabs, never inside Settings → Plugins.
 */
function findConversationTablist() {
  return [...document.querySelectorAll('[role="tablist"]')].find((tablist) => {
    const text = tablist.textContent?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
    return (text.includes("对话") && text.includes("轨迹"))
      || (text.includes("conversation") && text.includes("trajectory"));
  });
}

function syncSshTabButton(button, active, { title, activeTitle }) {
  const activeClass = button.dataset.dshSshOpsActiveClass;
  if (activeClass) button.classList.toggle(activeClass, active);
  button.setAttribute("aria-pressed", active ? "true" : "false");
  button.title = active ? (activeTitle ?? title) : title;
  // The copied host tab class carries an underline.  Explicitly control it so
  // SSH only looks selected while its terminal view is actually showing.
  button.style.setProperty(
    "color",
    active ? "var(--dsw-alias-brand, #2d6cdf)" : "var(--dsw-alias-label, currentColor)",
    "important"
  );
  button.style.setProperty(
    "border-bottom-color",
    active ? "var(--dsw-alias-brand, #2d6cdf)" : "transparent",
    "important"
  );
}

/**
 * Shared host for the DOM-injected SSH button in the conversation tab strip.
 * The chat tab strip re-renders constantly during message streaming; the
 * observer only needs to keep one button mounted, so bursts coalesce into at
 * most one scan per animation frame. Behavior (press / active) is injected by
 * the mode-specific caller; the Sidebar mode additionally polls `isActive`,
 * because the Sidebar's layout store is session-scoped and offers no
 * cross-plugin subscription for the small "is my tab showing" read.
 */
function SshTabButtonHost({ press, isActive, title, activeTitle, ariaLabel, watchActive }) {
  React.useEffect(() => {
    const mount = () => {
      const tablist = findConversationTablist();
      if (!tablist) return;
      // An older plugin client used the first tablist on the page, which can
      // be Settings → Plugins. Remove that stale misplaced control whenever
      // the current client mounts, then keep exactly one in the chat tab bar.
      document.querySelectorAll(SSH_TAB_SELECTOR).forEach((button) => {
        if (!tablist.contains(button)) button.remove();
      });
      let button = tablist.querySelector(SSH_TAB_SELECTOR);
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.dataset.dshSshOpsTab = "true";
        button.textContent = "SSH";
        button.setAttribute("aria-label", ariaLabel);
        // Copy an unselected host tab.  Copying the first tab would also copy
        // its `tabActive` class, whose ::after pseudo-element leaves a bright
        // underline visible even while the SSH view is not showing.
        const inactiveTab = tablist.querySelector('[role="tab"][aria-selected="false"]');
        const fallbackTab = tablist.querySelector('[role="tab"]');
        button.className = inactiveTab?.className ?? fallbackTab?.className.replace(/\S*tabActive\b/g, "").trim() ?? "";
        const selectedTab = tablist.querySelector('[role="tab"][aria-selected="true"]');
        const activeClass = [...(selectedTab?.classList ?? [])].find(
          (className) => /tabActive\b/.test(className) && !button.classList.contains(className)
        );
        if (activeClass) button.dataset.dshSshOpsActiveClass = activeClass;
        tablist.appendChild(button);
      }
      // Assignment (rather than addEventListener) makes remounts idempotent.
      button.onclick = () => press();
      syncSshTabButton(button, isActive(), { title, activeTitle });
    };

    mount();
    let scheduled = false;
    let animationFrame = null;
    let disposed = false;
    const observer = new MutationObserver(() => {
      if (disposed || scheduled) return;
      scheduled = true;
      animationFrame = requestAnimationFrame(() => {
        animationFrame = null;
        scheduled = false;
        if (disposed) return;
        mount();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      disposed = true;
      observer.disconnect();
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      document.querySelectorAll(SSH_TAB_SELECTOR).forEach((button) => button.remove());
    };
  }, []);

  React.useEffect(() => {
    if (!watchActive) return undefined;
    const sync = () => {
      document.querySelectorAll(SSH_TAB_SELECTOR).forEach((button) => {
        syncSshTabButton(button, isActive(), { title, activeTitle });
      });
    };
    sync();
    const timer = setInterval(sync, 1000);
    return () => clearInterval(timer);
  }, [watchActive]);

  return null;
}

/** Drawer mode: the button toggles the floating panel via the UI store. */
function SshDrawerTabAction() {
  const ui = useSshUi();
  return React.createElement(SshTabButtonHost, {
    press: () => sshUiSetOpen(!getSshUiSnapshot().open),
    isActive: () => getSshUiSnapshot().open,
    title: "打开 SSH 终端",
    activeTitle: "关闭 SSH 终端",
    ariaLabel: "SSH 终端",
    watchActive: false
  });
}
