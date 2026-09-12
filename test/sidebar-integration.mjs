// Structural contract for the official right-Sidebar integration: the client
// entry must follow the same two-stage path as the built-in Files tab, keep
// the drawer as an old-DSH fallback, and never couple SSH lifetime to view
// mounts. Source-level assertions, matching the repo's client-structure test
// style (the client bundle runs in a browser, not in this test).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const entry = await readFile(new URL("../src/client/index.jsx", import.meta.url), "utf8");
const panel = await readFile(new URL("../src/client/SshPanel.jsx", import.meta.url), "utf8");
const drawer = await readFile(new URL("../src/client/SshDrawer.jsx", import.meta.url), "utf8");
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

// ── late Sidebar services and old-DSH drawer fallback ──
// The right-Sidebar's services may be provided after an extension bundle is
// evaluated.  Waiting on them prevents a one-time `ctx.get()` snapshot from
// incorrectly selecting the legacy drawer in a host that does support tabs.
assert.match(entry, /activateSidebarWhenAvailable\(/,
  "new DSH delegates Sidebar readiness to the delayed-service lifecycle");
assert.doesNotMatch(entry, /ctx\.get\("sidebarRightTabs"\)/,
  "the Sidebar decision is not frozen before the host has finished registering services");
assert.match(entry, /shell\.overlay/, "legacy DSH keeps the floating drawer");
assert.match(drawer, /sshUiSetOpen\(false\)/, "drawer × only hides, never disconnects");
assert.match(entry, /applyLegacyRegistrations/, "drawer-mode registrations remain wired");

// ── the workspace carries no outer geometry of its own ──
const workspaceBlock = panel.match(/workspace: \{[^}]*\}/)?.[0] ?? "";
assert.notEqual(workspaceBlock, "", "the workspace root style exists");
assert.doesNotMatch(workspaceBlock, /position: "fixed"|width:|top:|right:/,
  "the workspace root is position-less; hosts own placement (dialog modals may be viewport-fixed)");
assert.doesNotMatch(panel, /margin-right|--dsh-ssh-ops-panel-space|data-dsh-ssh-ops-panel-open/,
  "no chat-column reservation inside the workspace: the official Sidebar manages the column");
assert.doesNotMatch(panel, /sshUiSetOpen/, "the workspace never toggles drawer visibility");
assert.match(drawer, /data-dsh-ssh-ops-panel="true"/, "the drawer keeps its outer shell marker");

// ── connection lifetime is independent of view mounts ──
assert.doesNotMatch(panel, /api\.disconnect\((?!connectionId)/, "unmount paths never disconnect by accident");
assert.match(pool, /release never disposes|keeps its scrollback|survives/i, "the pool documents keep-alive intent");
assert.match(panel, /terminalPool\.release\(/, "unmount releases the pooled terminal instead of disposing it");
assert.match(panel, /inputSubscription\.dispose\(\)/, "unmount releases the xterm input listener");
assert.doesNotMatch(panel, /term\.dispose\(\)/, "XtermView itself never disposes the terminal on unmount");
assert.match(panel, /terminalPool\.acquire\(/, "mounts acquire through the pool");
assert.match(panel, /ResizeObserver\(fitNow\)/, "remounts refit via ResizeObserver (sidebar resize/fullscreen)");

console.log("sidebar integration structure: two-stage registration, drawer fallback, geometry-free workspace: passed");
