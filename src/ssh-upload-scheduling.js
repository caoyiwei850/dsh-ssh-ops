import { setTimeout } from "node:timers/promises";

export const INTERACTIVE_UPLOAD_CHUNK_BYTES = 32 * 1024;
const INPUT_QUIET_MS = 75;
const MAX_YIELD_MS = 250;
const writes = new WeakMap();
const lastInput = new WeakMap();

export function noteTerminalInput(connection) {
  if (connection) lastInput.set(connection, performance.now());
}

export function hasInteractiveTerminal(connection) {
  return (connection?.sessions?.size ?? 0) > 0;
}

/** Keep one upload write in flight per interactive transport across all transfers. */
export async function scheduleUploadWrite(connection, signal, write) {
  signal?.throwIfAborted();
  if (!hasInteractiveTerminal(connection)) return write();
  const previous = writes.get(connection);
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  writes.set(connection, current);
  try {
    await previous;
    const deadline = performance.now() + MAX_YIELD_MS;
    for (;;) {
      signal?.throwIfAborted();
      const now = performance.now();
      const wait = Math.min(deadline - now, (lastInput.get(connection) ?? -Infinity) + INPUT_QUIET_MS - now);
      if (wait < 1) break;
      await setTimeout(Math.ceil(wait), undefined, { signal });
    }
    return await write();
  } finally {
    release();
    if (writes.get(connection) === current) writes.delete(connection);
  }
}
