/**
 * Build the host faces (service entry + typert/remote artifacts) as ESM for
 * Node. @deepseek-ai/* and ssh2 stay external (resolved from the profile's
 * node_modules at runtime); zod and MongoDB are bundled so their dependencies
 * do not enter the Desktop generation installation closure.
 */
import { build } from "esbuild";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
rmSync(resolve(rootDir, "lib", "chunks"), { recursive: true, force: true });

await build({
  entryPoints: [
    resolve(rootDir, "src/index.js"),
    resolve(rootDir, "src/typert.js"),
    resolve(rootDir, "src/remote.js")
  ],
  outdir: resolve(rootDir, "lib"),
  format: "esm",
  platform: "node",
  target: "node20",
  bundle: true,
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  sourcemap: false,
  // MongoDB's CJS internals use dynamic require for Node built-ins. Supply a
  // require rooted at this output module while keeping the other DB drivers
  // external. pg-cursor must stay external: bundling it inlines
  // deep requires of "pg/lib/result.js" which have no ESM import mapping and
  // crash the host loader at plugin import time (0.2.15 boot crash).
  banner: { js: "import { createRequire as __dshCreateRequire } from 'node:module'; const require = __dshCreateRequire(import.meta.url);" },
  external: ["@deepseek-ai/*", "ssh2", "mysql2", "pg", "pg-cursor", "redis"],
  logLevel: "info"
});
for (const file of ["index.js", "typert.js", "remote.js"]) {
  const path = resolve(rootDir, "lib", file);
  writeFileSync(path, readFileSync(path, "utf8").replace(/[ \t]+$/gm, ""), "utf8");
}
console.log("build-host: wrote lib/index.js, lib/typert.js, lib/remote.js");
