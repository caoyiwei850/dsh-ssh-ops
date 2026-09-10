// Terminal keep-alive pool: reuse across mounts, ownership hand-off for the
// same session in two live panes, LRU eviction of unowned entries, and drop
// on host session death. The pool is DOM-free; terminals are stubs.
import assert from "node:assert/strict";
import { createTerminalPool } from "../src/client/terminal-pool.js";

function makeFactory(log) {
  let n = 0;
  return () => {
    const id = ++n;
    log.push(`create#${id}`);
    return {
      term: {
        id,
        rows: 24,
        disposed: false,
        dispose() { this.disposed = true; log.push(`dispose#${id}`); }
      },
      fit: { id }
    };
  };
}

// ── acquire creates once, remount reuses the same terminal ──
{
  const log = [];
  const pool = createTerminalPool({ create: makeFactory(log), max: 8 });
  const ownerA = {};
  const first = pool.acquire("s1", ownerA);
  assert.equal(first.reused, false, "first mount creates");

  // Unmount: release only — the terminal must survive for the next mount.
  pool.release("s1", ownerA);
  assert.equal(first.term.disposed, false, "release never disposes a pooled terminal");

  const ownerB = {};
  const second = pool.acquire("s1", ownerB);
  assert.equal(second.reused, true, "remount reuses the pooled terminal");
  assert.equal(second.term, first.term, "same instance: scrollback survives the unmount");
  pool.release("s1", ownerB);
  assert.equal(pool.size(), 1);
  pool.disposeAll();
  assert.equal(first.term.disposed, true);
}

// ── the same session in two live panes: second mount gets its own terminal ──
{
  const log = [];
  const pool = createTerminalPool({ create: makeFactory(log), max: 8 });
  const ownerA = {};
  const ownerB = {};
  const a = pool.acquire("s1", ownerA);
  const b = pool.acquire("s1", ownerB);
  assert.equal(b.reused, false, "a live owner is never stolen");
  assert.notEqual(b.term, a.term, "split-view second mount runs its own instance");

  // Releasing the non-owner first changes nothing for the owner.
  pool.release("s1", ownerB);
  assert.equal(b.term.disposed, true, "the unpooled instance dies with its mount");
  assert.equal(a.term.disposed, false, "the pooled owner is untouched");
  pool.release("s1", ownerA);
  assert.equal(a.term.disposed, false);
  pool.disposeAll();
}

// ── LRU eviction only removes unowned entries beyond max ──
{
  const log = [];
  const pool = createTerminalPool({ create: makeFactory(log), max: 2 });
  const keeper = {};
  const o1 = {};
  const o2 = {};
  const o3 = {};
  const owned = pool.acquire("s-kept", keeper).term;
  pool.acquire("s-1", o1).term;
  pool.release("s-1", o1);
  pool.acquire("s-2", o2).term;
  pool.release("s-2", o2);
  pool.acquire("s-3", o3).term;
  pool.release("s-3", o3);
  // s-1 is the oldest unowned entry and was evicted when s-2 arrived; the
  // owned entry survives regardless of age.
  assert.equal(pool.get("s-1"), undefined, "oldest unowned entry evicted");
  assert.equal(pool.get("s-kept")?.term, owned, "owned entry never evicted under a live mount");
  pool.disposeAll();
}

// ── drop forgets a dead session immediately (no-session from the host) ──
{
  const pool = createTerminalPool({ create: makeFactory([]), max: 8 });
  const entry = pool.acquire("s1", {});
  pool.drop("s1");
  assert.equal(entry.term.disposed, true, "drop disposes even though released by no one");
  assert.equal(pool.get("s1"), undefined);
  assert.equal(pool.size(), 0);
  // Double drop and release-after-drop are both no-ops.
  pool.drop("s1");
  pool.release("s1", {});
}

// ── closed flag lives with the session, not the mount ──
{
  const pool = createTerminalPool({ create: makeFactory([]), max: 8 });
  const owner = {};
  pool.acquire("s1", owner);
  pool.setClosed("s1", true);
  assert.equal(pool.get("s1").closed, true);
  pool.release("s1", owner);
  assert.equal(pool.get("s1").closed, true, "closed state survives the unmount");
  pool.disposeAll();
}

// Cursor replay dedup never removes identical output at a new position.
{
  const pool = createTerminalPool({ create: makeFactory([]), max: 8 });
  const owner = {};
  const first = pool.acquire("s1", owner);
  assert.equal(first.consume("tick\r\n", 0, 6), "tick\r\n");
  pool.release("s1", owner);
  const second = pool.acquire("s1", {});
  assert.equal(second.offset, 6);
  assert.equal(second.consume("tick\r\n", 6, 12), "tick\r\n", "identical NEW output survives");
  assert.equal(second.consume("tick\r\n", 6, 12), "", "same sequence is not replayed");
  assert.equal(second.consume("tick\r\n", undefined, undefined), "tick\r\n", "old hosts are not guessed from content");
  assert.equal(second.consume("oldnew", 9, 15), "new", "partial overlap uses offsets");
  pool.disposeAll();
}
console.log("terminal pool: ownership, keepalive, eviction, offset replay: passed");
