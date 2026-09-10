/**
 * Keep-alive registry for xterm Terminal instances, keyed by host SSH session
 * id. The right-Sidebar draws only the ACTIVE tab's body, so switching to the
 * Files tab (or closing the SSH tab) unmounts every XtermView; without this
 * pool each unmount destroyed the scrollback, and "reopen restores the
 * terminal" was only true for output the host had buffered since.
 *
 * The pool is pure bookkeeping over factory-created terminals so it runs in
 * Node tests without DOM: `create` returns { term, fit } and the pool never
 * touches the DOM itself — mounting/remounting (`term.element` re-parenting)
 * stays in XtermView.
 *
 * Rules:
 * - One pooled entry per session id; `acquire` marks the caller as owner.
 * - If the entry is owned by another LIVE mount (split view / two panes), the
 *   caller gets a fresh unpooled terminal instead of stealing the element;
 *   releasing an unpooled terminal disposes it.
 * - Releasing only clears ownership: scrollback survives tab switches, sidebar
 *   collapse, chat switches, and closing the SSH tab.
 * - Unowned entries beyond `max` are evicted least-recently-used and disposed;
 *   owned entries are never evicted under a live mount.
 * - `drop` disposes immediately (host session is gone: `no-session`).
 *
 * Each terminal keeps its last displayed stream offset. Identical new output
 * is retained; only explicitly overlapping offsets are skipped.
 */

/**
 * @param {object} options
 * @param {() => { term: object, fit: object }} options.create builds one terminal + fit addon pair
 * @param {number} [options.max] pooled entries kept before LRU eviction (default 8)
 * @returns {{
 *   acquire: (sessionId: string, owner: object) => {
 *     term: object, fit: object, reused: boolean, pooled: boolean,
 *     offset: number | undefined,
 *     consume: (text: string, startOffset?: number, offset?: number) => string
 *   },
 *   release: (sessionId: string, owner: object) => void,
 *   drop: (sessionId: string) => void,
 *   get: (sessionId: string) => { term: object, fit: object, closed: boolean } | undefined,
 *   setClosed: (sessionId: string, closed: boolean) => void,
 *   size: () => number,
 *   disposeAll: () => void
 * }}
 */
export function createTerminalPool({ create, max = 8 }) {
  /** sessionId → { term, fit, closed, owner, pooled } in LRU order (Map insertion order). */
  const entries = new Map();
  /** owner → unpooled entry. One mount's private terminal when the pooled one is live-owned elsewhere. */
  const leases = new Map();

  function evictOverflow() {
    for (const [sessionId, entry] of entries) {
      if (entries.size <= max) break;
      if (entry.owner !== null) continue;
      entry.term.dispose();
      entries.delete(sessionId);
    }
  }

  function makeEntry() {
    const built = create();
    return {
      term: built.term,
      fit: built.fit,
      closed: false,
      owner: null,
      pooled: true,
      offset: undefined
    };
  }

  /** The face a mount uses: terminal plus the per-session write accounting. */
  function face(entry, reused) {
    return {
      term: entry.term,
      fit: entry.fit,
      reused,
      pooled: entry.pooled,
      get offset() { return entry.offset; },
      consume(text, startOffset, offset) {
        // Older hosts do not publish offsets: preserve their bytes verbatim.
        if (!Number.isSafeInteger(startOffset) || !Number.isSafeInteger(offset)) return text;
        const overlap = Math.max(0, (entry.offset ?? startOffset) - startOffset);
        entry.offset = Math.max(entry.offset ?? 0, offset);
        return text.slice(overlap);
      }
    };
  }

  return {
    /** Bind one mount to a terminal for `sessionId`; `owner` must be a unique mount token. */
    acquire(sessionId, owner) {
      const existing = entries.get(sessionId);
      if (existing === undefined) {
        const entry = makeEntry();
        entry.owner = owner;
        entries.set(sessionId, entry);
        evictOverflow();
        return face(entry, false);
      }
      if (existing.owner === null || existing.owner === owner) {
        // Refresh recency so re-mounts keep their warm entry.
        entries.delete(sessionId);
        entries.set(sessionId, existing);
        existing.owner = owner;
        return face(existing, true);
      }
      // The entry belongs to another live mount: never steal its element.
      // This mount runs on an unpooled terminal that dies with it.
      const lease = makeEntry();
      lease.pooled = false;
      leases.set(owner, lease);
      return face(lease, false);
    },

    /** Detach one mount. A pooled entry keeps its scrollback; an unpooled one is disposed. */
    release(sessionId, owner) {
      const lease = leases.get(owner);
      if (lease !== undefined) {
        lease.term.dispose();
        leases.delete(owner);
        return;
      }
      const entry = entries.get(sessionId);
      if (entry === undefined || entry.owner !== owner) return;
      entry.owner = null;
      evictOverflow();
    },

    /** Forget a session entirely (host session gone): dispose and drop. Any
     * unpooled lease dies with its own mount. */
    drop(sessionId) {
      const entry = entries.get(sessionId);
      if (entry !== undefined) {
        entry.term.dispose();
        entries.delete(sessionId);
      }
    },

    get(sessionId) {
      const entry = entries.get(sessionId);
      return entry === undefined ? undefined : { term: entry.term, fit: entry.fit, closed: entry.closed };
    },

    /** The exited/closed flag lives with the session, not the mount. */
    setClosed(sessionId, closed) {
      const entry = entries.get(sessionId);
      if (entry !== undefined) entry.closed = closed;
    },

    size() {
      return entries.size;
    },

    /** Test/plugin-teardown helper: dispose every pooled terminal. */
    disposeAll() {
      for (const entry of entries.values()) entry.term.dispose();
      entries.clear();
      for (const lease of leases.values()) lease.term.dispose();
      leases.clear();
    }
  };
}
