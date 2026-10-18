import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RELEASE_ARCHIVE_ENTRIES,
  shouldCopyReleaseEntry
} from "../scripts/package-release.mjs";

const root = mkdtempSync(join(tmpdir(), "dsh-release-packaging-"));
try {
  mkdirSync(join(root, "test", "manual"), { recursive: true });
  mkdirSync(join(root, "test", "unit"), { recursive: true });
  writeFileSync(join(root, "test", "manual", "private.mjs"), "secret\n");
  writeFileSync(join(root, "test", "unit", "public.mjs"), "ok\n");

  for (const entry of ["docs", "README.en.md", "INSTALL.md", "CHANGELOG.md"]) {
    assert.ok(RELEASE_ARCHIVE_ENTRIES.includes(entry), `release archive must include ${entry}`);
  }
  assert.equal(shouldCopyReleaseEntry(join(root, "test"), root), true);
  assert.equal(shouldCopyReleaseEntry(join(root, "test", "unit"), root), true);
  assert.equal(shouldCopyReleaseEntry(join(root, "test", "unit", "public.mjs"), root), true);
  assert.equal(shouldCopyReleaseEntry(join(root, "test", "manual"), root), false);
  assert.equal(shouldCopyReleaseEntry(join(root, "test", "manual", "private.mjs"), root), false);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("release packaging: docs included and manual integration files excluded");
