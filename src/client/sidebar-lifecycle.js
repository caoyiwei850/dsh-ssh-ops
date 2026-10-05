/**
 * Register the official right-Sidebar tab as soon as the host provides both
 * Sidebar services.
 *
 * Services are intentionally awaited through `ctx.inject()` instead of a
 * point-in-time `ctx.get()` lookup: bundles can be evaluated before the host
 * Sidebar finishes registering its service faces. A host without the Sidebar
 * services simply never fires the callback — there is no fallback surface.
 */
export function activateSidebarWhenAvailable(ctx, {
  registerSidebar,
  onSidebarError = () => {}
}) {
  let sidebarDispose;

  const unwatch = ctx.inject(["sidebarRightTabs", "sidebarRight"], (sidebarCtx) => {
    try {
      sidebarDispose = registerSidebar(sidebarCtx);
    } catch (error) {
      onSidebarError(error);
      return undefined;
    }
    return () => {
      sidebarDispose?.();
      sidebarDispose = undefined;
    };
  });

  return () => {
    unwatch?.();
    sidebarDispose?.();
    sidebarDispose = undefined;
  };
}
