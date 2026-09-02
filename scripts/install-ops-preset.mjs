#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const replace = process.argv.slice(2).includes("--force");
const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../.agent-presets/ops");
const dshHome = process.env.DSH_HOME || resolve(homedir(), ".dsh");
const destination = resolve(dshHome, ".agent-presets/ops");

if (!existsSync(source)) throw new Error(`Bundled ops preset is missing: ${source}`);
if (existsSync(destination) && !replace) {
  throw new Error(`Preset already exists: ${destination}. Re-run with --force to update its bundled files.`);
}

mkdirSync(dirname(destination), { recursive: true });
cpSync(source, destination, { recursive: true, force: replace });
console.log(`Installed DSH preset “运维模式” at ${destination}`);
