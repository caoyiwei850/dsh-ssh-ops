/**
 * Package-manifest regression test for the DSH web loader contract. The rc.1
 * loader composes a bundle's browser half only when package.json declares
 * `dsh.client` (platform "web") beside `dsh.bundle.patch`, and resolves the
 * entries through `exports` (which wins over `main`). Losing the client block
 * loads the host half silently while every client mount point vanishes — the
 * SSH tab button, the right-Sidebar tab body and the settings resources tab all
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
// #29: the entry files under lib/ are build artifacts excluded from git, so
// git-channel installs (github: tarballs) depend on the prepare hook to build
// them at install time. Removing it resurrects ERR_MODULE_NOT_FOUND with an
// install that exits 0 and only breaks after the host restarts.
assert.match(manifest.scripts?.prepare ?? "", /npm run build/,
  "scripts.prepare must run npm run build — git-channel installs rely on it to generate lib/ (#29)");

// ── plugin display metadata (DSH 0.2.x Plugin Manager / Settings rows) ──────
// The Host reads `<specifier>/package.json` for a package-root plugin, resolves
// the manifest `icon` from that manifest's directory, and loads locale
// resources by specifier; the rules below mirror
// packages/boot/app-boot/src/package-meta.ts (relative path that stays inside
// the package, SVG/PNG/JPEG/WebP, <=256 KiB, non-empty meta.title/description).
// Missing pieces never break a load — they degrade to the default artwork and
// the package description — so nothing else would catch a regression here.
assert.equal(manifest.icon, "./icon.svg", "the manifest declares the plugin display icon");
assert.match(manifest.icon, /^\.\//, "the Host rejects absolute or scheme-prefixed icon paths");
const iconPath = join(root, "icon.svg");
assert.ok(existsSync(iconPath), "icon.svg must sit inside the package (paths outside the manifest directory are rejected)");
assert.ok(statSync(iconPath).size <= 256 * 1024, "the icon must stay under the Host's 256 KiB cap");
assert.ok(manifest.files.includes("icon.svg"), "icon.svg must ship in the published package or the row loses its artwork");
assert.equal(manifest.exports?.["./locale/*.json"], "./locale/*.json", "locale resources must be exported for the Host reader");
assert.ok(manifest.files.includes("locale/*.json"), "locale dictionaries must ship in the published package");
for (const language of ["en", "zh"]) {
  const dictionary = JSON.parse(readFileSync(join(root, "locale", `${language}.json`), "utf8"));
  assert.ok(typeof dictionary.meta?.title === "string" && dictionary.meta.title.trim() !== "",
    `locale/${language}.json needs a non-empty meta.title (the Host throws on empty strings)`);
  assert.ok(typeof dictionary.meta?.description === "string" && dictionary.meta.description.trim() !== "",
    `locale/${language}.json needs a non-empty meta.description (the Host throws on empty strings)`);
}

// ── packed-tarball file manifest (#29 hardening, fix ③) ─────────────────────
// The npm/tgz artifact is the ONLY runtime surface for most users, and a
// locally link:-mounted dev tree always has lib/ on disk — so "the package
// ships exactly what the runtime needs" is invisible on the dev machine and
// only fails for users. Assert the EXACT file set `npm pack` produces (not
// just the `files` globs): adding a root file to the package or losing a lib
// bundle must be a conscious checklist update, never an accident.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";

// The pack list includes lib/, which is a build output. CI builds before
// testing; a fresh clone running this file directly gets the same courtesy
// (same pattern as test/db-lazy-load.mjs).
if (!existsSync(join(root, "lib", "index.js"))) {
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
}
const packJson = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: root, encoding: "utf8", shell: process.platform === "win32"
});
assert.equal(packJson.status, 0, `npm pack --dry-run failed: ${packJson.stderr}`);
const packedFiles = JSON.parse(packJson.stdout)[0].files.map((f) => f.path).sort();
const expectedPackedFiles = [
  "INSTALL.md",
  "LICENSE",
  "README.en.md",
  "README.md",
  "cordis.patch.yml",
  "icon.svg",
  "lib/client.js",
  "lib/index.js",
  "lib/remote.js",
  "lib/typert.js",
  "locale/en.json",
  "locale/zh.json",
  "package.json",
  "scripts/build-client.mjs",
  "scripts/build-host.mjs",
  "scripts/bump-readme.mjs",
  "scripts/gen-xterm-css.mjs",
  "scripts/i18n-codemod.mjs",
  "scripts/i18n-extract.mjs",
  "scripts/i18n-pr26-zh.dict.mjs",
  "scripts/install-dev.mjs",
  "scripts/install-test-stubs.mjs",
  "scripts/package-release.mjs"
].sort();
assert.deepEqual(
  packedFiles,
  expectedPackedFiles,
  "the packed tarball's file set drifted from the audited manifest — update expectedPackedFiles deliberately (runtime surface: lib/ + package.json; the rest is docs/tooling), never let it change silently"
);
for (const required of ["lib/index.js", "lib/client.js", "lib/typert.js", "lib/remote.js", "package.json"]) {
  assert.ok(packedFiles.includes(required), `the runtime-critical file ${required} must ship in the tarball`);
}
console.log(`manifest: packed tarball manifest intact (${packedFiles.length} files)`);
console.log("manifest: dsh bundle+client declarations intact");
