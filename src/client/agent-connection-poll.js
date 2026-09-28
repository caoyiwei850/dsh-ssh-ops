/** Keep agent-requested connections visible even while the SSH pane is closed. */
export function startAgentConnectionPoll(api, announce, timers = globalThis) {
  let stopped = false;
  let polling = false;
  const timer = timers.setInterval(async () => {
    if (stopped || polling) return;
    polling = true;
    try {
      const listed = await api.list();
      if (!stopped) announce(listed.connections);
    } catch {
      // A temporarily unavailable host must not stop later polls.
    } finally {
      polling = false;
    }
  }, 2500);
  return () => {
    stopped = true;
    timers.clearInterval(timer);
  };
}
