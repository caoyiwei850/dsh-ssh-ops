import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";

// Exercise the real component and RPC boundary with a host that cannot show prompt().
test("saved database editor opens and updates without reconnecting or replacing a blank password", async () => {
  const dir = mkdtempSync(join(process.cwd(), "node_modules", ".db-edit-test-"));
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.prompt = () => null;
  let root;
  try {
    const output = join(dir, "component.cjs");
    await build({ entryPoints: ["src/client/SshDatabase.jsx"], outfile: output, bundle: true, platform: "node", format: "cjs", external: ["react"], logLevel: "silent" });
    const { SshDatabase } = createRequire(import.meta.url)(output);
    const { createRoot } = await import("react-dom/client");
    const profile = { dbProfileId: "11111111-1111-4111-8111-111111111111", name: "example", type: "postgresql", host: "db.example", port: 5432, database: "mydb", username: "user", ssl: "preferred", sshProfileId: null, queryTimeoutMs: 60000, connected: false };
    let saved;
    let connects = 0;
    const api = {
      dbListConnections: async () => ({ connections: [] }),
      dbProfileList: async () => ({ profiles: [profile] }),
      profileList: async () => ({ profiles: [] }),
      dbProfileSave: async (payload) => { saved = payload; return { profile }; },
      dbProfileConnect: async () => { connects++; return {}; }
    };
    await act(async () => { root = createRoot(document.getElementById("root")); root.render(React.createElement(SshDatabase, { api })); });
    const edit = [...document.querySelectorAll("button")].find((button) => button.textContent === "✎");
    assert.ok(edit);
    await act(async () => edit.click());
    assert.match(document.querySelector("form")?.textContent ?? "", /编辑数据库连接/);
    const host = document.querySelector('input[placeholder="数据库地址"]');
    assert.equal(host.value, "db.example");
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(host, "new.example");
      host.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    const form = document.querySelector("form");
    await act(async () => form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
    assert.equal(saved.dbProfileId, profile.dbProfileId);
    assert.equal(saved.host, "new.example");
    assert.equal(saved.queryTimeoutMs, profile.queryTimeoutMs);
    assert.equal(saved.password, undefined);
    assert.equal(connects, 0);
    assert.equal(document.querySelector("form"), null);
  } finally {
    if (root) await act(async () => root.unmount());
    dom.window.close();
    rmSync(dir, { recursive: true, force: true });
    delete globalThis.window; delete globalThis.document; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
    else delete globalThis.navigator;
  }
});
