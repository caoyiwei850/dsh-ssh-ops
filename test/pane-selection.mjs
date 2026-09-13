// Pane visibility contract for the split Sidebar. The dock kit renders a
// single-pane root as <TabPanel> and a split root as a <div>, so splitting
// remounts the body of the pane that was already there. The pane's servers must
// survive that remount, a genuinely new pane must start empty, and the last
// pane to close a server must be the one that disconnects it.
import assert from "node:assert/strict";
import {
  adoptIntoView,
  anyViewShowsConnections,
  closeInView,
  forgetView,
  openInView,
  reconcileViews,
  resetPaneSessions,
  resolvePaneActiveConnection,
  selectInView,
  subscribePaneSessions,
  viewSession
} from "../src/client/pane-selection.js";

const connections = [{ connectionId: "a" }, { connectionId: "b" }];

// ── selection helpers ──
assert.equal(resolvePaneActiveConnection(connections, "a"), "a");
assert.equal(resolvePaneActiveConnection(connections, "b"), "b");
assert.equal(resolvePaneActiveConnection(connections, "gone"), "a");
assert.equal(resolvePaneActiveConnection([], "a"), null);

// ── an unknown view is empty: a freshly split pane shows nothing ──
assert.deepEqual(viewSession("new-pane"), { connectionIds: [], activeConnectionId: null });

// ── opening shows and selects the server in that view only ──
resetPaneSessions();
openInView("tab-left", "a");
assert.deepEqual(viewSession("tab-left"), { connectionIds: ["a"], activeConnectionId: "a" });
assert.deepEqual(viewSession("tab-right"), { connectionIds: [], activeConnectionId: null },
  "a second pane must not inherit the first pane's servers");

// ── requirement 1: a new pane beside a busy pane starts empty ──
adoptIntoView("tab-right", connections);
assert.deepEqual(viewSession("tab-right"), { connectionIds: [], activeConnectionId: null },
  "adoption only ever recovers a cold registry, never a live pane");

// ── the split remount: same view id, state restored, references not doubled ──
// The dock kit unmounts and remounts this body, so the store — not React state —
// is what carries the pane's servers across the split. Re-running the open path
// on remount must stay idempotent instead of adding a second reference.
openInView("tab-left", "a");
assert.deepEqual(viewSession("tab-left").connectionIds, ["a"], "the pane keeps the server it had");
assert.equal(closeInView("tab-left", "a"), true,
  "a remount must not leak a reference that would suppress the final disconnect");

// ── requirement 2: two panes on one server ──
resetPaneSessions();
openInView("tab-left", "a");
openInView("tab-right", "a");
assert.equal(closeInView("tab-left", "a"), false, "the first close keeps the host session alive");
assert.deepEqual(viewSession("tab-left"), { connectionIds: [], activeConnectionId: null });
assert.deepEqual(viewSession("tab-right"), { connectionIds: ["a"], activeConnectionId: "a" },
  "closing a tab in one pane does not disturb the other pane");
assert.equal(closeInView("tab-right", "a"), true, "the last visible pane disconnects the server");

// ── a pane whose host tab record disappears releases its references ──
// Closing the whole SSH tab must not disconnect (documented lifetime), but it
// must not leave a stale reference that blocks a later disconnect either.
resetPaneSessions();
openInView("tab-left", "a");
openInView("tab-right", "a");
forgetView("tab-left");
assert.equal(closeInView("tab-right", "a"), true,
  "a closed view must not keep the connection alive forever");

// ── each pane keeps its own selection over shared servers ──
resetPaneSessions();
openInView("tab-left", "a");
openInView("tab-left", "b");
openInView("tab-right", "b");
selectInView("tab-left", "a");
assert.equal(viewSession("tab-left").activeConnectionId, "a");
assert.equal(viewSession("tab-right").activeConnectionId, "b");

// ── a connection the host dropped leaves every pane ──
reconcileViews([{ connectionId: "b" }]);
assert.deepEqual(viewSession("tab-left").connectionIds, ["b"]);
assert.equal(viewSession("tab-left").activeConnectionId, "b");
assert.deepEqual(viewSession("tab-right").connectionIds, ["b"]);

// ── cold start after a page reload still adopts live connections ──
// Host sessions outlive the browser; without adoption they become zombies no
// pane can disconnect.
resetPaneSessions();
assert.equal(anyViewShowsConnections(), false);
adoptIntoView("tab-left", connections);
assert.deepEqual(viewSession("tab-left"), { connectionIds: ["a", "b"], activeConnectionId: "a" });
assert.equal(anyViewShowsConnections(), true);
adoptIntoView("tab-second", connections);
assert.deepEqual(viewSession("tab-second").connectionIds, [],
  "only a cold registry adopts; a pane opened later starts empty");
adoptIntoView("tab-third", []);
assert.deepEqual(viewSession("tab-third").connectionIds, []);

// ── subscribers are notified so sibling panes re-render ──
// The render snapshot is the view object itself, so its identity must stay put
// for an unchanged view (otherwise useSyncExternalStore would loop) and change
// on every real change.
resetPaneSessions();
let notifications = 0;
const unsubscribe = subscribePaneSessions(() => { notifications += 1; });
const emptySnapshot = viewSession("tab-left");
assert.equal(viewSession("tab-left"), emptySnapshot, "an untouched view keeps its snapshot identity");
openInView("tab-left", "a");
assert.equal(notifications, 1);
const openedSnapshot = viewSession("tab-left");
assert.notEqual(openedSnapshot, emptySnapshot, "a real change replaces the snapshot");
selectInView("tab-left", "a");
assert.equal(notifications, 1, "a no-op selection does not notify");
assert.equal(viewSession("tab-left"), openedSnapshot, "a no-op selection keeps the snapshot");
closeInView("tab-left", "a");
assert.equal(notifications, 2);
assert.notEqual(viewSession("tab-left"), openedSnapshot, "closing replaces the snapshot");
unsubscribe();
openInView("tab-left", "a");
assert.equal(notifications, 2, "an unsubscribed pane stops receiving changes");
resetPaneSessions();

console.log("pane selection: split-pane visibility survives remount, new panes start empty, last close disconnects: passed");
