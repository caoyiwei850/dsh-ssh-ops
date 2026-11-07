import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const activeOwners = new Set();
function ownerIsActive(record) {
  if (record.status !== "running" || !Number.isSafeInteger(record.ownerPid) || typeof record.ownerToken !== "string") return false;
  if (record.ownerPid === process.pid) return activeOwners.has(record.ownerToken);
  try { process.kill(record.ownerPid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

/** Stable identity only; no credential or SSH secret is persisted. */
export function transferConnectionIdentity(connection) {
  if (typeof connection?.host !== "string" || !connection.host || typeof connection.username !== "string" || !connection.username) return null;
  const hops = connection.proxyJump ?? [];
  if (!Array.isArray(hops) || hops.some((hop) => typeof hop?.host !== "string" || !hop.host || typeof hop.username !== "string" || !hop.username)) return null;
  return JSON.stringify([connection.host.toLowerCase(), connection.port ?? 22, connection.username, connection.profileId ?? null, hops.map((hop) => [hop.host.toLowerCase(), hop.port ?? 22, hop.username])]);
}

/** Durable inventory of resumable partials; completed history stays in memory. */
export class TransferTasks {
  entries = new Map();
  constructor({ journalPath = null } = {}) { this.journalPath = journalPath; this.loading = null; this.writeQueue = Promise.resolve(); this.ownedIds = new Set(); this.removedIds = new Set(); this.ownerToken = randomUUID(); this.closing = false; if (journalPath) activeOwners.add(this.ownerToken); }
  close() { this.closing = true; this.releaseIfIdle(); }
  releaseIfIdle() { if (this.closing && ![...this.entries.values()].some((task) => task.status === "running")) activeOwners.delete(this.ownerToken); }
  async load() {
    if (!this.journalPath) return;
    this.loading ??= (async () => {
      let content;
      try { content = await readFile(this.journalPath, "utf8"); }
      catch (error) { if (error.code === "ENOENT") return; throw error; }
      if (Buffer.byteLength(content) > 4 * 1024 * 1024) throw new Error("Transfer journal is too large; inspect it before starting uploads");
      let records;
      try { records = JSON.parse(content); } catch { throw new Error("Transfer journal is invalid; inspect it before starting uploads"); }
      if (!Array.isArray(records) || records.length > 5000) throw new Error("Transfer journal has an invalid format");
      for (const item of records) {
        if (!item || typeof item.id !== "string" || typeof item.identity !== "string" || typeof item.source !== "string" || typeof item.target !== "string" || typeof item.partial !== "string" || !Number.isSafeInteger(item.checkpoint) || item.checkpoint < 0 || !Number.isSafeInteger(item.total) || item.total < item.checkpoint || typeof item.digest !== "string") throw new Error("Transfer journal contains an invalid entry");
        if (this.entries.has(item.id) || (item.ownerToken !== this.ownerToken && ownerIsActive(item))) continue;
        this.entries.set(item.id, { ...item, connectionId: null, status: "failed", sent: item.checkpoint, error: "Upload was interrupted; resume or remove its partial file", controller: new AbortController() });
      }
    })();
    return this.loading;
  }
  async persist() {
    if (!this.journalPath) return;
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      await mkdir(dirname(this.journalPath), { recursive: true });
      const lock = `${this.journalPath}.lock`;
      let acquired = false;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        try { await writeFile(lock, String(process.pid), { mode: 0o600, flag: "wx" }); acquired = true; break; }
        catch (error) { if (error.code !== "EEXIST") throw error; await new Promise((resolve) => setTimeout(resolve, 50)); }
      }
      if (!acquired) throw new Error(`Transfer journal is locked; check for another DSH process or a stale lock at ${lock}`);
      try {
        let records = [];
        try { records = JSON.parse(await readFile(this.journalPath, "utf8")); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        if (!Array.isArray(records)) throw new Error("Transfer journal has an invalid format");
        const merged = new Map(records.map((record) => [record.id, record]));
        for (const id of [...this.removedIds, ...this.ownedIds]) {
          const existing = merged.get(id);
          if (existing?.ownerToken !== this.ownerToken && ownerIsActive(existing ?? {})) throw new Error("Transfer is active in another DSH process");
        }
        for (const id of this.removedIds) merged.delete(id);
        for (const id of this.ownedIds) {
          const task = this.entries.get(id);
          if (!task || task.status === "done") { merged.delete(id); continue; }
          if (task.identity && task.partial) {
            const { identity, source, target, partial, total, digest, checkpoint } = task;
            merged.set(id, { id, identity, source, target, partial, total, digest, checkpoint, status: task.status, ownerPid: process.pid, ownerToken: this.ownerToken });
          }
        }
        if (merged.size > 5000) throw new Error("Too many unfinished transfers; remove old partial files first");
        const temp = `${this.journalPath}.${randomUUID()}.tmp`;
        try { await writeFile(temp, JSON.stringify([...merged.values()]), { mode: 0o600, flag: "wx" }); await rename(temp, this.journalPath); }
        finally { await rm(temp, { force: true }).catch(() => {}); }
        this.removedIds.clear();
        for (const id of this.ownedIds) {
          const task = this.entries.get(id);
          if (!task || task.status !== "running") this.ownedIds.delete(id);
        }
      } finally { await rm(lock, { force: true }); }
    });
    return this.writeQueue;
  }
  attach(connectionId, connection) {
    const identity = transferConnectionIdentity(connection);
    if (!identity) return;
    for (const task of this.entries.values()) {
      if (task.status !== "running" && task.identity === identity) task.connectionId = connectionId;
    }
  }
  start(values) {
    const task = { ...values, id: randomUUID(), status: "running", sent: 0, error: "", controller: new AbortController() };
    this.entries.set(task.id, task);
    this.ownedIds.add(task.id);
    this.prune();
    return task;
  }
  prune() {
    const completed = [...this.entries.values()].filter((task) => task.status === "done");
    for (const task of completed.slice(0, Math.max(0, completed.length - 50))) this.entries.delete(task.id);
  }
  list(connectionId) {
    return [...this.entries.values()].filter((task) => task.connectionId === connectionId).reverse().map(({ id, connectionId, source, target, status, total, sent, error }) => ({ id, connectionId, source, target, status, total, sent, error }));
  }
  cancel(id, connectionId) {
    const task = this.entries.get(id);
    if (!task || task.connectionId !== connectionId || task.status !== "running") return false;
    task.controller.abort(new Error("Upload cancelled"));
    return true;
  }
}

/** Hash a local or SFTP stream with cancellation and an idle deadline. */
export async function hashTransferStream(stream, signal, idleMs = 30000) {
  const hash = createHash("sha256");
  let timer;
  const abort = () => stream.destroy(signal?.reason instanceof Error ? signal.reason : new Error("Upload cancelled"));
  const tick = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stream.destroy(new Error("Transfer verification stalled")), idleMs);
    timer.unref?.();
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  tick();
  try {
    for await (const chunk of stream) { hash.update(chunk); tick(); }
    return hash.digest("hex");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    stream.destroy();
  }
}
