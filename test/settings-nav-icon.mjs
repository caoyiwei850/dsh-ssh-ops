import { test } from "node:test";
import assert from "node:assert/strict";
import { registerSettingsNavIcon } from "../src/client/settings-nav-icon.js";

function host() {
  let callback;
  let release;
  let descriptor;
  let component;
  let active = false;
  return {
    slots: {
      inject(name, fn) { assert.equal(name, "settings.section.icon"); callback = fn; return () => { release?.(); release = undefined; }; },
      register(options, view) { descriptor = options; component = view; active = true; return () => { active = false; }; }
    },
    appear() { release = callback(); },
    disappear() { release?.(); release = undefined; },
    get active() { return active; },
    get descriptor() { return descriptor; },
    get component() { return component; }
  };
}

test("fallback is replaced by native slot and restored if slot disappears", () => {
  const owner = host();
  let fallbackActive = 0;
  const icon = () => null;
  const dispose = registerSettingsNavIcon({ slots: owner.slots, component: icon, fallback: () => { fallbackActive++; return () => { fallbackActive--; }; } });
  assert.equal(fallbackActive, 1);
  owner.appear();
  assert.deepEqual(owner.descriptor, { name: "settings.section.icon", id: "ssh-ops-resources" });
  assert.equal(owner.component, icon);
  assert.equal(owner.active, true);
  assert.equal(fallbackActive, 0);
  owner.disappear();
  assert.equal(fallbackActive, 1);
  owner.appear();
  dispose();
  assert.equal(owner.active, false);
  assert.equal(fallbackActive, 0, "teardown must not restore fallback");
});

test("older hosts and registration failures retain the fallback", () => {
  for (const failing of ["inject", "register"]) {
    let fallbackActive = 0;
    let callback;
    const slots = {
      inject(_name, fn) { if (failing === "inject") throw Error("unsupported"); callback = fn; return () => {}; },
      register() { throw Error("unavailable"); }
    };
    const errors = [];
    const dispose = registerSettingsNavIcon({ slots, component: () => null, fallback: () => { fallbackActive++; return () => fallbackActive--; }, onError: (error) => errors.push(error.message) });
    if (callback) callback();
    assert.equal(fallbackActive, 1);
    assert.equal(errors.length, 1);
    dispose();
    assert.equal(fallbackActive, 0);
  }
});
