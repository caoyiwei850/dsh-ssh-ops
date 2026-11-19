import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";

const source = await readFile(new URL("../src/client/SshResources.jsx", import.meta.url), "utf8");

assert.doesNotMatch(source, /指纹校验：\{HOST_KEY_MODE_LABELS/, "the resource card omits the long host-key mode summary");
assert.doesNotMatch(source, /credentialConfigured \? "凭据已保存"/, "the resource card omits authentication and credential-status summaries");
assert.match(source, /cardActions: \{ display: "flex", flexWrap: "nowrap", flexShrink: 0/, "card actions remain a single non-shrinking row");

assert.match(source, /className="dsh-ssh-ops-segmented"[^>]*role="tablist"/, "the setup switcher is a segmented control");
assert.match(source, /aria-selected=\{setupTab === "credentials"\}/, "segment selection derives from setupTab, never hard-coded");
assert.match(source, /className="dsh-ssh-ops-segmented-thumb"/, "the selected pill rides a sliding thumb, not a per-segment background");
assert.match(source, /segmented: \{ position: "relative"[\s\S]{0,200}background: "rgba\(127,127,127,/, "the switcher track stays a neutral grey — a layer token resolves to white on the settings surface");
assert.doesNotMatch(source, /styles\.setupGrid/, "the old side-by-side setup grid must not come back");

const temp = mkdtempSync(join(process.cwd(), "node_modules", ".ssh-resource-layout-"));
const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
globalThis.window = dom.window;
globalThis.document = window.document;
Object.defineProperty(globalThis, "navigator", { configurable: true, value: window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root;
try {
  const bundle = join(temp, "resources.cjs");
  await build({ entryPoints: ["src/client/SshResources.jsx"], outfile: bundle, bundle: true, platform: "node", format: "cjs", external: ["react"], logLevel: "silent" });
  const { SshResources } = createRequire(import.meta.url)(bundle);
  const { createRoot } = await import("react-dom/client");
  const api = {
    profileList: async () => ({ profiles: [{ profileId: "demo", name: "Test server", groupId: "demo", host: "server.example", port: 22, username: "ops" }] }),
    groupList: async () => ({ groups: [{ groupId: "demo", name: "Test group", profileCount: 1 }] }),
    listKnownHosts: async () => ({ hosts: [{ host: "temporary.example", port: 22, firstSeenAt: 0 }] }),
    credentialList: async () => ({ credentials: [{ credentialId: "cred", name: "Test credential", authKind: "key" }] }),
    agentSettingsGet: async () => ({ features: {}, agentAutoConnect: false })
  };
  await act(async () => {
    root = createRoot(document.getElementById("root"));
    root.render(React.createElement(SshResources, { api }));
  });
  const text = () => document.body.textContent;
  const button = (name) => [...document.querySelectorAll("button")].find((item) => item.textContent === name);
  assert.ok(document.querySelector('input[type="search"]'));
  assert.ok(button("新增服务器"));
  assert.match(text(), /Test group|temporary\.example/);
  for (const [tab, visible] of [["共享 SSH 凭据", "Test credential"], ["AI 命令执行策略", "AI 自动连接"], ["功能开关", "会话日志工具"]]) {
    await act(async () => button(tab).click());
    assert.ok(text().includes(visible));
    assert.equal(document.querySelector('input[type="search"]'), null);
    assert.equal(button("新增服务器"), undefined);
    assert.doesNotMatch(text(), /Test group|temporary\.example/);
  }
  await act(async () => button("服务器分组").click());
  assert.ok(document.querySelector('input[type="search"]'));
  assert.ok(button("新增服务器"));
  assert.match(text(), /Test group/);
  assert.match(text(), /temporary\.example/);
} finally {
  if (root) await act(async () => root.unmount());
  dom.window.close();
  rmSync(temp, { recursive: true, force: true });
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
  else delete globalThis.navigator;
}

console.log("resource settings: server list, search, and actions belong to the groups tab");
