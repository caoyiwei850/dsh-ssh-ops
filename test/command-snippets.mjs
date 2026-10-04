import assert from "node:assert/strict";
import { availableCommandSnippets, defaultCommandSnippets, matchingCommandSnippets, searchCommandSnippets, STARTER_COMMAND_SNIPPETS } from "../src/client/command-snippets.js";
import { setLanguage, t } from "../src/i18n/core.js";

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
// A stored duplicate is recognised by its command, not by its label: the label
// follows the active language, so matching on it would stop working after a
// switch and the built-in would appear twice.
assert.equal(availableCommandSnippets([{ id: "duplicate", name: "uptime check", command: "uptime", scope: "global", scopeId: null }]).filter((item) => item.command === "uptime").length, 1, "persisted legacy templates must not duplicate built-ins");
assert.ok(STARTER_COMMAND_SNIPPETS.some(([name, command]) => name.includes("Ubuntu") && command === "sudo apt-get update"));
assert.ok(STARTER_COMMAND_SNIPPETS.some(([name, command]) => name.includes("RHEL") && command === "sudo dnf upgrade"));
assert.ok(STARTER_COMMAND_SNIPPETS.some(([name, command]) => name.includes("restart") && command.includes("systemctl restart")));
assert.ok(STARTER_COMMAND_SNIPPETS.some(([name, command]) => name.includes("health") && command.includes("/health")));

// Built-in names are the bilingual surface of the command library: the
// definition stays English and the labels follow the selected language.
{
  setLanguage("en");
  const english = defaultCommandSnippets();
  assert.equal(english.find((item) => item.command === "uptime").name, "System load");

  setLanguage("zh");
  const chinese = defaultCommandSnippets();
  const uptime = chinese.find((item) => item.command === "uptime");
  assert.notEqual(uptime.name, "System load", "the label is translated");
  assert.equal(uptime.name, t("System load"), "the label comes from the shared dictionary");
  assert.equal(uptime.command, "uptime", "the command itself is never translated");

  // The library must render in the new language without a reload, and the
  // built-ins must still deduplicate against stored entries afterwards.
  assert.equal(availableCommandSnippets([{ id: "dup", name: uptime.name, command: "uptime", scope: "global", scopeId: null }]).filter((item) => item.command === "uptime").length, 1, "dedup survives a language switch");
  setLanguage("en");
}

console.log("command snippets: scope filtering and bilingual labels passed");
