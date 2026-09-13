import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const release = join(root, "release");
const archiveRoot = `${pkg.name}-${pkg.version}`;
const stage = join(release, archiveRoot);

rmSync(release, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

for (const entry of ["assets", "lib", "src", "scripts", "test", "package.json", "package-lock.json", "cordis.patch.yml", "README.md", "LICENSE", "CHANGELOG.md"]) {
  const source = join(root, entry);
  if (existsSync(source)) cpSync(source, join(stage, basename(entry)), { recursive: true });
}

execFileSync("npm", ["pack", "--pack-destination", release], { cwd: root, stdio: "inherit" });
execFileSync("zip", ["-q", "-r", "-X", join(release, `${archiveRoot}.zip`), archiveRoot], { cwd: release, stdio: "inherit" });
rmSync(stage, { recursive: true, force: true });

console.log(`release assets created in ${release}`);
