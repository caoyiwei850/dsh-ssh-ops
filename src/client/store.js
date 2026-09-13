/**
 * Module-level UI store for the SSH ops panel: open state, connection list,
 * active connection/session, connection form state, and error status. The
 * header action and the panel share it via useSyncExternalStore.
 */
import { useSyncExternalStore } from "react";

function initialOpen() {
  // The terminal is a temporary work surface, not a saved workspace pane.
  // Always start closed so opening DSH never steals conversation space.
  try {
    // Clear the key written by earlier releases so they do not reopen the
    // drawer after this upgrade.
    localStorage.removeItem("dsh-ssh-ops.open");
  } catch {
  }
  return false;
}

let snapshot = {
  open: initialOpen(),
  connections: [],
  activeConnectionId: null,
  // A settings-page "进入项目" request gives the first mounted SSH pane a
  // starting SFTP directory matching the guarded terminal cd.
  projectTarget: null,
  busy: false,
  error: null
};

const listeners = new Set();

function set(patch) {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

export function getSshUiSnapshot() {
  return snapshot;
}

export function subscribeSshUi(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSshUi() {
  return useSyncExternalStore(subscribeSshUi, getSshUiSnapshot);
}

export function sshUiSetOpen(open) {
  set({ open });
}

/**
 * How the current host shows the SSH surface, registered by whichever mode is
 * active: the official Sidebar focuses its tab, while the legacy drawer needs
 * nothing because it renders off the `open` flag.
 */
let surfaceOpener = null;

export function sshUiSetSurfaceOpener(opener) {
  surfaceOpener = typeof opener === "function" ? opener : null;
}

/**
 * Ask the host to show the SSH surface. Callers that do not own a pane — the
 * resources page, for one — use this instead of reaching for `open`, which only
 * the legacy drawer reads: in Sidebar mode a bare `sshUiSetOpen(true)` did
 * nothing at all, so a connect from the settings page never revealed a terminal.
 */
export function sshUiRequestSurface() {
  set({ open: true });
  surfaceOpener?.();
}

export function sshUiSetConnections(connections) {
  set({ connections });
}

/** Select the active connection (the tab whose terminal/files/tunnels show). */
export function sshUiSetActiveConnection(connectionId) {
  set({ activeConnectionId: connectionId });
}

export function sshUiSetProjectTarget(connectionId, path) {
  set({ projectTarget: connectionId && path ? { connectionId, path } : null });
}

export function sshUiSetBusy(busy) {
  set({ busy });
}

export function sshUiSetError(error) {
  set({ error });
}
