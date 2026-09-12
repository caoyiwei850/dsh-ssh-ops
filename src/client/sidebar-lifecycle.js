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
    try {
      sidebarDispose = registerSidebar(sidebarCtx);
    } catch (error) {
      onSidebarError(error);
      return undefined;
    }

    // Slot removals are synchronous in the DSH client runtime. Dispose the
    // drawer before registering the same session-header action id in Sidebar
    // mode, so there is never a duplicate button or floating panel.
    legacyDispose?.();
    legacyDispose = undefined;
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
