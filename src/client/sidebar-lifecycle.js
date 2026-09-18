/**
 * Keep the legacy drawer available to old DSH releases, then replace it when
 * a newer host eventually provides both official right-Sidebar services.
 *
 * Services are intentionally awaited through `ctx.inject()` instead of a
 * point-in-time `ctx.get()` lookup: bundles can be evaluated before the host
 * Sidebar finishes registering its service faces.
 */
export function activateSidebarWhenAvailable(ctx, {
  registerLegacy,
  registerSidebar,
  onSidebarError = () => {}
}) {
  let legacyDispose = registerLegacy(ctx);
  let sidebarDispose;

  const unwatch = ctx.inject(["sidebarRightTabs", "sidebarRight"], (sidebarCtx) => {
    // Slot removals are synchronous in the DSH client runtime, and hosts at
    // least as new as 0.1.6-alpha.2 reject a second slot entry with the same
    // id instead of shadowing it. Dispose the drawer BEFORE the Sidebar-mode
    // registrations re-use the session-header action id — registering first
    // throws "already has an entry" and aborts the whole Sidebar path.
    legacyDispose?.();
    legacyDispose = undefined;
    try {
      sidebarDispose = registerSidebar(sidebarCtx);
    } catch (error) {
      onSidebarError(error);
      // Sidebar mode failed partway: restore the legacy drawer so SSH stays
      // reachable instead of silently vanishing.
      legacyDispose = registerLegacy(ctx);
      return undefined;
    }
    return () => {
      sidebarDispose?.();
      sidebarDispose = undefined;
    };
  });

  return () => {
    unwatch?.();
    legacyDispose?.();
    legacyDispose = undefined;
  };
}
