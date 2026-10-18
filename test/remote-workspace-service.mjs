/**
 * Remote-workspace service glue (issue #38): the panel RPCs and the path /
 * connection resolution the sftp_* tools go through, exercised on a bare
 * service instance the way test/agent-connect.mjs does.
 */
import assert from "node:assert/strict";
import SshOpsService from "../src/index.js";
import { RemoteWorkspaceStore, REMOTE_WORKSPACE_OFFLINE, REMOTE_WORKSPACE_OUTSIDE } from "../src/remote-workspace.js";
import { remoteWorkspaceListResultSchema, remoteWorkspaceSaveResultSchema } from "../src/schemas.js";

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const PROFILES = [
  { profileId: PROFILE_ID, name: "web-prod", host: "10.0.0.5", port: 22, username: "deploy" },
  { profileId: OTHER_ID, name: "db", host: "10.0.0.6", port: 2222, username: "root" }
];
const WORKSPACES = [{ path: "/Users/me/work/app", title: "app" }];

function memoryTable() {
  const rows = new Map();
  return { get: (k) => rows.get(k), put: async (k, v) => { rows.set(k, v); }, delete: async (k) => { rows.delete(k); }, entries: () => rows.entries() };
}

function connection(id, profileId, overrides = {}) {
  return { connectionId: id, profileId, host: "10.0.0.5", port: 22, username: "deploy", dead: false, closing: false, connecting: false, sessions: new Set(["s1"]), ...overrides };
}

function makeService({ agentAutoConnect = true, connections = [] } = {}) {
  const service = Object.create(SshOpsService.prototype);
  service.connections = new Map(connections);
  service.activeConnectionId = null;
  service.sessions = new Map([["s1", { exited: null, stream: {} }]]);
  service.exitedSessions = new Map();
  service.agentAutoConnect = agentAutoConnect;
  service.profileTable = {
    get: (id) => PROFILES.find((profile) => profile.profileId === id),
    entries: () => PROFILES.map((profile) => [profile.profileId, profile])[Symbol.iterator]()
  };
  service.remoteWorkspaces = new RemoteWorkspaceStore(memoryTable());
  service.remoteRealpaths = new Map([["/srv/app", "/srv/app"]]);
  service.requireSftp = async () => ({
    ok: true,
    sftp: {
      realpath(path, cb) {
        const value = service.remoteRealpaths.get(path);
        if (value === undefined) cb(new Error(`${path}: no such file`));
        else cb(null, value);
      },
      lstat(_path, cb) {
        cb(new Error("no such file"));
      }
    }
  });
  service.selectConnection = async () => ({ ok: true, value: {} });
  service.ctx = {
    get: (name) => {
      if (name === "workspaceRegistry") return { list: () => WORKSPACES };
      return undefined;
    }
  };
  return service;
}

/** A tool-exec stand-in with the real DSH Session header shape. */
function exec(directory) {
  return { agent: { session: { header: { cwd: directory } } } };
}

/** Wire `workingDirectory` to the session's own committed directory. */
function withDirectory(service, fallback) {
  service.ctx.get = (name) => {
    if (name === "workspaceRegistry") return { list: () => WORKSPACES };
    if (name === "workingDirectory") return { get: (session) => session?.header?.cwd ?? fallback };
    return undefined;
  };
  return service;
}

// ── list / save / delete round trip ────────────────────────────────────────
{
  const service = withDirectory(makeService(), "/Users/me/work/app");
  const empty = await service.remoteWorkspaceList();
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.value.bindings, []);
  assert.deepEqual(empty.value.workspaces, [{ path: "/Users/me/work/app", title: "app" }]);

  const rejected = await service.remoteWorkspaceSave({ workspacePath: "/tmp/elsewhere", profileId: PROFILE_ID, remotePath: "/srv/app" });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "no-workspace", "a directory DSH never registered cannot be bound");

  const noProfile = await service.remoteWorkspaceSave({ workspacePath: "/Users/me/work/app", profileId: "33333333-3333-4333-8333-333333333333", remotePath: "/srv/app" });
  assert.equal(noProfile.ok, false);
  assert.equal(noProfile.error.code, "no-profile");

  const relative = await service.remoteWorkspaceSave({ workspacePath: "/Users/me/work/app", profileId: PROFILE_ID, remotePath: "srv/app" });
  assert.equal(relative.ok, false);
  assert.equal(relative.error.code, REMOTE_WORKSPACE_OUTSIDE);

  const saved = await service.remoteWorkspaceSave({ workspacePath: "/Users/me/work/app", profileId: PROFILE_ID, remotePath: "/srv/app/", autoConnect: true });
  assert.equal(saved.ok, true);
  assert.equal(saved.value.binding.remotePath, "/srv/app", "the stored root is normalized");
  assert.equal(saved.value.binding.profileName, "web-prod");
  assert.equal(saved.value.binding.connected, false);
  assert.equal(remoteWorkspaceSaveResultSchema.safeParse(saved).success, true, "save satisfies the strict wire schema");

  const listed = await service.remoteWorkspaceList();
  assert.equal(listed.value.bindings.length, 1);
  assert.equal(remoteWorkspaceListResultSchema.safeParse(listed).success, true, "list satisfies the strict wire schema");

  const removed = await service.remoteWorkspaceDelete({ workspacePath: "/Users/me/work/app" });
  assert.equal(removed.ok, true);
  assert.equal(removed.value.removed, true);
  assert.equal((await service.remoteWorkspaceDelete({ workspacePath: "/Users/me/work/app" })).value.removed, false);
  assert.deepEqual((await service.remoteWorkspaceList()).value.bindings, []);
}

// ── the bound server shows as connected once a live connection exists ──────
{
  const service = withDirectory(makeService({ connections: [["c1", connection("c1", PROFILE_ID)]] }), "/Users/me/work/app");
  await service.remoteWorkspaceSave({ workspacePath: "/Users/me/work/app", profileId: PROFILE_ID, remotePath: "/srv/app" });
  const listed = await service.remoteWorkspaceList();
  assert.equal(listed.value.bindings[0].connected, true);
}

// ── path/connection resolution for one tool call ───────────────────────────
{
  const service = withDirectory(makeService({ connections: [["c1", connection("c1", PROFILE_ID)]] }), "/Users/me/work/app");
  await service.remoteWorkspaceSave({ workspacePath: "/Users/me/work/app", profileId: PROFILE_ID, remotePath: "/srv/app" });

  const unbound = await makeService().resolveRemoteToolPath({ path: "/etc/hosts" }, exec("/tmp/other"));
  assert.deepEqual(unbound, { connectionId: undefined, path: "/etc/hosts", bound: false }, "an unbound session keeps historical behavior");

  const relative = await service.resolveRemoteToolPath({ path: "config/app.yml" }, exec("/Users/me/work/app"));
  assert.deepEqual(relative, { connectionId: "c1", path: "/srv/app/config/app.yml", bound: true });
  assert.equal((await service.resolveRemoteToolPath({ path: "." }, exec("/Users/me/work/app/sub"))).path, "/srv/app/sub", "the session subdirectory maps 1:1 under the root");

  const fallback = makeService({ connections: [["c1", connection("c1", PROFILE_ID)]] });
  await fallback.remoteWorkspaceSave({ workspacePath: "/Users/me/work/app", profileId: PROFILE_ID, remotePath: "/srv/app" });
  assert.equal(
    (await fallback.resolveRemoteToolPath({ path: "README.md" }, exec("/Users/me/work/app"))).path,
    "/srv/app/README.md",
    "hosts without workingDirectory fall back to session.header.cwd"
  );

  const inside = await service.resolveRemoteToolPath({ path: "/srv/app/x", connectionId: "c1" }, exec("/Users/me/work/app"));
  assert.equal(inside.path, "/srv/app/x");

  await assert.rejects(
    service.resolveRemoteToolPath({ path: "../../etc/passwd" }, exec("/Users/me/work/app")),
    (error) => error.code === REMOTE_WORKSPACE_OUTSIDE
  );
  await assert.rejects(
    service.resolveRemoteToolPath({ path: "/etc/passwd" }, exec("/Users/me/work/app")),
    (error) => error.code === REMOTE_WORKSPACE_OUTSIDE
  );
  await assert.rejects(
    service.resolveRemoteToolPath({ path: "a.txt", connectionId: "other" }, exec("/Users/me/work/app")),
    (error) => error.code === REMOTE_WORKSPACE_OFFLINE
  );
  service.remoteRealpaths.set("/srv/app/link", "/etc");
  await assert.rejects(
    service.resolveRemoteToolPath({ path: "link/passwd" }, exec("/Users/me/work/app")),
    (error) => error.code === REMOTE_WORKSPACE_OUTSIDE && /symbolic link/.test(error.message),
    "an intermediate symlink cannot redirect a write outside the real root"
  );
}

// ── offline binding: reuse, auto-connect gate, operator switch ──────────────
{
  const live = withDirectory(makeService({ connections: [["c1", connection("c1", PROFILE_ID)]] }), "/Users/me/work/app");
  await live.remoteWorkspaceSave({ workspacePath: "/Users/me/work/app", profileId: PROFILE_ID, remotePath: "/srv/app", autoConnect: false });
  assert.equal((await live.resolveRemoteToolPath({ path: "a" }, exec("/Users/me/work/app"))).connectionId, "c1", "a live connection is reused even with auto-connect off");

  const noPty = withDirectory(
    makeService({ connections: [["c1", connection("c1", PROFILE_ID, { sessions: new Set() })]] }),
    "/Users/me/work/app"
  );
  await noPty.remoteWorkspaceSave({ workspacePath: "/Users/me/work/app", profileId: PROFILE_ID, remotePath: "/srv/app", autoConnect: false });
  const reopened = [];
  noPty.openSession = async ({ connectionId, openedBy }) => {
    reopened.push(`${connectionId}:${openedBy}`);
    noPty.connections.get(connectionId).sessions.add("s1");
    return { ok: true, value: { sessionId: "s1" } };
  };
  await noPty.resolveRemoteToolPath({ path: "a" }, exec("/Users/me/work/app"));
  assert.deepEqual(reopened, ["c1:agent"], "a reused transport without a live PTY opens the visible terminal");

  const offline = withDirectory(makeService({ connections: [] }), "/Users/me/work/app");
  await offline.remoteWorkspaceSave({ workspacePath: "/Users/me/work/app", profileId: PROFILE_ID, remotePath: "/srv/app", autoConnect: false });
  await assert.rejects(
    offline.resolveRemoteToolPath({ path: "a" }, exec("/Users/me/work/app")),
    (error) => error.code === REMOTE_WORKSPACE_OFFLINE && /connect .*web-prod/.test(error.message)
  );

  // autoConnect on, but the operator-wide agent switch is off.
  const switchedOff = withDirectory(makeService({ agentAutoConnect: false }), "/Users/me/work/app");
  await switchedOff.remoteWorkspaceSave({ workspacePath: "/Users/me/work/app", profileId: PROFILE_ID, remotePath: "/srv/app", autoConnect: true });
  await assert.rejects(
    switchedOff.resolveRemoteToolPath({ path: "a" }, exec("/Users/me/work/app")),
    (error) => error.code === REMOTE_WORKSPACE_OFFLINE
  );

  // autoConnect on and the switch on: connect, open a terminal, reveal it.
  const auto = withDirectory(makeService({ agentAutoConnect: true }), "/Users/me/work/app");
  await auto.remoteWorkspaceSave({ workspacePath: "/Users/me/work/app", profileId: PROFILE_ID, remotePath: "/srv/app", autoConnect: true });
  const opened = [];
  auto.profileConnect = async () => {
    auto.connections.set("c9", connection("c9", PROFILE_ID, { sessions: new Set() }));
    return { ok: true, value: { connectionId: "c9", host: "10.0.0.5", port: 22, username: "deploy" } };
  };
  auto.openSession = async ({ connectionId, openedBy }) => { opened.push(`${connectionId}:${openedBy}`); auto.connections.get(connectionId).sessions.add("s9"); return { ok: true, value: { sessionId: "s9" } }; };
  auto.selectConnection = async () => ({ ok: true, value: {} });
  const resolved = await auto.resolveRemoteToolPath({ path: "a" }, exec("/Users/me/work/app"));
  assert.equal(resolved.connectionId, "c9");
  assert.deepEqual(opened, ["c9:agent"], "auto-connect opens an agent terminal so the operator sees the machine");
  assert.equal(auto.connections.get("c9").agentRevealId !== undefined, true, "the browser is told to reveal the connection");
}

// ── a deleted resource leaves the binding visible but unusable ─────────────
{
  const service = withDirectory(makeService({ connections: [] }), "/Users/me/work/app");
  await service.remoteWorkspaceSave({ workspacePath: "/Users/me/work/app", profileId: PROFILE_ID, remotePath: "/srv/app", autoConnect: true });
  service.profileTable = { get: () => undefined, entries: () => [][Symbol.iterator]() };
  const listed = await service.remoteWorkspaceList();
  assert.equal(listed.value.bindings[0].missingResource, true);
  assert.equal(listed.value.bindings[0].profileName, "");
  await assert.rejects(
    service.resolveRemoteToolPath({ path: "a" }, exec("/Users/me/work/app")),
    (error) => error.code === REMOTE_WORKSPACE_OFFLINE
  );
}

// ── deleting a resource drops its bindings ─────────────────────────────────
{
  const profiles = PROFILES.map((profile) => ({ ...profile }));
  const service = withDirectory(makeService(), "/Users/me/work/app");
  service.profileTable = {
    get: (id) => profiles.find((profile) => profile.profileId === id),
    entries: () => profiles.map((profile) => [profile.profileId, profile])[Symbol.iterator](),
    delete: async (id) => { const at = profiles.findIndex((profile) => profile.profileId === id); if (at >= 0) profiles.splice(at, 1); }
  };
  service.ctx.credentials = { unset: async () => {} };
  await service.remoteWorkspaceSave({ workspacePath: "/Users/me/work/app", profileId: PROFILE_ID, remotePath: "/srv/app" });
  assert.equal((await service.remoteWorkspaceList()).value.bindings.length, 1);

  const deleted = await service.profileDelete({ profileId: PROFILE_ID });
  assert.equal(deleted.ok, true);
  // The editor can only show bindings of an existing resource, so an orphan
  // row would be impossible to remove from the UI: deletion takes them along.
  assert.deepEqual((await service.remoteWorkspaceList()).value.bindings, []);
}

// ── the prompt paragraph: bound only ───────────────────────────────────────
{
  const service = withDirectory(makeService(), "/Users/me/work/app");
  await service.remoteWorkspaceSave({ workspacePath: "/Users/me/work/app", profileId: PROFILE_ID, remotePath: "/srv/app" });
  const text = service.remoteWorkspacePromptFor({});
  assert.match(text, /Remote workspace/);
  assert.match(text, /\/srv\/app/);
  assert.match(text, /web-prod/);
  assert.equal(makeService().remoteWorkspacePromptFor({}), "", "an unbound workspace adds nothing to the prompt");
}

console.log("remote workspace service: panel RPCs, path resolution and connection gating passed");
