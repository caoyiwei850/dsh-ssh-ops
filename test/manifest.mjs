/**
 * Package-manifest regression test for the DSH web loader contract. The rc.1
 * loader composes a bundle's browser half only when package.json declares
 * `dsh.client` (platform "web") beside `dsh.bundle.patch`, and resolves the
 * entries through `exports` (which wins over `main`). Losing the client block
 * loads the host half silently while every client mount point vanishes — the
 * SSH tab button, the terminal drawer and the settings resources tab all
 * disappear from a freshly loaded web UI (2026-09-03 rc.1 upgrade regression).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

assert.ok(manifest.dsh?.bundle?.patch, "dsh.bundle.patch must declare the cordis patch layer (rc.1 loader requirement)");
assert.equal(manifest.dsh?.client?.platform, "web", "dsh.client.platform=web is what makes the web loader compose the client bundle");
assert.ok(
  manifest.dsh?.client?.inject?.includes("@deepseek-ai/dsh-client-runtime"),
  "dsh.client.inject must request the client runtime row in the browser module table"
);
assert.equal(manifest.exports?.["."]?.default, "./lib/index.js", 'exports["."] must map the host entry (exports wins over main)');
assert.equal(manifest.exports?.["./client"]?.default, "./lib/client.js", 'exports["./client"] must map the browser bundle');
assert.ok(manifest.files.includes("lib"), "the npm package keeps generated runtime artifacts");
assert.ok(manifest.files.includes("scripts"), "the npm package keeps its declared install helper");
assert.ok(!manifest.files.includes("src") && !manifest.files.includes("assets"),
  "source and documentation screenshots stay in Git/GitHub release archives, not the runtime npm package");
console.log("manifest: dsh bundle+client declarations intact");
