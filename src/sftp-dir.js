/**
 * Directory transfer scheduling for dsh-ssh-ops SFTP batch upload/download.
 *
 * The unit of work is a `{ path, size, run }` task descriptor; this module
 * owns nothing but the scheduling policy:
 *
 *  - small files (<= SFTP_DIR_BIG_FILE_BYTES) run in a bounded worker pool
 *    (SFTP_DIR_SMALL_CONCURRENCY) — directory trees of tiny files are latency-
 *    bound, so parallelism dominates;
 *  - big files run one at a time — each gets the full link budget instead of
 *    six partial streams fighting for it;
 *  - counters advance monotonically (single-threaded JS is the atomicity
 *    boundary), so a caller rendering progress can never observe a torn value;
 *  - per-file failures are collected, never fatal — a batch reports what
 *    transferred and what did not.
 *
 * Pure with respect to I/O: `run` does the actual transfer, everything here
 * is unit-testable with fake tasks.
 */

/** Max in-flight small-file transfers. */
export const SFTP_DIR_SMALL_CONCURRENCY = 6;
/** Files larger than this take the exclusive lane. */
export const SFTP_DIR_BIG_FILE_BYTES = 512 * 1024;

/**
 * Run transfer tasks under the scheduling policy. Returns
 * `{ files, bytes, failures }` where `failures` is `[{ path, error }]`.
 */
export async function runTransferTasks(tasks, {
  smallConcurrency = SFTP_DIR_SMALL_CONCURRENCY,
  bigFileBytes = SFTP_DIR_BIG_FILE_BYTES
} = {}) {
  const small = [];
  const big = [];
  let files = 0;
  let bytes = 0;
  const failures = [];
  const runOne = async (task) => {
    try {
      await task.run();
      files += 1;
      bytes += task.size;
    } catch (error) {
      failures.push({ path: task.path, error: error?.message ?? String(error) });
    }
  };

  for (const task of tasks) {
    if (task.size > bigFileBytes) big.push(task);
    else small.push(task);
  }

  // Exclusive lane for big files: strictly one in flight.
  const bigLane = (async () => {
    for (const task of big) await runOne(task);
  })();

  // Bounded pool for small files.
  const smallLane = (async () => {
    let index = 0;
    const workerCount = Math.max(1, Math.min(smallConcurrency, small.length));
    const workers = Array.from({ length: workerCount }, async () => {
      for (;;) {
        const current = index;
        index += 1;
        if (current >= small.length) return;
        await runOne(small[current]);
      }
    });
    await Promise.all(workers);
  })();

  await Promise.all([bigLane, smallLane]);
  return { files, bytes, failures };
}

/** Posix path join for remote SFTP paths (no Windows semantics). */
export function joinRemotePath(base, name) {
  if (base === "/" || base === "") return `/${name}`;
  return `${base.replace(/\/+$/, "")}/${name}`;
}

/** Parent directory and final segment of a posix path. */
export function splitRemotePath(path) {
  const normalized = path.replace(/\/+$/, "") || "/";
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return { parent: "/", name: normalized.slice(index + 1) };
  return { parent: normalized.slice(0, index), name: normalized.slice(index + 1) };
}
