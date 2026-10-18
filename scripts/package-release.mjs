import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const RELEASE_ARCHIVE_ENTRIES = [
  "assets",
  "lib",
  "src",
  "scripts",
  "test",
  "locale",
  "docs",
  "package.json",
  "package-lock.json",
  "cordis.patch.yml",
  "icon.svg",
  "README.md",
  "README.en.md",
  "INSTALL.md",
  "LICENSE",
  "CHANGELOG.md"
];

/** Local manual integration files are ignored in Git and must never reach ZIPs. */
export function shouldCopyReleaseEntry(source, root = DEFAULT_ROOT) {
  const manual = join(root, "test", "manual");
  return source !== manual && !source.startsWith(`${manual}${sep}`);
}

export function packageRelease(root = DEFAULT_ROOT) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const release = join(root, "release");
  const archiveRoot = `${pkg.name}-${pkg.version}`;
  const stage = join(release, archiveRoot);

  rmSync(release, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  for (const entry of RELEASE_ARCHIVE_ENTRIES) {
    const source = join(root, entry);
    if (existsSync(source)) {
      cpSync(source, join(stage, basename(entry)), {
        recursive: true,
        filter: (candidate) => shouldCopyReleaseEntry(candidate, root)
      });
    }
  }

  // --ignore-scripts: prepare (which builds lib/) must not re-run during pack —
  // pack:release has already built the exact artifacts this tarball should ship.
  execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", release], { cwd: root, stdio: "inherit" });
  execFileSync("zip", ["-q", "-r", "-X", join(release, `${archiveRoot}.zip`), archiveRoot], { cwd: release, stdio: "inherit" });
  rmSync(stage, { recursive: true, force: true });

  console.log(`release assets created in ${release}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  packageRelease();
}
