import assert from "node:assert/strict";
import { activateSidebarWhenAvailable } from "../src/client/sidebar-lifecycle.js";

function fakeContext() {
  let callback;
  let watching = true;
  return {
    ctx: {
      inject(deps, receive) {
        assert.deepEqual(deps, ["sidebarRightTabs", "sidebarRight"]);
        callback = receive;
        return () => {
          watching = false;
        };
      }
    },
    provideSidebar(sidebarCtx = { sidebarRightTabs: {}, sidebarRight: {} }) {
      assert.equal(watching, true, "the lifecycle must still be watching for late Sidebar services");
      return callback(sidebarCtx);
    }
  };
}

// New DSH: the plugin starts before Sidebar services exist, keeps the old
// drawer briefly, then replaces it exactly once when the services arrive.
// The drawer is disposed BEFORE the Sidebar-mode registrations run: hosts at
// least as new as 0.1.6-alpha.2 throw on a second slot entry with the same
// id ("already has an entry"), which used to abort the whole Sidebar path.
{
  const events = [];
  const fake = fakeContext();
  const dispose = activateSidebarWhenAvailable(fake.ctx, {
    registerLegacy: () => {
      events.push("legacy-register");
      return () => events.push("legacy-dispose");
    },
    registerSidebar: (ctx) => {
      assert.ok(ctx.sidebarRightTabs && ctx.sidebarRight);
      events.push("sidebar-register");
      return () => events.push("sidebar-dispose");
    }
  });
  assert.deepEqual(events, ["legacy-register"], "old drawer is available until the host Sidebar is ready");
  const disposeSidebar = fake.provideSidebar();
  assert.deepEqual(events, ["legacy-register", "legacy-dispose", "sidebar-register"],
    "Sidebar registration replaces rather than overlaps the legacy drawer");
  disposeSidebar();
  dispose();
  assert.deepEqual(events, ["legacy-register", "legacy-dispose", "sidebar-register", "sidebar-dispose"],
    "teardown is idempotent after Sidebar ownership changes");
}

// Old DSH: no services are provided, so the drawer remains usable until the
// plugin itself is unloaded.
{
  const events = [];
  const fake = fakeContext();
  const dispose = activateSidebarWhenAvailable(fake.ctx, {
    registerLegacy: () => {
      events.push("legacy-register");
      return () => events.push("legacy-dispose");
    },
    registerSidebar: () => assert.fail("old DSH must not register an official Sidebar tab")
  });
  dispose();
  assert.deepEqual(events, ["legacy-register", "legacy-dispose"]);
}

// A registration collision leaves the working legacy drawer in place: it is
// disposed before the Sidebar attempt and restored when the attempt fails.
{
  const events = [];
  const fake = fakeContext();
  const dispose = activateSidebarWhenAvailable(fake.ctx, {
    registerLegacy: () => {
      events.push("legacy-register");
      return () => events.push("legacy-dispose");
    },
    registerSidebar: () => { throw new Error("ssh kind already claimed"); },
    onSidebarError: () => events.push("sidebar-error")
  });
  fake.provideSidebar();
  dispose();
  assert.deepEqual(events,
    ["legacy-register", "legacy-dispose", "sidebar-error", "legacy-register", "legacy-dispose"],
    "a failed Sidebar attempt restores the legacy drawer");
}

console.log("sidebar lifecycle: delayed services, old-host fallback, and conflict fallback passed");
