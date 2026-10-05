// Structural contract for the official right-Sidebar integration: the client
// entry must follow the same two-stage path as the built-in Files tab, keep
// no legacy floating drawer (the pre-Sidebar fallback was removed — a host
// without the Sidebar services shows no terminal UI), and never couple SSH
// lifetime to view mounts. Source-level assertions, matching the repo's
// client-structure test style (the client bundle runs in a browser, not in
// this test).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const entry = await readFile(new URL("../src/client/index.jsx", import.meta.url), "utf8");
const panel = await readFile(new URL("../src/client/SshPanel.jsx", import.meta.url), "utf8");
const body = await readFile(new URL("../src/client/SshSidebarBody.jsx", import.meta.url), "utf8");
const pool = await readFile(new URL("../src/client/terminal-pool.js", import.meta.url), "utf8");

// ── the Sidebar body is a thin host: shared workspace, no own chrome ──
assert.match(body, /<SshPanel api=\{api\}/, "the Sidebar body renders the shared workspace");
assert.doesNotMatch(body, /position: "fixed"|onPointerDown/, "the Sidebar body adds no floating-panel chrome");

// ── two-stage registration, exactly the public path ──
assert.match(entry, /sidebarRightTabs\.register\(\{/, "stage one: the tab type registers into ctx.sidebarRightTabs");
assert.match(entry, /slots\.inject\("sidebar\.right\.pane\.tab"/, "stage two: the body waits for the keyed Sidebar seat");
assert.match(entry, /key: SSH_TAB_ID/, "the body registers under the type definition's id");
assert.match(entry, /kind: SSH_TAB_KIND/, "the type declares its kind");
assert.doesNotMatch(entry, /patterns:\s*\[/, "a page type opened by openTab declares no address patterns");
assert.match(entry, /openTab\(SSH_TAB_KIND\)/, "the SSH button opens/focuses the tab by kind");

// ── settings navigation: resources are not hidden behind Plugins ──
assert.match(entry, /slots\.inject\("settings\.section"/, "SSH resources register as a first-class Settings section");
assert.match(entry, /name: "settings\.section"/, "the registration targets the official Settings-section slot");
assert.match(entry, /id: "ssh-ops-resources"/, "the Settings section keeps a stable identity");
assert.match(entry, /icon: "terminal"/, "the Settings menu receives the terminal icon");
assert.doesNotMatch(entry, /settings\.plugins\.tab/, "resources no longer appear as a Plugins sub-tab");

// ── late Sidebar services, and no legacy drawer anywhere ──
// The right-Sidebar's services may be provided after an extension bundle is
// evaluated. Waiting on them prevents a one-time `ctx.get()` snapshot from
// missing a host that does support tabs. The old floating-drawer fallback is
// gone: its component, its shell.overlay slot and its toggle button must all
// stay deleted.
assert.match(entry, /activateSidebarWhenAvailable\(/,
  "the plugin delegates Sidebar readiness to the delayed-service lifecycle");
assert.doesNotMatch(entry, /ctx\.get\("sidebarRightTabs"\)/,
  "the Sidebar decision is not frozen before the host has finished registering services");
for (const src of [entry, panel, body]) {
  assert.doesNotMatch(src, /SshDrawer|shell\.overlay|applyLegacyRegistrations|sshUiSetOpen\b/,
    "no legacy drawer component, slot, registration or visibility toggle remains");
}

// ── the workspace carries no outer geometry of its own ──
const workspaceBlock = panel.match(/workspace: \{[^}]*\}/)?.[0] ?? "";
assert.notEqual(workspaceBlock, "", "the workspace root style exists");
assert.doesNotMatch(workspaceBlock, /position: "fixed"|width:|top:|right:/,
  "the workspace root is position-less; the Sidebar owns placement (dialog modals may be viewport-fixed)");
assert.doesNotMatch(panel, /margin-right|--dsh-ssh-ops-panel-space|data-dsh-ssh-ops-panel-open/,
  "no chat-column reservation inside the workspace: the official Sidebar manages the column");

// ── connection lifetime is independent of view mounts ──
assert.doesNotMatch(panel, /api\.disconnect\((?!connectionId)/, "unmount paths never disconnect by accident");
assert.match(pool, /release never disposes|keeps its scrollback|survives/i, "the pool documents keep-alive intent");
assert.match(panel, /terminalPool\.release\(/, "unmount releases the pooled terminal instead of disposing it");
assert.match(panel, /inputSubscription\.dispose\(\)/, "unmount releases the xterm input listener");
assert.doesNotMatch(panel, /term\.dispose\(\)/, "XtermView itself never disposes the terminal on unmount");
assert.match(panel, /terminalPool\.acquire\(/, "mounts acquire through the pool");
assert.match(panel, /ResizeObserver\(fitNow\)/, "remounts refit via ResizeObserver (sidebar resize/fullscreen)");

console.log("sidebar integration structure: two-stage registration, drawer-free, geometry-free workspace: passed");
