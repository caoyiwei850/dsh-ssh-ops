/**
 * SFTP favorites: the pinned remote paths shown above a connection's file
 * list, persisted per server in the browser's localStorage. The storage
 * object is injected so the whole module runs in plain Node tests.
 */

/** Stable per-server key: runtime connection ids change every session. */
export function favoritesKey(connection) {
  const host = String(connection?.host ?? "").trim();
  if (host === "") return null;
  const port = Number(connection?.port) || 0;
  const username = String(connection?.username ?? "").trim() || "-";
  return `dsh-ssh-ops:sftp-favorites:${username}@${host}:${port}`;
}

/** Read the pinned paths for one server; corrupt or foreign data reads empty. */
export function readFavorites(storage, key) {
  if (storage === undefined || storage === null || key === null) return [];
  try {
    const raw = storage.getItem(key);
    if (raw === null) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set();
    const paths = [];
    for (const value of parsed) {
      if (typeof value !== "string" || value === "" || seen.has(value)) continue;
      if (!value.startsWith("/")) continue;
      seen.add(value);
      paths.push(value);
    }
    return paths;
  } catch {
    return [];
  }
}

/** Persist the pinned paths; a full/blocked storage must not break the panel. */
export function writeFavorites(storage, key, paths) {
  if (storage === undefined || storage === null || key === null) return;
  try {
    storage.setItem(key, JSON.stringify(paths));
  } catch {
    // Private-mode quota or blocked storage: favorites simply stay for this session.
  }
}

/**
 * Add or remove one path.
 * @returns `{ paths, added }` — the next list and whether the path was pinned.
 */
export function toggleFavorite(paths, path) {
  const clean = String(path ?? "").trim();
  if (clean === "") return { paths, added: false };
  const index = paths.indexOf(clean);
  if (index >= 0) {
    const next = [...paths];
    next.splice(index, 1);
    return { paths: next, added: false };
  }
  return { paths: [...paths, clean], added: true };
}
