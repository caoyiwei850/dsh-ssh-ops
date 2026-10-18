/**
 * Remote-workspace unit tests (issue #38): path canonicalization, containment,
 * workspace-relative mapping, the prompt paragraph, and the binding store.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  RemoteWorkspacePathError,
  RemoteWorkspaceStore,
  remoteWorkspaceDomainSpec,
  remoteWorkspaceRecordSchema,
  isRemotePathInside,
  normalizeRemoteRoot,
  remoteWorkspacePromptText,
  resolveRemotePath,
  workspaceRelativePart,
  REMOTE_WORKSPACE_OUTSIDE
} from "../src/remote-workspace.js";

/** Minimal stand-in for a storage-domain table. */
function memoryTable() {
  const rows = new Map();
  return {
    get: (key) => rows.get(key),
    put: async (key, value) => { rows.set(key, value); },
    delete: async (key) => { rows.delete(key); },
    entries: () => rows.entries(),
    size: () => rows.size
  };
}

test("normalizeRemoteRoot canonicalizes and rejects relative or empty input", () => {
  assert.equal(normalizeRemoteRoot("/srv/app"), "/srv/app");
  assert.equal(normalizeRemoteRoot("/srv/app/"), "/srv/app");
  assert.equal(normalizeRemoteRoot("/srv//app/./x/../y"), "/srv/app/y");
  assert.equal(normalizeRemoteRoot("/"), "/");
  assert.throws(() => normalizeRemoteRoot("srv/app"), RemoteWorkspacePathError);
  assert.throws(() => normalizeRemoteRoot("   "), RemoteWorkspacePathError);
  for (const control of ["\0", "\n", "\t", "\x7f"]) {
    assert.throws(() => normalizeRemoteRoot(`/srv/app${control}x`), /control characters/);
    assert.throws(() => normalizeRemoteRoot(`${control}/srv/app`), /control characters/);
  }
  assert.throws(() => normalizeRemoteRoot(42), /must be a string/);
});

test("isRemotePathInside accepts descendants and rejects escapes", () => {
  assert.equal(isRemotePathInside("/srv/app", "/srv/app"), true);
  assert.equal(isRemotePathInside("/srv/app", "/srv/app/releases/1"), true);
  // A sibling that merely shares the prefix is NOT inside.
  assert.equal(isRemotePathInside("/srv/app", "/srv/application"), false);
  assert.equal(isRemotePathInside("/srv/app", "/srv"), false);
  // "/" contains everything, by definition.
  assert.equal(isRemotePathInside("/", "/etc/passwd"), true);
});

test("resolveRemotePath joins relative input and pins absolute input to the root", () => {
  assert.equal(resolveRemotePath("/srv/app", "config/app.yml"), "/srv/app/config/app.yml");
  assert.equal(resolveRemotePath("/srv/app", "./config/../config/x"), "/srv/app/config/x");
  assert.equal(resolveRemotePath("/srv/app", "/srv/app/deep/file"), "/srv/app/deep/file");
  // An absolute path outside the root is the escape this module exists to stop.
  assert.throws(() => resolveRemotePath("/srv/app", "/etc/passwd"), /escapes the remote workspace root/);
  assert.throws(() => resolveRemotePath("/srv/app", "../../etc/passwd"), /escapes the remote workspace root/);
  assert.throws(() => resolveRemotePath("/srv/app", ""), /must not be empty/);
  assert.throws(() => resolveRemotePath("/srv/app", "bad\nname"), /control characters/);
  assert.throws(() => resolveRemotePath("/srv/app", "\tbad"), /control characters/);
  const error = (() => { try { resolveRemotePath("/srv/app", "/root/.ssh/id_rsa"); } catch (caught) { return caught; } })();
  assert.equal(error.code, REMOTE_WORKSPACE_OUTSIDE);
});

test("workspaceRelativePart maps a host path into its workspace", () => {
  assert.equal(workspaceRelativePart("/work/app", "/work/app"), "");
  assert.equal(workspaceRelativePart("/work/app", "/work/app/src/index.js"), "src/index.js");
  assert.equal(workspaceRelativePart("/work/app", "/work/other/x"), null);
  assert.equal(workspaceRelativePart("/work/app", "/work/application/x"), null);
  assert.equal(workspaceRelativePart("/work/app", "/"), null);
});

test("remoteWorkspacePromptText names the root, the tools and the local caveat", () => {
  const text = remoteWorkspacePromptText({
    workspacePath: "/Users/me/work/app",
    remotePath: "/srv/app",
    resourceName: "web-prod",
    username: "deploy",
    host: "10.0.0.5",
    port: 22,
    relative: "src"
  });
  assert.match(text, /Remote workspace/);
  assert.match(text, /\/srv\/app\/src/);
  assert.match(text, /web-prod/);
  assert.match(text, /sftp_\*/);
  assert.match(text, /ssh_exec/);
  // The paragraph must warn that the native tools stay local rather than imply
  // a transparent remote mount.
  assert.match(text, /local filesystem/);
  assert.match(text, /Do not use them/);
  assert.equal(remoteWorkspacePromptText(undefined), "");
  assert.equal(remoteWorkspacePromptText({ workspacePath: "/x" }), "");
});

test("RemoteWorkspaceStore saves, lists, resolves the deepest binding and removes", async () => {
  const store = new RemoteWorkspaceStore(memoryTable());
  const profileId = "11111111-1111-4111-8111-111111111111";
  const otherId = "22222222-2222-4222-8222-222222222222";
  await store.save({ workspacePath: "/work/parent", profileId, remotePath: "/srv/parent/" });
  await store.save({ workspacePath: "/work/parent/nested", profileId: otherId, remotePath: "/srv/nested", autoConnect: true });

  const listed = store.list();
  assert.equal(listed.length, 2);
  assert.equal(listed[0].remotePath, "/srv/parent");

  assert.equal(store.get("/work/parent").profileId, profileId);
  assert.equal(store.get("/work/missing"), undefined);

  const nested = store.findForPath("/work/parent/nested/src/a.js");
  assert.equal(nested.record.profileId, otherId);
  assert.equal(nested.relative, "src/a.js");
  const parent = store.findForPath("/work/parent/docs");
  assert.equal(parent.record.profileId, profileId);
  assert.equal(parent.relative, "docs");
  assert.equal(store.findForPath("/tmp/elsewhere"), undefined);

  // Re-binding the same workspace replaces the row instead of duplicating it.
  await store.save({ workspacePath: "/work/parent", profileId: otherId, remotePath: "/srv/replaced" });
  assert.equal(store.list().length, 2);
  assert.equal(store.get("/work/parent").remotePath, "/srv/replaced");

  assert.equal(await store.remove("/work/parent/nested"), true);
  assert.equal(await store.remove("/work/parent/nested"), false);
  // With the nested binding gone, the path falls back to the enclosing one.
  const fallback = store.findForPath("/work/parent/nested/src");
  assert.equal(fallback.record.workspacePath, "/work/parent");
  assert.equal(fallback.relative, "nested/src");
});

test("save refuses a non-absolute remote root", async () => {
  const store = new RemoteWorkspaceStore(memoryTable());
  await assert.rejects(
    store.save({ workspacePath: "/work/app", profileId: "11111111-1111-4111-8111-111111111111", remotePath: "srv/app" }),
    RemoteWorkspacePathError
  );
});

// Regression class of #20: a record the write path accepts but the domain
// schema rejects aborts the whole domain at boot, not just this plugin.
test("every persisted record parses back through the boot schema", async () => {
  const table = memoryTable();
  const store = new RemoteWorkspaceStore(table);
  await store.save({ workspacePath: "/work/app", profileId: "11111111-1111-4111-8111-111111111111", remotePath: "/srv/app/" });
  await store.save({ workspacePath: "/work/other", profileId: "22222222-2222-4222-8222-222222222222", remotePath: "/srv/other", autoConnect: true });

  assert.equal(remoteWorkspaceDomainSpec.version, 1);
  for (const [, record] of table.entries()) {
    const parsed = remoteWorkspaceRecordSchema.safeParse(record);
    assert.equal(parsed.success, true, `boot revalidation must accept ${JSON.stringify(record)}: ${JSON.stringify(parsed.error?.issues)}`);
  }
});
