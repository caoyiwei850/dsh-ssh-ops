import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const manifest = read(".agent-presets/ops/preset.yml");
const config = read(".agent-presets/ops/agent.cordis.yml");
const skill = read(".agent-presets/ops/skills/test-op/SKILL.md");

assert.match(manifest, /^name: 运维模式$/m);
assert.match(manifest, /无本地 shell/);
assert.match(config, /^\s+prefix: \|-$/m, "persona uses the current required prefix field");
assert.doesNotMatch(config, /^\s+text:/m, "persona never uses the removed text field");
for (const required of ["dsh-ssh-ops", "ssh_batch", "complete: true", "includeRuntimeContext: false", "@deepseek-ai/dsh-fs-local", "@deepseek-ai/dsh-skill-filesystem"]) {
  assert.ok(config.includes(required), `native preset keeps ${required}`);
}
assert.match(skill, /^name: test-op$/m);
assert.match(skill, /变更前基线/);
assert.match(skill, /结论 → 证据/);
assert.ok(!config.includes("密码："), "preset never contains a hard-coded secret");

const dshHome = mkdtempSync(join(tmpdir(), "dsh-ssh-ops-preset-"));
const installed = spawnSync(process.execPath, ["scripts/install-ops-preset.mjs"], {
  cwd: fileURLToPath(root),
  env: { ...process.env, DSH_HOME: dshHome },
  encoding: "utf8"
});
assert.equal(installed.status, 0, installed.stderr);
assert.equal(readFileSync(join(dshHome, ".agent-presets/ops/preset.yml"), "utf8"), manifest);

console.log("native ops agent preset: all cases passed");
