import assert from "node:assert/strict";
import { availableCommandSnippets, defaultCommandSnippets, matchingCommandSnippets, searchCommandSnippets, STARTER_COMMAND_SNIPPETS } from "../src/client/command-snippets.js";

const connection = { host: "ops.example", port: 22, username: "deploy" };
const profiles = [{ profileId: "profile-a", groupId: "group-a", ...connection }];
const items = [
  { id: "global", name: "global", command: "uptime", scope: "global", scopeId: null },
  { id: "group", name: "group", command: "systemctl status app", scope: "group", scopeId: "group-a" },
  { id: "profile", name: "profile", command: "tail -n 50 /var/log/app.log", scope: "profile", scopeId: "profile-a" },
  { id: "other", name: "other", command: "id", scope: "profile", scopeId: "profile-b" }
];

assert.deepEqual(matchingCommandSnippets(items, connection, profiles).map((item) => item.id), ["global", "group", "profile"]);
assert.deepEqual(matchingCommandSnippets(items, { ...connection, username: "root" }, profiles).map((item) => item.id), ["global"]);
assert.deepEqual(searchCommandSnippets(items, "SYSTEMCTL").map((item) => item.id), ["group"]);
assert.ok(defaultCommandSnippets().length >= 30, "built-ins should be available without a settings-page action");
assert.ok(searchCommandSnippets(defaultCommandSnippets(), "docker").length >= 2, "built-ins must be searchable by name");
assert.equal(availableCommandSnippets([{ id: "duplicate", name: "查看系统负载", command: "uptime", scope: "global", scopeId: null }]).filter((item) => item.name === "查看系统负载").length, 1, "persisted legacy templates must not duplicate built-ins");
assert.ok(STARTER_COMMAND_SNIPPETS.some(([name, command]) => name.includes("Ubuntu") && command === "sudo apt-get update"));
assert.ok(STARTER_COMMAND_SNIPPETS.some(([name, command]) => name.includes("RHEL") && command === "sudo dnf upgrade"));
assert.ok(STARTER_COMMAND_SNIPPETS.some(([name, command]) => name.includes("重启（会变更）") && command.includes("systemctl restart")));
assert.ok(STARTER_COMMAND_SNIPPETS.some(([name, command]) => name.includes("健康检查") && command.includes("/health")));

console.log("command snippets: scope filtering passed");
