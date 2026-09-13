/**
 * Which servers each Sidebar pane shows. A split pane is a sibling React tree
 * over one shared host-side connection list, so this cannot be React state:
 * the dock kit renders a single-pane root as a `<TabPanel>` and a split root as
 * a `<div>`, so splitting swaps the element type at the root and REMOUNTS the
 * body. Per-instance state is lost there (the pane's server tabs vanished) and a
 * per-instance random pane id leaks a reference, which suppressed the final
 * disconnect.
 *
 * A view is therefore identified by the host's own tab id, which survives that
 * remount and disappears exactly when the tab does, and every view's state
 * lives in this module-level store. Reference counting answers one question:
 * after this view drops a connection, does any other view still show it?
 */

/** The legacy drawer is one view for the whole page lifetime. */
export const DRAWER_VIEW_ID = "drawer";

/** The pane's selection over its own visible connections. */
export function resolvePaneActiveConnection(connections, preferredConnectionId) {
  if (connections.some((connection) => connection.connectionId === preferredConnectionId)) return preferredConnectionId;
  return connections[0]?.connectionId ?? null;
}

/**
 * A view with no recorded state yet: a freshly split pane shows nothing. The
 * frozen sentinel is returned unchanged for every unknown view so a pane can
 * read it through `useSyncExternalStore` without looping.
 */
const NO_VIEW = Object.freeze({ connectionIds: [], activeConnectionId: null });

/** viewId → { connectionIds, activeConnectionId }; survives body remounts. */
const views = new Map();
/** connectionId → Set<viewId> that currently show it. */
const references = new Map();
const listeners = new Set();

function emit() {
  for (const listener of listeners) listener();
}

/** Subscribe a pane's render to any view change. */
export function subscribePaneSessions(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * This view's visible connections and selection, or the empty view. The object
 * identity is the render snapshot: unchanged for an unchanged view (so a pane
 * reading it through `useSyncExternalStore` never loops) and replaced on every
 * real change.
 */
export function viewSession(viewId) {
  return views.get(viewId) ?? NO_VIEW;
}

/** Views are replaced, never mutated, so a pane's snapshot identity tracks changes. */
function setView(viewId, view) {
  views.set(viewId, view);
  emit();
}

function addReference(viewId, connectionId) {
  let viewIds = references.get(connectionId);
  if (viewIds === undefined) {
    viewIds = new Set();
    references.set(connectionId, viewIds);
  }
  viewIds.add(viewId);
}

/** Returns true when this was the connection's last visible view. */
function removeReference(viewId, connectionId) {
  const viewIds = references.get(connectionId);
  if (viewIds === undefined || !viewIds.delete(viewId)) return false;
  if (viewIds.size > 0) return false;
  references.delete(connectionId);
  return true;
}

/** Whether any view still shows any connection. */
export function anyViewShowsConnections() {
  for (const view of views.values()) {
    if (view.connectionIds.length > 0) return true;
  }
  return false;
}

/** Show `connectionId` in this view and select it. */
export function openInView(viewId, connectionId) {
  const view = viewSession(viewId);
  if (view.connectionIds.includes(connectionId)) {
    if (view.activeConnectionId === connectionId) return;
    setView(viewId, { ...view, activeConnectionId: connectionId });
    return;
  }
  addReference(viewId, connectionId);
  setView(viewId, {
    connectionIds: [...view.connectionIds, connectionId],
    activeConnectionId: connectionId
  });
}

/** Select an already-visible connection without changing the visible set. */
export function selectInView(viewId, connectionId) {
  const view = viewSession(viewId);
  if (view.activeConnectionId === connectionId) return;
  setView(viewId, { ...view, activeConnectionId: connectionId });
}

/**
 * Hide one server tab from this view.
 * @returns true when no view shows that connection any more, so its host
 * session can be disconnected; false while another pane still shows it.
 */
export function closeInView(viewId, connectionId) {
  const view = viewSession(viewId);
  const remaining = view.connectionIds.filter((id) => id !== connectionId);
  if (remaining.length === view.connectionIds.length) return false;
  const orphaned = removeReference(viewId, connectionId);
  setView(viewId, {
    connectionIds: remaining,
    activeConnectionId: view.activeConnectionId === connectionId
      ? remaining[0] ?? null
      : view.activeConnectionId
  });
  return orphaned;
}

/** Drop connections the host no longer reports (closed remotely or by another pane). */
export function reconcileViews(connections) {
  const live = new Set(connections.map((connection) => connection.connectionId));
  for (const [viewId, view] of [...views]) {
    const remaining = view.connectionIds.filter((connectionId) => live.has(connectionId));
    const selectionGone = view.activeConnectionId !== null && !live.has(view.activeConnectionId);
    if (remaining.length === view.connectionIds.length && !selectionGone) continue;
    for (const connectionId of view.connectionIds) {
      if (!live.has(connectionId)) removeReference(viewId, connectionId);
    }
    setView(viewId, {
      connectionIds: remaining,
      activeConnectionId: selectionGone ? remaining[0] ?? null : view.activeConnectionId
    });
  }
}

/**
 * The view is gone for good (its host tab record disappeared, or the plugin
 * unloaded). Release its references so a later close in another pane can still
 * be recognized as the last one — but never disconnect here: connection
 * lifetime is independent of the view.
 */
export function forgetView(viewId) {
  const view = views.get(viewId);
  if (view === undefined) return;
  for (const connectionId of view.connectionIds) removeReference(viewId, connectionId);
  views.delete(viewId);
  emit();
}

/**
 * Cold-start recovery. Host-side connections outlive the client registry (a
 * page reload wipes it), and a connection no pane shows cannot be disconnected
 * from the panel. Only while NO view tracks anything does the first mounting
 * view adopt the live list; a pane opened beside a pane that already shows
 * servers deliberately starts empty.
 */
export function adoptIntoView(viewId, connections) {
  if (connections.length === 0 || anyViewShowsConnections()) return;
  const connectionIds = connections.map((connection) => connection.connectionId);
  for (const connectionId of connectionIds) addReference(viewId, connectionId);
  setView(viewId, { connectionIds, activeConnectionId: connectionIds[0] ?? null });
}

/** Test/plugin-teardown helper. */
export function resetPaneSessions() {
  views.clear();
  references.clear();
  emit();
}
