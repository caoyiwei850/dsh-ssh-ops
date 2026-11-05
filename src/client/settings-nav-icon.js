/** Prefer the host's icon slot, retaining the legacy icon while it is absent. */
export function registerSettingsNavIcon({ slots, component, fallback, onError = () => {} }) {
  let stopped = false;
  let fallbackDispose;
  const startFallback = () => {
    if (stopped || fallbackDispose) return;
    try { fallbackDispose = fallback(); } catch (error) { onError(error); }
  };
  const stopFallback = () => {
    const dispose = fallbackDispose;
    fallbackDispose = undefined;
    try { dispose?.(); } catch (error) { onError(error); }
  };
  startFallback();
  let unwatch;
  try {
    unwatch = slots.inject("settings.section.icon", () => {
      let dispose;
      try {
        dispose = slots.register({ name: "settings.section.icon", id: "ssh-ops-resources" }, component);
      } catch (error) {
        onError(error);
        return undefined;
      }
      stopFallback();
      return () => {
        try { dispose?.(); } finally { startFallback(); }
      };
    });
  } catch (error) {
    onError(error);
  }
  return () => {
    stopped = true;
    try { unwatch?.(); } finally { stopFallback(); }
  };
}
