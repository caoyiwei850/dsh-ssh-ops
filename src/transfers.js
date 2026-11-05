/**
 * In-memory registry of transfers that are not driven by the file panel.
 *
 * The panel can already show progress and offer a cancel button for its own
 * uploads and downloads, because it owns those AbortControllers. An upload the
 * agent starts through `sftp_upload_file` has no panel-side object to attach
 * to, so it registers here instead: the uploader reports bytes as they are
 * acknowledged, and the panel's task list reads the same entries and can abort
 * them the same way it aborts its own.
 *
 * Nothing here survives a host restart, and finished entries age out — this is
 * a view of live work, not a transfer history.
 */

/** How many finished entries to keep around for the panel to show. */
const MAX_FINISHED = 12;

/** Finished entries older than this are dropped on the next read. */
const FINISHED_TTL_MS = 5 * 60 * 1000;

const entries = new Map();
let sequence = 0;

function prune(now = Date.now()) {
  const finished = [...entries.values()]
    .filter((entry) => entry.status !== "running")
    .sort((left, right) => right.endedAt - left.endedAt);
  for (const entry of finished.slice(MAX_FINISHED)) entries.delete(entry.id);
  for (const entry of finished) {
    if (now - entry.endedAt > FINISHED_TTL_MS) entries.delete(entry.id);
  }
}

/**
 * Register a transfer and get back the handle its driver updates.
 *
 * `cancel` is called when the panel asks to stop it; the driver decides what
 * that means (an AbortController that the pipeline is already listening to).
 */
export function startTransfer({
  kind = "upload",
  name,
  target = null,
  connection = null,
  total = null,
  cancel = null
}) {
  const id = `t${++sequence}`;
  const entry = {
    id,
    seq: sequence,
    kind,
    name,
    target,
    connection,
    total: Number.isFinite(total) ? total : null,
    sent: 0,
    status: "running",
    error: null,
    cancellable: typeof cancel === "function",
    cancelPending: false,
    cancel,
    startedAt: Date.now(),
    endedAt: 0
  };
  entries.set(id, entry);
  prune();
  return {
    id,
    setTotal(value) {
      entry.total = Number.isFinite(value) ? value : null;
    },
    /** Bytes acknowledged so far; never runs backwards, never past the total. */
    progress(sent) {
      if (entry.status !== "running") return;
      const value = Number(sent);
      if (!Number.isFinite(value)) return;
      const ceiling = entry.total ?? Number.POSITIVE_INFINITY;
      entry.sent = Math.max(entry.sent, Math.min(value, ceiling));
    },
    /** done | cancelled | failed — anything else leaves the entry running. */
    finish(status = "done", error = null) {
      if (entry.status !== "running") return;
      entry.status = status;
      entry.error = error ? String(error.message ?? error).slice(0, 200) : null;
      entry.cancellable = false;
      entry.cancelPending = false;
      entry.endedAt = Date.now();
      if (status === "done" && entry.total !== null) entry.sent = entry.total;
      entry.cancel = null;
    }
  };
}

/** Snapshot for the panel: running work first, then the most recent finishes. */
export function listTransfers() {
  prune();
  return [...entries.values()]
    // Newest first. startedAt alone is not enough: transfers started inside the
    // same millisecond would come back in insertion order and the panel would
    // reorder its own list under the operator's cursor.
    .sort((left, right) => right.seq - left.seq)
    .map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      target: entry.target,
      connection: entry.connection,
      total: entry.total,
      sent: entry.sent,
      status: entry.status,
      error: entry.error,
      cancellable: entry.cancellable,
      cancelPending: entry.cancelPending,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt
    }));
}

/**
 * Abort one running transfer. Returns false when the id is unknown or the
 * transfer already finished, so a stale panel click is harmless.
 */
export function cancelTransfer(id) {
  const entry = entries.get(id);
  if (!entry || entry.status !== "running" || typeof entry.cancel !== "function") return false;
  entry.cancelPending = true;
  try {
    entry.cancel();
  } catch {
    entry.cancelPending = false;
    return false;
  }
  return true;
}

/** Test hook: drop everything without touching live transports. */
export function resetTransfers() {
  entries.clear();
  sequence = 0;
}
