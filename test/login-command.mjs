// Saved login command: schema validation, profile round-trip, and the
// openSession branch that opens the terminal through exec+pty instead of the
// login shell when the resource carries a loginCommand. Runs the real service
// methods over prototype stubs — no ssh2 transport involved.
import assert from "node:assert/strict";
import SshOpsService from "../src/index.js";
import { profileSaveRequestSchema, profileInfoSchema } from "../src/schemas.js";

// ── schema: single line, bounded, no control characters ──
{
  const base = { name: "web-1", host: "10.0.0.5", username: "root", authKind: "password" };
  assert.equal(profileSaveRequestSchema.safeParse({ ...base, loginCommand: "bash -l" }).success, true);
  assert.equal(profileSaveRequestSchema.safeParse({ ...base, loginCommand: "cd /srv/app && exec bash -l" }).success, true);
  assert.equal(profileSaveRequestSchema.safeParse({ ...base, loginCommand: null }).success, true, "explicit null clears");
  assert.equal(profileSaveRequestSchema.safeParse({ ...base, loginCommand: "" }).success, false, "empty string is not a command");
  assert.equal(profileSaveRequestSchema.safeParse({ ...base, loginCommand: "bash -l\r\nrm -rf /" }).success, false, "newline would be ambiguous about what runs");
  assert.equal(profileSaveRequestSchema.safeParse({ ...base, loginCommand: "bash\x00 -l" }).success, false, "control characters rejected");
  assert.equal(profileSaveRequestSchema.safeParse({ ...base, loginCommand: "x".repeat(1025) }).success, false, "length cap");
  assert.equal(profileInfoSchema.safeParse({ ...base, hostKeyMode: "accept-new", secondaryConfigured: false, credentialConfigured: true, passphraseConfigured: false, connected: false, profileId: "00000000-0000-0000-0000-000000000000", groupId: null, groupName: null, credentialId: null, credentialName: null, proxyJump: [], defaultProjectPath: null, agentForward: false, loginCommand: "bash -l" }).success, true);
}

function fakeTable(entries = []) {
  const map = new Map(entries);
  return {
    get: (id) => map.get(id),
    put: (id, record) => { map.set(id, record); },
    delete: (id) => { map.delete(id); },
    entries: () => [...map.entries()]
  };
}

// ── profileSave round-trip: persist, preserve on omission, clear on null ──
{
  const service = Object.create(SshOpsService.prototype);
  const table = fakeTable();
  service.requireProfileTable = () => table;
  service.requireCredentialTable = () => fakeTable();
  service.requireGroupTable = () => fakeTable();
  service.ctx = { credentials: { describe: async () => ({ configured: false }) } };
  service.connections = new Map();

  const base = { name: "web-1", host: "10.0.0.5", port: 22, username: "root", authKind: "password" };
  const saved = await service.profileSave({ ...base, loginCommand: "bash -l" });
  assert.equal(saved.ok, true);
  assert.equal(saved.value.profile.loginCommand, "bash -l", "saved value round-trips");
  assert.equal(table.entries()[0][1].loginCommand, "bash -l", "persists as ordinary profile metadata");

  const untouched = await service.profileSave({ profileId: saved.value.profile.profileId, ...base });
  assert.equal(untouched.value.profile.loginCommand, "bash -l", "omitted field preserves the saved command");

  const cleared = await service.profileSave({ profileId: saved.value.profile.profileId, ...base, loginCommand: null });
  assert.equal(cleared.value.profile.loginCommand, null, "explicit null clears");

  const legacy = await service.profileSave({ name: "old", host: "h2", username: "u", authKind: "key" });
  assert.equal(legacy.value.profile.loginCommand, null, "records without the field resolve to null");
}

// ── openSession: exec+pty when a login command is saved, plain shell otherwise ──
function makeSessionService(table) {
  const service = Object.create(SshOpsService.prototype);
  service.config = { maxBufferBytes: 65536, maxCaptureBytes: 65536 };
  service.connections = new Map();
  service.sessions = new Map();
  service.exitedSessions = new Map();
  service.activeConnectionId = null;
  service.requireProfileTable = () => table;
  service.ensureAlive = async () => true;
  return service;
}

function fakeClient(mode) {
  const calls = [];
  const open = (kind, payload, cb) => {
    calls.push([kind, payload]);
    if (mode === `${kind}-fail`) { cb(new Error("channel refused")); return; }
    const handlers = {};
    const stream = { handlers, on(event, fn) { handlers[event] = fn; }, write() {}, setWindow() {} };
    cb(null, stream);
  };
  return {
    calls,
    shell(opts, cb) { open("shell", opts, cb); },
    exec(command, opts, cb) { open("exec", { command, opts }, cb); }
  };
}

function attachConnection(service, client, profileId = undefined) {
  const conn = {
    id: "c1", profileId, client,
    name: "web-1", host: "10.0.0.5", username: "root",
    connectConfig: { host: "10.0.0.5", port: 22 },
    sessions: new Set(), dead: false, closing: false
  };
  service.connections.set("c1", conn);
  return conn;
}

{
  const table = fakeTable([["00000000-0000-0000-0000-000000000001", { loginCommand: "bash -l" }]]);
  const service = makeSessionService(table);
  const client = fakeClient();
  attachConnection(service, client, "00000000-0000-0000-0000-000000000001");

  const opened = await service.openSession({ connectionId: "c1", cols: 120, rows: 40 });
  assert.equal(opened.ok, true, opened.error?.message);
  assert.deepEqual(client.calls.map(([kind]) => kind), ["exec"], "login command opens through exec, not shell");
  const [, exec] = client.calls[0];
  assert.equal(exec.command, "bash -l");
  assert.deepEqual(exec.opts.pty, { term: "xterm-256color", cols: 120, rows: 40 }, "pty carries the same term/geometry a shell channel gets");

  // No saved command → the server's own login shell, unchanged.
  const plain = makeSessionService(table);
  const plainClient = fakeClient();
  attachConnection(plain, plainClient, "00000000-0000-0000-0000-000000000002");
  const openedPlain = await plain.openSession({ connectionId: "c1" });
  assert.equal(openedPlain.ok, true, openedPlain.error?.message);
  assert.deepEqual(plainClient.calls.map(([kind]) => kind), ["shell"], "no login command keeps the plain shell channel");

  // Temporary/agent connections carry no profileId at all.
  const temp = makeSessionService(table);
  const tempClient = fakeClient();
  attachConnection(temp, tempClient);
  const openedTemp = await temp.openSession({ connectionId: "c1" });
  assert.equal(openedTemp.ok, true, openedTemp.error?.message);
  assert.deepEqual(tempClient.calls.map(([kind]) => kind), ["shell"], "connections without a saved resource keep the login shell");
}

{
  // A refused exec request must fail the session open (not silently fall back
  // to a shell the user asked to bypass) and must not leak the session.
  const table = fakeTable([["00000000-0000-0000-0000-000000000001", { loginCommand: "bash -l" }]]);
  const service = makeSessionService(table);
  const client = fakeClient("exec-fail");
  const conn = attachConnection(service, client, "00000000-0000-0000-0000-000000000001");

  const refused = await service.openSession({ connectionId: "c1" });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "shell-failed");
  assert.match(refused.error.message, /login command: bash -l/, "the failing command is named in the error");
  assert.equal(service.sessions.size, 0, "failed open leaves no session behind");
  assert.equal(conn.sessions.size, 0);
}

console.log("login command: schema, save round-trip, exec+pty open branch: passed");
