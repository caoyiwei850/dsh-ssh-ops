import { createHash, randomUUID } from "node:crypto";

/** In-memory task records; secrets and controllers never cross the RPC boundary. */
export class TransferTasks {
  entries = new Map();
  start(values) {
    const task = { ...values, id: randomUUID(), status: "running", sent: 0, error: "", controller: new AbortController() };
    this.entries.set(task.id, task);
    this.prune();
    return task;
  }
  prune() {
    const finished = [...this.entries.values()].filter((task) => task.status !== "running");
    for (const task of finished.slice(0, Math.max(0, finished.length - 50))) this.entries.delete(task.id);
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
