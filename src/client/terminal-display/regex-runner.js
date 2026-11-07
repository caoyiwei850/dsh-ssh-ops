function browserWorker() {
  // The build embeds the worker bundle so installed plugins need no extra URL
  // route and the worker has no host imports or network dependencies.
  // eslint-disable-next-line no-undef
  const source = typeof __DSH_HIGHLIGHT_WORKER_SOURCE__ === "undefined" ? "" : __DSH_HIGHLIGHT_WORKER_SOURCE__;
  if (!source) throw Error("Highlight worker is unavailable");
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    const worker = new Worker(url);
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => { terminate(); URL.revokeObjectURL(url); };
    return worker;
  } catch (error) { URL.revokeObjectURL(url); throw error; }
}

// One serial worker shared by terminals and the preview. Coalesce queued work
// per owner; a timeout retires the worker and quarantines only that scheme,
// and the quarantine expires so editing a scheme (or simply waiting) recovers
// without a page reload.
export function createRegexRunner({ createWorker = browserWorker, timeoutMs = 150, startupMs = 2500, quarantineMs = 30_000, now = Date.now } = {}) {
  let worker, ready = false, active, timer, nextId = 0, references = 0;
  // A released owner can leave its job running inside the worker. Until that
  // job returns (or is presumed stuck) the shared worker stays warm for the
  // other terminals instead of being restarted, but a watchdog must still
  // recycle it if a catastrophic scheme wedges the thread forever.
  let abandoned;
  const queue = [], blocked = new Map();
  const retire = () => { clearTimeout(timer); const old = worker; worker = undefined; ready = false; old?.terminate(); };
  const clearAbandoned = () => { if (abandoned) { clearTimeout(abandoned.timer); abandoned = undefined; } };
  const isBlocked = (signature) => {
    const expiresAt = blocked.get(signature);
    if (expiresAt === undefined) return false;
    if (expiresAt > now()) return true;
    blocked.delete(signature);
    return false;
  };
  const quarantine = (signature) => {
    if (blocked.size >= 32 && !blocked.has(signature)) blocked.delete(blocked.keys().next().value);
    blocked.set(signature, now() + quarantineMs);
  };
  const settle = (value) => {
    clearTimeout(timer);
    const job = active; active = undefined;
    job?.resolve(value);
    pump();
  };
  /**
   * A worker that never answered is presumed wedged inside `signature`: blame
   * that scheme, restart the worker and re-run the job that was waiting on it
   * (its scheme is innocent — it never got a chance to run).
   */
  const recycle = (signature) => {
    if (signature) quarantine(signature);
    clearAbandoned();
    const requeue = active; active = undefined;
    retire();
    if (requeue) queue.unshift(requeue);
    pump();
  };
  const fail = (error) => {
    clearAbandoned();
    retire();
    if (active) settle({ error });
    else { queue.shift()?.resolve({ error }); pump(); }
  };
  const pump = () => {
    if (active || !queue.length) return;
    if (!worker) {
      try {
        const created = createWorker(); worker = created;
        worker.onmessage = ({ data }) => {
          if (worker !== created) return;
          if (data.ready) { clearTimeout(timer); ready = true; pump(); return; }
          // A late reply from a released owner's job cancels its watchdog: the
          // worker is alive and no longer stuck.
          if (abandoned && data.id === abandoned.id) clearAbandoned();
          if (active && data.id === active.id) settle(data);
        };
        worker.onerror = () => { if (worker === created) fail("worker-unavailable"); };
        timer = setTimeout(() => fail("worker-unavailable"), startupMs);
      } catch { const job = queue.shift(); job.resolve({ error: "worker-unavailable" }); pump(); }
      return;
    }
    if (!ready) return;
    active = queue.shift();
    if (isBlocked(active.signature)) { settle({ error: "regex-timeout" }); return; }
    const signature = active.signature;
    timer = setTimeout(() => {
      if (abandoned) { recycle(abandoned.signature); return; }
      quarantine(signature);
      fail("regex-timeout");
    }, timeoutMs);
    try { worker.postMessage({ id: active.id, entries: active.entries, texts: active.texts }); }
    catch { fail("worker-unavailable"); }
  };
  return {
    acquire() {
      references++;
      const owner = {}, owned = new Set();
      let released = false;
      return {
        match(entries, texts) {
          if (released) return Promise.resolve({ cancelled: true });
          const signature = JSON.stringify(entries);
          if (isBlocked(signature)) return Promise.resolve({ error: "regex-timeout" });
          for (let i = queue.length - 1; i >= 0; i--) {
            if (queue[i].owner === owner) { queue[i].resolve({ cancelled: true }); queue.splice(i, 1); }
          }
          return new Promise((resolve) => {
            const done = (value) => { owned.delete(done); resolve(value); };
            owned.add(done);
            queue.push({ id: ++nextId, owner, signature, entries, texts, resolve: done }); pump();
          });
        },
        clearQuarantine() { blocked.clear(); },
        release() {
          if (released) return;
          released = true;
          for (let i = queue.length - 1; i >= 0; i--) if (queue[i].owner === owner) queue.splice(i, 1);
          for (const resolve of [...owned]) resolve({ cancelled: true });
          // Do not retire the process-wide worker just because this owner is
          // going away: other terminals (and the settings preview) still use
          // it, and a restart would stall their next scan. The in-flight job is
          // abandoned; its late reply is ignored. The watchdog below recycles
          // the worker if the abandoned scheme turns out to be stuck.
          if (active?.owner === owner) {
            const job = active;
            active = undefined;
            clearTimeout(timer);
            const watch = { id: job.id, signature: job.signature };
            watch.timer = setTimeout(() => {
              if (abandoned !== watch) return;
              abandoned = undefined;
              recycle(watch.signature);
            }, timeoutMs);
            watch.timer?.unref?.();
            abandoned = watch;
          }
          if (--references === 0) { clearAbandoned(); retire(); blocked.clear(); }
          else pump();
        }
      };
    }
  };
}
const runner = createRegexRunner();
export const acquireRegexMatcher = () => runner.acquire();
