/**
 * The SSH tab's body in the official right-Sidebar (`sidebar.right.pane.tab`,
 * keyed by this plugin's tab-type id). The Sidebar owns all outer geometry —
 * column width, drag-resize, split, fullscreen, collapse — so this component
 * only fills its pane with the shared workspace and hands it the api face.
 *
 * Lifetime notes:
 * - The Sidebar draws only the ACTIVE tab's body, so switching to the Files
 *   tab unmounts this component. Nothing here disconnects: connections live
 *   host-side, and the workspace's terminal pool keeps every xterm instance
 *   (scrollback included) alive for the next mount.
 * - Mounting is not pane identity. Splitting a single-pane root swaps the
 *   root's `<TabPanel>` for a split `<div>`, which remounts this body; the host
 *   tab id passed down as `viewId` is what keeps the pane's servers across that
 *   remount, and the tab's abort signal distinguishes a vanished tab record.
 * - The Sidebar keeps the panel mounted while collapsed (translated
 *   off-edge), so a collapse with SSH active keeps the workspace's polls and
 *   streams running — same semantics as the legacy drawer being open.
 * - Resize correctness after drag/fullscreen/remount comes from the
 *   workspace's ResizeObserver-driven fit, which re-fits on the first observe
 *   of every fresh mount.
 */
import * as React from "react";
import { SshPanel } from "./SshPanel.jsx";

const bodyStyles = {
  root: {
    boxSizing: "border-box",
    height: "100%",
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    borderRadius: 8,
    overflow: "hidden",
    border: "1px solid var(--dsh-ssh-ops-border, #262b33)"
  }
};

export function SshSidebarBody({ api, credentials, useTabInfo }) {
  // The seat always injects useTabInfo; the branch keeps the body renderable in
  // a host that registers the tab type without it.
  return useTabInfo === undefined
    ? <div style={bodyStyles.root} data-dsh-ssh-ops-sidebar-body="true"><SshPanel api={api} credentials={credentials} /></div>
    : <SidebarPaneBody api={api} credentials={credentials} useTabInfo={useTabInfo} />;
}

/**
 * One Sidebar pane. The host tab id — not this component instance — identifies
 * the pane: splitting a single-pane root remounts this body, and the id has to
 * survive that so the pane keeps the servers it already showed. The tab's abort
 * signal reports the record disappearing, which is a different event from a
 * remount and is what releases the pane's connection references.
 */
function SidebarPaneBody({ api, credentials, useTabInfo }) {
  const tabInfo = useTabInfo();
  return (
    <div style={bodyStyles.root} data-dsh-ssh-ops-sidebar-body="true">
      <SshPanel
        api={api}
        credentials={credentials}
        viewId={tabInfo.tab.id}
        viewSignal={tabInfo.tab.signal}
      />
    </div>
  );
}
