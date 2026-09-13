/**
 * A saved-server selection may join an already-live transport.  This is only
 * safe for the profile's saved route: a one-off ProxyJump override is a
 * distinct requested route and must receive its own connection.
 */
export function findReusableProfileConnection(connections, profileId, { reuseExisting = false, hasProxyJumpOverride = false } = {}) {
  if (!reuseExisting || hasProxyJumpOverride) return null;
  return connections.find((connection) => (
    connection.profileId === profileId &&
    !connection.closing &&
    !connection.connecting &&
    !connection.dead
  )) ?? null;
}
