/**
 * Session log store: one append-only file per SSH session plus a JSON sidecar
 * with its metadata, under a plugin-owned directory. Recording is bounded on
 * purpose — a session stops writing past its cap (and says so) instead of
 * filling the disk, and the store prunes the oldest sessions past the total
 * budget.
 *
 * The store is deliberately transport-free: the service feeds it the same text
 * it hands the terminal journal, so a log is exactly what the panel showed.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Defaults: one session may keep 8 MB, the directory 256 MB. */
export const SESSION_LOG_LIMITS = Object.freeze({
  maxSessionBytes: 8 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  /** Longest prefix of a session that search scans, so one huge log cannot stall the panel. */
  maxSearchBytes: 32 * 1024 * 1024,
  maxSearchHits: 200
});

const META_SUFFIX = ".json";
const LOG_SUFFIX = ".log";

/** Filesystem-safe session id (ids are generated internally, but never trust that here). */
function safeId(sessionId) {
  return String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
}

export class SessionLogStore {
  /**
   * @param options - `{ dir, limits? }`; the directory is created lazily.
   */
  constructor({ dir, limits = {} } = {}) {
    this.dir = dir;
    this.limits = { ...SESSION_LOG_LIMITS, ...limits };
    this.entries = new Map();
    this.streams = new Map();
    /** sessionId -> promise settling when the last append reached the file. */
    this.pending = new Map();
    this.ready = null;
  }

  async init() {
    this.ready ??= mkdir(this.dir, { recursive: true }).catch(() => {});
    await this.ready;
  }

  metaPath(sessionId) { return join(this.dir, `${safeId(sessionId)}${META_SUFFIX}`); }
  logPath(sessionId) { return join(this.dir, `${safeId(sessionId)}${LOG_SUFFIX}`); }

  /** Is this session already being recorded (its entry exists)? */
  has(sessionId) {
    return this.entries.has(sessionId);
  }

  /**
   * Open a log for one session. The entry exists as soon as this returns
   * (before the directory or stream is ready), so an append that arrives in
   * the same tick is buffered rather than dropped — callers that record
   * lazily call begin() and append() back to back.
   */
  async begin({ sessionId, connectionId, name, host, port, openedBy, startedAt = new Date().toISOString() }) {
    const entry = {
      sessionId, connectionId: connectionId ?? null, name: name ?? null,
      host: host ?? null, port: port ?? null, openedBy: openedBy ?? null,
      startedAt, endedAt: null, exitCode: null, bytes: 0, truncated: false,
      /** Chunks that arrived before the write stream existed. */
      pending: []
    };
    this.entries.set(sessionId, entry);
    await this.init();
    const stream = createWriteStream(this.logPath(sessionId), { flags: "a" });
    stream.on("error", () => { /* a broken log must not crash the session */ });
    this.streams.set(sessionId, stream);
    const buffered = entry.pending;
    entry.pending = [];
    for (const chunk of buffered) {
      try { stream.write(chunk); } catch { /* keep the session alive */ }
    }
    await this.writeMeta(entry).catch(() => {});
    return entry;
  }

  /** Append session output; past the per-session cap the rest is dropped, once. */
  append(sessionId, text) {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) return;
    const stream = this.streams.get(sessionId);
    if (entry.truncated) return;
    const chunk = String(text ?? "");
    if (chunk.length === 0) return;
    const remaining = this.limits.maxSessionBytes - entry.bytes;
    if (remaining <= 0) {
      entry.truncated = true;
      return;
    }
    const slice = Buffer.byteLength(chunk, "utf8") > remaining
      ? Buffer.from(chunk, "utf8").subarray(0, remaining).toString("utf8")
      : chunk;
    entry.bytes += Buffer.byteLength(slice, "utf8");
    if (entry.bytes >= this.limits.maxSessionBytes) entry.truncated = true;
    if (stream === undefined) {
      // begin() is still preparing the stream: hold the chunk in order.
      entry.pending.push(slice);
      return;
    }
    try {
      // Reads await this so a live session's newest output is never missed.
      this.pending.set(sessionId, new Promise((resolve) => stream.write(slice, resolve)));
    } catch { /* keep the session alive */ }
  }

  /** Close one session's log and persist its final metadata. */
  async end(sessionId, { exitCode = null } = {}) {
    const entry = this.entries.get(sessionId);
    const stream = this.streams.get(sessionId);
    this.streams.delete(sessionId);
    if (stream !== undefined) {
      await new Promise((resolve) => stream.end(resolve));
    }
    this.pending.delete(sessionId);
    if (entry === undefined) return null;
    entry.endedAt = new Date().toISOString();
    entry.exitCode = exitCode;
    this.entries.delete(sessionId);
    await this.writeMeta(entry).catch(() => {});
    return entry;
  }

  async writeMeta(entry) {
    await writeFile(this.metaPath(entry.sessionId), JSON.stringify(entry), "utf8");
  }

  /** All recorded sessions, newest first (metadata only; the log stays a file). */
  async list() {
    await this.init();
    let names;
    try { names = await readdir(this.dir); } catch { names = []; }
    const byId = new Map();
    for (const name of names) {
      if (!name.endsWith(META_SUFFIX)) continue;
      try {
        const meta = JSON.parse(await readFile(join(this.dir, name), "utf8"));
        if (meta?.sessionId === undefined) continue;
        byId.set(meta.sessionId, {
          ...meta,
          startedAt: meta.startedAt ?? null,
          endedAt: meta.endedAt ?? null,
          bytes: Number(meta.bytes ?? 0),
          truncated: meta.truncated === true
        });
      } catch {
        // A half-written sidecar is skipped rather than breaking the list.
      }
    }
    // A session still recording has no fresh sidecar yet (its metadata is only
    // written at open and close), so the live entry wins and the panel sees
    // accurate byte counts and truncation while the session runs.
    for (const [sessionId, live] of this.entries) {
      const { pending, ...exposed } = live;
      void pending;
      byId.set(sessionId, { ...exposed });
    }
    return [...byId.values()]
      .sort((left, right) => String(right.startedAt ?? "").localeCompare(String(left.startedAt ?? "")));
  }

  /** Wait for the session's most recent append to hit the file. */
  async flush(sessionId) {
    await this.pending.get(sessionId)?.catch(() => {});
  }

  /** Read a byte range of one log; callers page with `nextOffset`. */
  async read(sessionId, { offset = 0, maxBytes = 65536 } = {}) {
    await this.flush(sessionId);
    await this.init();
    const path = this.logPath(sessionId);
    let size;
    try { size = (await stat(path)).size; } catch { return { ok: false, reason: "no-such-log" }; }
    const start = Math.max(0, Math.min(Number(offset) || 0, size));
    const length = Math.max(1, Math.min(Number(maxBytes) || 65536, 4 * 1024 * 1024));
    const chunks = [];
    let read = 0;
    await new Promise((resolve) => {
      const stream = createReadStream(path, { start, end: Math.min(size, start + length) - 1 });
      stream.on("data", (chunk) => { chunks.push(chunk); read += chunk.length; });
      stream.on("error", () => resolve());
      stream.on("end", resolve);
    });
    return {
      ok: true,
      data: Buffer.concat(chunks).toString("utf8"),
      startOffset: start,
      nextOffset: start + read,
      eof: start + read >= size,
      size
    };
  }

  /**
   * Case-insensitive substring search over the first `maxSearchBytes` of a log.
   * Line-oriented: a hit reports the line (bounded) and the byte offset of the
   * line's start, so the panel can jump with read().
   */
  async search(sessionId, { query, maxHits = this.limits.maxSearchHits } = {}) {
    const needle = String(query ?? "").toLowerCase();
    if (needle === "") return { ok: true, hits: [], scannedBytes: 0, stoppedEarly: false };
    await this.flush(sessionId);
    await this.init();
    const path = this.logPath(sessionId);
    let size;
    try { size = (await stat(path)).size; } catch { return { ok: false, reason: "no-such-log" }; }
    const limit = Math.min(size, this.limits.maxSearchBytes);
    const hits = [];
    let scanned = 0;
    let pending = "";
    let pendingOffset = 0;
    let stoppedEarly = false;
    await new Promise((resolve) => {
      const stream = createReadStream(path, { start: 0, end: limit - 1 });
      stream.on("data", (chunk) => {
        scanned += chunk.length;
        pending += chunk.toString("utf8");
        let index;
        while ((index = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, index);
          if (line.toLowerCase().includes(needle)) {
            hits.push({ offset: pendingOffset, line: line.slice(0, 500) });
          }
          pendingOffset += Buffer.byteLength(pending.slice(0, index + 1), "utf8");
          pending = pending.slice(index + 1);
          if (hits.length >= maxHits) { stoppedEarly = true; stream.destroy(); resolve(); return; }
        }
      });
      stream.on("error", () => resolve());
      stream.on("close", resolve);
      stream.on("end", () => {
        if (pending !== "" && pending.toLowerCase().includes(needle)) {
          hits.push({ offset: pendingOffset, line: pending.slice(0, 500) });
        }
        resolve();
      });
    });
    return { ok: true, hits, scannedBytes: scanned, stoppedEarly };
  }

  /** Delete one log (and its sidecar). */
  async remove(sessionId) {
    this.streams.get(sessionId)?.destroy();
    this.streams.delete(sessionId);
    this.entries.delete(sessionId);
    await rm(this.logPath(sessionId), { force: true }).catch(() => {});
    await rm(this.metaPath(sessionId), { force: true }).catch(() => {});
    return { ok: true, deleted: true };
  }

  /** Delete every recorded session. */
  async removeAll() {
    const entries = await this.list();
    for (const entry of entries) await this.remove(entry.sessionId);
    return { ok: true, deleted: entries.length };
  }

  /**
   * Keep the directory under its total budget by dropping the oldest logs —
   * the most recent recording is always kept, even if it alone exceeds it.
   */
  async prune() {
    const entries = await this.list();
    const total = entries.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0);
    let remaining = total;
    const removed = [];
    for (const entry of entries.slice(1)) {
      if (remaining <= this.limits.maxTotalBytes) break;
      remaining -= Number(entry.bytes) || 0;
      await this.remove(entry.sessionId);
      removed.push(entry.sessionId);
    }
    return { ok: true, removed, totalBefore: total, totalAfter: Math.max(0, remaining) };
  }
}
