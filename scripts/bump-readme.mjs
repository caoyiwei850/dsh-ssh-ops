/**
 * Release helper: sync the hardcoded version strings in both READMEs and the
 * two product guides (badges, install commands, release links, document
 * footer) with package.json.
 * Run as part of the release bump: node scripts/bump-readme.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// The previous version is whatever the docs currently pin; accept any
// x.y.z so a skipped release still converges.
const VERSIONED = [
  /version-\d+\.\d+\.\d+/g,                     // shields.io badge
  /dsh-ssh-ops@\d+\.\d+\.\d+(?![-.])/g,          // npm install / npx targets, not host prerelease badges
  /dsh-ssh-ops-\d+\.\d+\.\d+\.(?:tgz|zip)/g,    // release asset names/links
  /dsh-ssh-ops#v\d+\.\d+\.\d+/g,                // GitHub tag install ref
  /releases\/tag\/v\d+\.\d+\.\d+/g,             // GitHub release links
  /\*\*版本 \d+\.\d+\.\d+\*\*/g,                // Chinese product-guide header
  /\*\*Version \d+\.\d+\.\d+\*\*/g,             // English product-guide header
  /文档对应版本 v\d+\.\d+\.\d+/g,                // Chinese product-guide footer
  /This document matches v\d+\.\d+\.\d+/g       // English product-guide footer
];

let changed = 0;
for (const doc of ["README.md", "README.en.md", "docs/product-guide.md", "docs/product-guide.en.md"]) {
  const path = join(root, doc);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    continue;
  }
  const before = text;
  for (const pattern of VERSIONED) text = text.replace(pattern, (match) => match.replace(/\d+\.\d+\.\d+/, version));
  if (text !== before) {
    writeFileSync(path, text);
    changed += 1;
    console.log(`${doc}: version strings synced to ${version}`);
  }
}
if (changed === 0) console.log(`release documentation already at ${version}`);
