import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSimpleDeleteCommand, buildTrashCommand, parseTrashOutput,
  parseTrashManifest, buildRestoreCommand, buildPurgeCommand, TRASH_RETENTION_MS
} from "../src/trash.js";

// The parser/serialiser halves run anywhere, but the end-to-end half executes
// the generated scripts through /bin/sh in a sandbox with HOME overrides and
// symlinks — POSIX shell semantics are the subject under test (the trash
// flow targets remote POSIX servers, not the local platform).
if (process.platform === "win32") {
  console.log("trash: skipped on Windows (end-to-end half requires /bin/sh sandbox semantics)");
  process.exit(0);
}

// ── parser ───────────────────────────────────────────────────────────────────

const parseable = [
  ["rm /tmp/x", [{ kind: "plain", path: "/tmp/x" }]],
  ["rm -rf /tmp/x", [{ kind: "plain", path: "/tmp/x" }]],
  ["rm -r -f /tmp/x /tmp/y", [{ kind: "plain", path: "/tmp/x" }, { kind: "plain", path: "/tmp/y" }]],
  ["rm -rfv /tmp/a b", [{ kind: "plain", path: "/tmp/a" }, { kind: "plain", path: "b" }]],
  ["rm -- -/weird", [{ kind: "plain", path: "-/weird" }]],
  ["rm '/tmp/a b'", [{ kind: "plain", path: "/tmp/a b" }]],
  ["unlink file", [{ kind: "plain", path: "file" }]],
  ["rmdir -v emptydir", [{ kind: "plain", path: "emptydir" }]],
  ["rm -rf '~/my dir'", [{ kind: "plain", path: "~/my dir" }]],
  ["rm -rf ~/logs", [{ kind: "home", path: "logs" }]],
  ["rm -f -- ./relative", [{ kind: "plain", path: "./relative" }]],
  ["rm -rf\tx", [{ kind: "plain", path: "x" }]] // a tab is an IFS separator, exactly like a space
];
for (const [command, expected] of parseable) {
  const parsed = parseSimpleDeleteCommand(command);
  assert.notEqual(parsed, null, `expected parseable: ${command}`);
  assert.deepEqual(parsed.targets, expected, `targets of: ${command}`);
}

const rejected = [
  null, undefined, "",
  "rm",
  "rm -rf", // flags only, no target
  "rm -rf /tmp/x && echo done", // compound
  "rm -rf /tmp/x; echo done",
  "rm -rf /tmp/x | cat",
  "cat log | rm -i", // not a leading delete
  "rm -rf /tmp/$(whoami)",
  "rm -rf /tmp/`id -u`",
  "rm -rf /tmp/x > /dev/null",
  "rm -rf /tmp/*.log", // globs cannot be re-quoted safely
  "rm -rf ~", // bare home
  "rm -rf /", // root
  "rm -rf .",
  "rm -rf ..",
  "rm --recursive /tmp/x", // long options
  "rm -p x", // unknown flag
  "rmdir -p a/b",
  "shred /tmp/x", // in-place overwrite is not trashable
  "sudo rm -rf /tmp/x",
  "/bin/rm -rf /tmp/x",
  "RM -rf /tmp/x", // commands are case-sensitive
  "rm ''",
  "rm ~user/x",
  "rm -rf -" // stdin convention
];
for (const command of rejected) {
  assert.equal(parseSimpleDeleteCommand(command), null, `expected rejected: ${JSON.stringify(command)}`);
}

// ── output parsing ───────────────────────────────────────────────────────────

{
  const stdout = "__DSH_CWD_MARK__\n__DSH_TRASH_V1__\tpurged\t2\nsome output\n__DSH_TRASH_V1__\tmoved\t/tmp/x\t/root/.dsh-trash/1700000000-x\n__DSH_TRASH_V1__\tmissing\t/tmp/none\n__DSH_TRASH_V1__\tfailed\t/tmp/stuck\n";
  const parsed = parseTrashOutput(stdout);
  assert.deepEqual(parsed.events, [
    { event: "purged", count: 2 },
    { event: "moved", original: "/tmp/x", trashPath: "/root/.dsh-trash/1700000000-x" },
    { event: "missing", original: "/tmp/none" },
    { event: "failed", original: "/tmp/stuck" }
  ]);
  assert.equal(parsed.stdout, "__DSH_CWD_MARK__\nsome output\n", "protocol lines must be stripped from visible output");
}

// ── manifest parsing ─────────────────────────────────────────────────────────

{
  const text = "1700000000-x\t/tmp/x\t1700000000\t20231114T221320Z\ngarbage line\nbad\t\t123\tiso\n../evil\t/tmp/evil\t1700000000\tiso\n1700000001-y\t/tmp/y\t1700000001\t20231114T221321Z";
  const entries = parseTrashManifest(text);
  assert.equal(entries.length, 2, "malformed and path-traversal lines must be skipped");
  assert.equal(entries[0].name, "1700000000-x");
  assert.equal(entries[0].original, "/tmp/x");
  assert.equal(entries[1].name, "1700000001-y");
}

// ── end-to-end with a real /bin/sh ───────────────────────────────────────────

function runInSandbox(script, sandbox) {
  return spawnSync("/bin/sh", ["-c", script], {
    encoding: "utf8",
    cwd: sandbox.cwd,
    env: { ...process.env, HOME: sandbox.home, PATH: process.env.PATH }
  });
}

{
  const base = mkdtempSync(join(tmpdir(), "dsh-trash-"));
  const home = join(base, "home");
  const cwd = join(base, "work");
  mkdirSync(join(home, "data", "logs"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(home, "data", "db.sqlite"), "payload");
  writeFileSync(join(home, "data", "logs", "app.log"), "log line\n");
  writeFileSync(join(cwd, "relative.txt"), "rel");
  const sandbox = { home, cwd };

  const parsed = parseSimpleDeleteCommand("rm -rf ~/data/logs ~/data/db.sqlite relative.txt");
  const script = buildTrashCommand(parsed.targets);

  const run = runInSandbox(script, sandbox);
  assert.equal(run.status, 0, `script failed: ${run.stderr}`);
  assert.equal(run.stderr, "");

  const parsedOut = parseTrashOutput(run.stdout);
  const moved = parsedOut.events.filter((e) => e.event === "moved");
  assert.equal(moved.length, 3, `expected three moved events, got: ${run.stdout}`);

  // Originals are gone.
  assert.equal(existsSync(join(home, "data", "logs")), false);
  assert.equal(existsSync(join(home, "data", "db.sqlite")), false);
  assert.equal(existsSync(join(cwd, "relative.txt")), false);

  // Trash layout: three entries plus the manifest, and only those.
  const trashDir = join(home, ".dsh-trash");
  const entries = readdirSync(trashDir).filter((name) => name !== "manifest.tsv");
  assert.equal(entries.length, 3);
  const logsEntry = entries.find((name) => name.endsWith("-logs"));
  assert.ok(logsEntry && existsSync(join(trashDir, logsEntry, "app.log")), "directory contents move with the entry");

  // Manifest records absolute originals; the relative one resolved to the
  // physical cwd (pwd -P), which differs from the logical path on macOS.
  const manifest = readFileSync(join(trashDir, "manifest.tsv"), "utf8");
  const listed = parseTrashManifest(manifest);
  assert.equal(listed.length, 3);
  const physicalCwd = realpathSync(cwd);
  assert.deepEqual(listed.map((e) => e.original).sort(), [join(home, "data/logs"), join(home, "data/db.sqlite"), join(physicalCwd, "relative.txt")].sort());

  // Restore one entry: file comes back, manifest line disappears.
  const relEntry = listed.find((e) => e.original.endsWith("relative.txt"));
  const restoreRun = runInSandbox(buildRestoreCommand(relEntry), sandbox);
  assert.equal(restoreRun.status, 0, `restore failed: ${restoreRun.stderr}`);
  assert.equal(readFileSync(join(cwd, "relative.txt"), "utf8"), "rel");
  assert.equal(parseTrashManifest(readFileSync(join(trashDir, "manifest.tsv"), "utf8")).length, 2);
  // A second restore must fail one way or another (the entry is gone, and
  // even if it were not, the target now exists).
  const restoreAgain = runInSandbox(buildRestoreCommand(relEntry), sandbox);
  assert.notEqual(restoreAgain.status, 0);
  assert.match(restoreAgain.stderr, /not found|already exists/);

  // Purge the rest: entries and manifest lines disappear together.
  const rest = parseTrashManifest(readFileSync(join(trashDir, "manifest.tsv"), "utf8"));
  const purgeRun = runInSandbox(buildPurgeCommand(rest), sandbox);
  assert.equal(purgeRun.status, 0, `purge failed: ${purgeRun.stderr}`);
  assert.equal(purgeRun.stdout.match(/purged/g).length, 2);
  assert.equal(parseTrashManifest(readFileSync(join(trashDir, "manifest.tsv"), "utf8")).length, 0);

  rmSync(base, { recursive: true, force: true });
}

// Retention: entries older than the window are purged on the next trash run,
// fresh entries survive.
{
  const base = mkdtempSync(join(tmpdir(), "dsh-trash-ret-"));
  const home = join(base, "home");
  mkdirSync(join(home, ".dsh-trash"), { recursive: true });
  const sandbox = { home, cwd: home };
  const oldEpoch = Math.floor(Date.now() / 1000) - Math.floor(TRASH_RETENTION_MS / 1000) - 120;
  const trashDir = join(home, ".dsh-trash");
  mkdirSync(join(trashDir, `${oldEpoch}-old`), { recursive: true });
  writeFileSync(join(trashDir, `${oldEpoch}-old`, "f"), "x");
  writeFileSync(join(trashDir, "manifest.tsv"), `${oldEpoch}-old\t/old\t${oldEpoch}\told-time\n`);

  const parsed = parseSimpleDeleteCommand("rm fresh.txt");
  writeFileSync(join(home, "fresh.txt"), "new");
  const run = runInSandbox(buildTrashCommand(parsed.targets), sandbox);
  assert.equal(run.status, 0, run.stderr);

  assert.equal(existsSync(join(trashDir, `${oldEpoch}-old`)), false, "expired entry must be purged");
  assert.equal(existsSync(join(trashDir, "fresh.txt")), false, "the new target must be moved");
  const listed = parseTrashManifest(readFileSync(join(trashDir, "manifest.tsv"), "utf8"));
  assert.equal(listed.length, 1);
  assert.match(listed[0].name, /-fresh\.txt$/, "the fresh manifest line survives the purge");
  assert.equal(listed[0].original, join(realpathSync(home), "fresh.txt"));

  rmSync(base, { recursive: true, force: true });
}

// Edge cases: missing target reported, symlink moved, broken symlink moved,
// quoting survives spaces and single quotes, and a quoted `~` stays literal
// (the shell would not expand it either).
{
  const base = mkdtempSync(join(tmpdir(), "dsh-trash-edge-"));
  const home = join(base, "home");
  mkdirSync(home, { recursive: true });
  const sandbox = { home, cwd: home };
  writeFileSync(join(home, "a b'c"), "quoted");
  writeFileSync(join(home, "spaced"), "spaced");
  symlinkSync("/nonexistent-target", join(home, "broken-link"));

  const parsed = parseSimpleDeleteCommand("rm -f '/tmp/never-exists' 'a b'\\''c' spaced broken-link");
  const run = runInSandbox(buildTrashCommand(parsed.targets), sandbox);
  assert.equal(run.status, 0, run.stderr);
  const { events } = parseTrashOutput(run.stdout);
  const missing = events.find((e) => e.event === "missing");
  assert.ok(missing && missing.original === "/tmp/never-exists");
  const moved = events.filter((e) => e.event === "moved");
  assert.equal(moved.length, 3, `quoted and symlink targets must move: ${run.stdout}`);

  const listed = parseTrashManifest(readFileSync(join(home, ".dsh-trash", "manifest.tsv"), "utf8"));
  const physicalHome = realpathSync(home);
  assert.ok(listed.some((e) => e.original === join(physicalHome, `a b'c`)), "single-quote path must land in the manifest verbatim");
  assert.ok(listed.some((e) => e.original === join(physicalHome, "broken-link")));

  // A quoted `~/x` is a literal path — it moves a directory literally named
  // "~" relative to the cwd, never the real home.
  const literal = parseSimpleDeleteCommand("rm -rf '~/x'");
  assert.deepEqual(literal.targets, [{ kind: "plain", path: "~/x" }]);

  rmSync(base, { recursive: true, force: true });
}

// Collision: deleting the same basename twice in one run must not clobber.
{
  const base = mkdtempSync(join(tmpdir(), "dsh-trash-col-"));
  const home = join(base, "home");
  mkdirSync(join(home, "d1"), { recursive: true });
  mkdirSync(join(home, "d2"), { recursive: true });
  const sandbox = { home, cwd: home };
  writeFileSync(join(home, "d1", "same.txt"), "one");
  writeFileSync(join(home, "d2", "same.txt"), "two");

  const parsed = parseSimpleDeleteCommand("rm d1/same.txt d2/same.txt");
  const run = runInSandbox(buildTrashCommand(parsed.targets), sandbox);
  assert.equal(run.status, 0, run.stderr);
  const listed = parseTrashManifest(readFileSync(join(home, ".dsh-trash", "manifest.tsv"), "utf8"));
  assert.equal(listed.length, 2, "both copies must be recorded");
  const names = new Set(listed.map((e) => e.name));
  assert.equal(names.size, 2, "trash names must not collide");

  rmSync(base, { recursive: true, force: true });
}

console.log("trash: parser, builder, manifest, restore/purge and retention cases passed");
