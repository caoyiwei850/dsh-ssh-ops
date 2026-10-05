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
    },
    stillWatching: () => watching
  };
}

// New DSH: the plugin starts before Sidebar services exist, so registration
// is deferred — nothing runs until both services arrive, then the Sidebar
// path runs exactly once.
{
  const events = [];
  const fake = fakeContext();
  const dispose = activateSidebarWhenAvailable(fake.ctx, {
    registerSidebar: (ctx) => {
      assert.ok(ctx.sidebarRightTabs && ctx.sidebarRight);
      events.push("sidebar-register");
      return () => events.push("sidebar-dispose");
    }
  });
  assert.deepEqual(events, [], "nothing registers before the host Sidebar services arrive");
  const disposeSidebar = fake.provideSidebar();
  assert.deepEqual(events, ["sidebar-register"]);
  disposeSidebar();
  assert.deepEqual(events, ["sidebar-register", "sidebar-dispose"],
    "the Sidebar registration's own disposer is honored");
  dispose();
  assert.deepEqual(events, ["sidebar-register", "sidebar-dispose"],
    "teardown is idempotent after Sidebar ownership changes");
}

// A host without the Sidebar services: registration never fires and teardown
// stays safe (there is no fallback surface anymore).
{
  const fake = fakeContext();
  const dispose = activateSidebarWhenAvailable(fake.ctx, {
    registerSidebar: () => assert.fail("no services means no registration")
  });
  dispose();
  assert.equal(fake.stillWatching(), false, "dispose stops watching for services");
}

// A registration failure is reported through onSidebarError and must not
// leave a half-disposed registration behind.
{
  const events = [];
  const fake = fakeContext();
  const dispose = activateSidebarWhenAvailable(fake.ctx, {
    registerSidebar: () => { throw new Error("ssh kind already claimed"); },
    onSidebarError: (error) => events.push(`sidebar-error:${error.message}`)
  });
  fake.provideSidebar();
  dispose();
  assert.deepEqual(events, ["sidebar-error:ssh kind already claimed"],
    "a failed Sidebar attempt is reported, not swallowed");
}

console.log("sidebar lifecycle: delayed services, no-service no-op, and failure reporting passed");
