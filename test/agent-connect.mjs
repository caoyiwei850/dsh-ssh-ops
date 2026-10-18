// Agent auto-connect (issue #25): the operator's switch that lets the agent
// connect a *saved* SSH resource by name — ssh_connect_profile — plus the
// structured no-connection guidance that tells the agent which resources exist
// instead of a bare `connection "dev" does not exist`.
import assert from "node:assert/strict";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import SshOpsService, { loadSettingsRecord, normalizeDefaultUsername } from "../src/index.js";
import { registerSshSessionTools } from "../src/tools/ssh-session.js";
import { resolveProfileRef, noConnectionGuidance, formatSavedResources, AUTO_CONNECT_DISABLED_MESSAGE } from "../src/agent-connect.js";
import { agentSettingsGetRequestSchema, agentSettingsSaveRequestSchema, agentSettingsResultSchema, listResultSchema } from "../src/schemas.js";

const PROFILES = [
  { profileId: "11111111-1111-1111-1111-111111111111", name: "dev", host: "dev.example.test", port: 22, username: "deploy" },
  { profileId: "22222222-2222-2222-2222-222222222222", name: "Data", host: "data.example.test", port: 22, username: "root" },
  { profileId: "33333333-3333-3333-3333-333333333333", name: "prod-1", host: "10.1.0.1", port: 22, username: "root" },
  { profileId: "44444444-4444-4444-4444-444444444444", name: "prod-2", host: "10.1.0.2", port: 22, username: "root" }
];

// ── resolveProfileRef: id, exact name, unique substring, ambiguity ──────────
{
  const exactId = resolveProfileRef(PROFILES, "22222222-2222-2222-2222-222222222222");
  assert.equal(exactId.ok, true);
  assert.equal(exactId.name, "Data");

  const exactName = resolveProfileRef(PROFILES, "dev");
  assert.equal(exactName.ok, true);
  assert.equal(exactName.profileId, "11111111-1111-1111-1111-111111111111");

  const caseInsensitive = resolveProfileRef(PROFILES, "DATA");
  assert.equal(caseInsensitive.ok, true);
  assert.equal(caseInsensitive.profileId, "22222222-2222-2222-2222-222222222222");

  const substring = resolveProfileRef(PROFILES, "prod-1");
  assert.equal(substring.ok, true);

  const ambiguousName = resolveProfileRef(PROFILES, "prod");
  assert.equal(ambiguousName.ok, false);
  assert.equal(ambiguousName.code, "profile-ambiguous");
  assert.match(ambiguousName.message, /prod-1, prod-2/);

  const noMatch = resolveProfileRef(PROFILES, "staging");
  assert.equal(noMatch.ok, false);
  assert.equal(noMatch.code, "no-profile");
  assert.match(noMatch.message, /Available resources: Data, dev, prod-1, prod-2/);

  const empty = resolveProfileRef(PROFILES, "  ");
  assert.equal(empty.ok, false);
  assert.match(empty.message, /no saved SSH resource was given/);

  const noResourcesAtAll = resolveProfileRef([], "dev");
  assert.equal(noResourcesAtAll.ok, false);
  assert.match(noResourcesAtAll.message, /\(none\)/);
}

// ── guidance text: names the ask, lists resources, switch-dependent hint ────
{
  const off = noConnectionGuidance("dev", ["dev", "prod"], false);
  assert.match(off, /connection "dev" does not exist/);
  assert.doesNotMatch(off, /dev, prod|Saved SSH resources/, "disabled means saved names stay private even in errors");
  assert.doesNotMatch(off, /ssh_connect_profile/);
  assert.match(off, /Ask the operator/);

  const on = noConnectionGuidance("dev", ["dev", "prod"], true);
  assert.match(on, /Call ssh_connect_profile/);

  const nothingOpen = noConnectionGuidance(undefined, [], false);
  assert.match(nothingOpen, /no active SSH connection/);
  assert.doesNotMatch(nothingOpen, /saved SSH resources/i);

  const nothingOpenOn = noConnectionGuidance(undefined, ["prod"], true);
  assert.match(nothingOpenOn, /Call ssh_connect_profile/);

  assert.equal(formatSavedResources([]), "(none)");
  assert.equal(formatSavedResources(["a", "b"]), "a, b");
}

function makeService({ profiles = PROFILES, connections = [], agentAutoConnect = false, settings = null } = {}) {
  const service = Object.create(SshOpsService.prototype);
  service.connections = new Map(connections);
  service.activeConnectionId = null;
  service.agentAutoConnect = agentAutoConnect;
  service.profileTable = {
    get: (id) => profiles.find((profile) => profile.profileId === id),
    entries: () => profiles.map((profile) => [profile.profileId, profile])[Symbol.iterator](),
    values: () => profiles[Symbol.iterator]()
  };
  service.settingsTable = {
    stored: settings,
    get: (_id) => service.settingsTable.stored,
    put: async (_id, record) => { service.settingsTable.stored = record; }
  };
  return service;
}

function connection(id, overrides = {}) {
  return { id, profileId: null, host: "10.0.0.5", port: 22, username: "root", dead: false, closing: false, connecting: false, sessions: new Set(["s1"]), ...overrides };
}

// ── list(): saved resources only reach the agent with the switch on ─────────
{
  const off = makeService({ agentAutoConnect: false, connections: [["c1", connection("c1", { profileId: "11111111-1111-1111-1111-111111111111" })]] });
  const offResult = await off.list();
  assert.equal(offResult.ok, true);
  assert.equal(offResult.value.resources, undefined, "with the switch off the agent sees no saved resources");

  const on = makeService({ agentAutoConnect: true, connections: [["c1", connection("c1", { profileId: "22222222-2222-2222-2222-222222222222" })]] });
  const onResult = await on.list();
  assert.equal(onResult.ok, true);
  assert.deepEqual(
    onResult.value.resources.map((resource) => `${resource.name}:${resource.connected}`),
    ["Data:true", "dev:false", "prod-1:false", "prod-2:false"],
    "resources carry the connected flag from live profile-bound connections"
  );
  // RPC transport drops nothing here, but the shape must survive a round trip.
  const wire = JSON.parse(JSON.stringify(onResult.value));
  assert.equal(listResultSchema.safeParse({ ok: true, value: wire }).success, true, "list() with resources satisfies the strict wire schema");

  // The surface handshake: a live agent-opened session flags the connection so
  // the browser can auto-reveal the SSH tab; human-opened sessions never do.
  const agentOpened = makeService({ agentAutoConnect: true, connections: [["ca", connection("ca")]] });
  agentOpened.sessions = new Map([["s1", { openedBy: "agent" }]]);
  assert.equal((await agentOpened.list()).value.connections[0].agentSession, true);
  const humanOpened = makeService({ agentAutoConnect: true, connections: [["ch", connection("ch")]] });
  humanOpened.sessions = new Map([["s1", { openedBy: "panel" }]]);
  assert.equal((await humanOpened.list()).value.connections[0].agentSession, undefined, "absent, not false — strict codec drops undefined");
}

// ── no-connection errors now carry the resource inventory ───────────────────
{
  const service = makeService({ agentAutoConnect: false });
  const failed = await service.selectConnection({ connectionId: "dev" });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, "no-connection");
  assert.doesNotMatch(failed.error.message, /Saved SSH resources: Data, dev, prod-1, prod-2/);
  assert.match(failed.error.message, /Ask the operator/);
  assert.equal(service.activeConnectionId, null, "a failed switch still leaves no binding");

  const emptyService = makeService({ profiles: [] });
  const resolved = emptyService.resolveConnection(undefined);
  assert.equal(resolved.ok, false);
  assert.doesNotMatch(resolved.error.message, /saved SSH resources/i);
}

// ── the switch round-trips through the settings table ───────────────────────
{
  const service = makeService();
  assert.equal((await service.agentSettingsGet()).value.agentAutoConnect, false, "default off");
  const saved = await service.agentSettingsSave({ agentAutoConnect: true });
  assert.equal(saved.ok, true);
  assert.equal(saved.value.agentAutoConnect, true);
  assert.equal((await service.agentSettingsGet()).value.agentAutoConnect, true);
  assert.equal(service.settingsTable.stored.agentAutoConnect, true, "the switch survives a host restart via storage");

  service.settingsTable.put = async () => { throw new Error("disk full"); };
  const failed = await service.agentSettingsSave({ agentAutoConnect: false });
  assert.equal(failed.ok, false);
  assert.equal(service.agentAutoConnect, true, "a failed save must preserve the effective permission");

  const wire = JSON.parse(JSON.stringify(saved.value));
  assert.equal(agentSettingsResultSchema.safeParse({ ok: true, value: wire }).success, true);
  assert.equal(agentSettingsGetRequestSchema.safeParse({}).success, true);
  assert.equal(agentSettingsSaveRequestSchema.safeParse({ agentAutoConnect: true }).success, true);
}

// ── default username for new servers (issue #36) ────────────────────────────
{
  // Hardening: trim, blank/absent/non-string → null, capped at 128 chars.
  assert.equal(normalizeDefaultUsername("  deploy "), "deploy");
  assert.equal(normalizeDefaultUsername(""), null);
  assert.equal(normalizeDefaultUsername("   "), null);
  assert.equal(normalizeDefaultUsername(undefined), null);
  assert.equal(normalizeDefaultUsername(42), null);
  assert.equal(normalizeDefaultUsername("x".repeat(200)).length, 128);
  assert.equal(loadSettingsRecord({ defaultUsername: " ubuntu " }).defaultUsername, "ubuntu");
  assert.equal(loadSettingsRecord({}).defaultUsername, null, "records from older builds load as 'no preference'");

  const service = makeService();
  assert.equal((await service.agentSettingsGet()).value.defaultUsername, null, "unset reads as null, never as an empty string");

  const set = await service.agentSettingsSave({ agentAutoConnect: false, defaultUsername: " ubuntu " });
  assert.equal(set.ok, true);
  assert.equal(set.value.defaultUsername, "ubuntu");
  assert.equal(service.settingsTable.stored.defaultUsername, "ubuntu", "the preference survives a host restart via storage");
  assert.equal((await service.agentSettingsGet()).value.defaultUsername, "ubuntu");

  // A save that omits the field (older panes, the policy pill) keeps it.
  const kept = await service.agentSettingsSave({ agentAutoConnect: true });
  assert.equal(kept.value.defaultUsername, "ubuntu");
  assert.equal(service.settingsTable.stored.defaultUsername, "ubuntu");
  assert.equal(kept.value.agentAutoConnect, true);

  // Explicit null (or blank) clears it back to the root fallback.
  const cleared = await service.agentSettingsSave({ agentAutoConnect: true, defaultUsername: "   " });
  assert.equal(cleared.value.defaultUsername, null);
  assert.equal(service.settingsTable.stored.defaultUsername, undefined);
  assert.equal(service.defaultUsername, null);

  assert.equal(agentSettingsSaveRequestSchema.safeParse({ agentAutoConnect: true, defaultUsername: "deploy" }).success, true);
  assert.equal(agentSettingsSaveRequestSchema.safeParse({ agentAutoConnect: true, defaultUsername: null }).success, true, "null is the wire form of 'clear'");
  assert.equal(agentSettingsSaveRequestSchema.safeParse({ agentAutoConnect: true, defaultUsername: "x".repeat(129) }).success, false);
  const wire = JSON.parse(JSON.stringify(set.value));
  assert.equal(agentSettingsResultSchema.safeParse({ ok: true, value: wire }).success, true);
}

// ── profileSave auto-remembers the last-used username (issue #36 feedback) ──
{
  const profiles = [];
  const service = makeService();
  service.profileTable = {
    get: (id) => profiles.find((profile) => profile.profileId === id),
    entries: () => profiles.map((profile) => [profile.profileId, profile])[Symbol.iterator](),
    values: () => profiles[Symbol.iterator](),
    put: async (id, record) => { profiles.push({ profileId: id, ...record }); }
  };
  service.requireCredentialTable = () => ({ get: () => undefined });
  service.requireGroupTable = () => ({ get: () => undefined });
  service.profilePublic = async (id, record) => ({ ...record, profileId: id });

  const saved = await service.profileSave({ name: "web", host: "10.0.0.9", port: 22, username: "  deploy  ", authKind: "password" });
  assert.equal(saved.ok, true);
  assert.equal(service.settingsTable.stored.defaultUsername, "deploy", "the last saved username becomes the next new-server default");
  assert.equal(service.defaultUsername, "deploy");
  assert.equal((await service.agentSettingsGet()).value.defaultUsername, "deploy");

  // 编辑另一台换成别的用户名 → 默认跟随最近一次保存。
  await service.profileSave({ name: "db", host: "10.0.0.8", port: 22, username: "postgres", authKind: "password" });
  assert.equal(service.settingsTable.stored.defaultUsername, "postgres");

  // settingsTable 缺失（桩场景/存储异常）：保存本身不受影响。
  const bare = makeService();
  bare.profileTable = {
    get: () => undefined,
    entries: () => [][Symbol.iterator](),
    values: () => [][Symbol.iterator](),
    put: async () => {}
  };
  bare.requireCredentialTable = () => ({ get: () => undefined });
  bare.requireGroupTable = () => ({ get: () => undefined });
  bare.profilePublic = async (id, record) => ({ ...record, profileId: id });
  bare.settingsTable = undefined;
  const ok = await bare.profileSave({ name: "x", host: "10.0.0.1", port: 22, username: "root", authKind: "password" });
  assert.equal(ok.ok, true, "a missing settings table must not fail the profile save");
}

// ── agentConnectProfile: gated, resolving, and visible ──────────────────────
{
  const gated = makeService({ agentAutoConnect: false });
  const refused = await gated.agentConnectProfile({ resource: "dev" });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "auto-connect-disabled");
  assert.equal(refused.error.message, AUTO_CONNECT_DISABLED_MESSAGE);

  const service = makeService({ agentAutoConnect: true });
  service.profileConnect = async (request) => {
    service.profileConnectCalls = (service.profileConnectCalls ?? 0) + 1;
    assert.equal(request.profileId, "11111111-1111-1111-1111-111111111111");
    assert.equal(request.reuseExisting, true, "an already-open connection for the same resource is reused, not duplicated");
    // connectInternal always registers the live record before returning.
    service.connections.set("new-1", connection("new-1", { profileId: "11111111-1111-1111-1111-111111111111", sessions: new Set() }));
    return { ok: true, value: { connectionId: "new-1", host: "dev.example.test", port: 22, username: "deploy" } };
  };
  service.openSession = async (request) => {
    assert.equal(request.openedBy, "agent");
    return { ok: true, value: { sessionId: "s-new" } };
  };
  const connected = await service.agentConnectProfile({ resource: "DEV" });
  assert.equal(connected.ok, true);
  assert.equal(connected.value.connectionId, "new-1");
  assert.equal(connected.value.name, "dev");
  assert.equal(connected.value.reused, false);
  assert.equal(connected.value.terminalOpened, true, "the operator sees the machine the agent moved to");
  assert.equal(typeof service.connections.get("new-1").agentRevealId, "string");
  assert.equal(service.activeConnectionId, "new-1", "later connection-less tool calls land on the new machine");

  const unknown = await service.agentConnectProfile({ resource: "staging" });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, "no-profile");
  assert.match(unknown.error.message, /Available resources: Data, dev, prod-1, prod-2/);

  const ambiguous = await service.agentConnectProfile({ resource: "prod" });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.error.code, "profile-ambiguous");

  // Already-connected resource: reused, and no duplicate terminal is opened.
  const reuseService = makeService({
    agentAutoConnect: true,
    connections: [["live-1", connection("live-1", { profileId: "33333333-3333-3333-3333-333333333333" })]]
  });
  reuseService.activeConnectionId = null;
  reuseService.profileConnect = async () => ({ ok: true, value: { connectionId: "live-1", host: "10.1.0.1", port: 22, username: "root" } });
  const reused = await reuseService.agentConnectProfile({ resource: "prod-1" });
  assert.equal(reused.ok, true);
  assert.equal(reused.value.reused, true);
  assert.equal(reused.value.terminalOpened, false, "no second terminal for a resource that already has one");
  assert.equal(reuseService.activeConnectionId, "live-1", "reuse still moves the agent binding to that machine");
  const firstReveal = reuseService.connections.get("live-1").agentRevealId;
  assert.equal(typeof firstReveal, "string", "a reused human session must still become visible");
  await reuseService.agentConnectProfile({ resource: "prod-1" });
  assert.notEqual(reuseService.connections.get("live-1").agentRevealId, firstReveal, "a later agent request can reopen a closed pane");

  const failedPty = makeService({ agentAutoConnect: true });
  failedPty.connections.set("previous", connection("previous"));
  failedPty.activeConnectionId = "previous";
  failedPty.profileConnect = async () => {
    failedPty.connections.set("new-pty", connection("new-pty", { sessions: new Set() }));
    failedPty.activeConnectionId = "new-pty";
    return { ok: true, value: { connectionId: "new-pty", host: "h", port: 22, username: "u" } };
  };
  failedPty.openSession = async () => ({ ok: false, error: { code: "shell-failed", message: "PTY refused" } });
  failedPty.disconnect = async ({ connectionId }) => { failedPty.connections.delete(connectionId); return { ok: true }; };
  const invisible = await failedPty.agentConnectProfile({ resource: "dev" });
  assert.equal(invisible.ok, false, "a connection without the promised terminal must fail");
  assert.equal(failedPty.connections.has("new-pty"), false, "a newly opened invisible transport is cleaned up");
  assert.equal(failedPty.activeConnectionId, "previous", "the previous target is restored");
}

// ── agent tool contract: output schemas accept the real service literals ────
// Same guard as #23: one undeclared field and DSH rejects the whole result.
{
  const tools = [];
  registerSshSessionTools({ tools: { register: (tool) => tools.push(tool) } }, {});
  const listTool = tools.find((tool) => tool.name === "ssh_list");
  const connectTool = tools.find((tool) => tool.name === "ssh_connect_profile");
  assert.ok(listTool && connectTool, "both tools are registered");

  const listValue = JSON.parse(JSON.stringify({
    activeConnectionId: null,
    connections: [],
    resources: [{ profileId: "11111111-1111-1111-1111-111111111111", name: "dev", host: "dev.example.test", port: 2222, username: "deploy", connected: false }]
  }));
  // The full ssh_list output schema predates this feature and uses a `oneOf`
  // node the test-side validator cannot walk (DSH's runtime zod handles it
  // fine). Pin the NEW field against the schema exactly as declared instead of
  // re-describing it here.
  assert.deepEqual(
    validateJsonSchemaValue(
      { type: "object", additionalProperties: false, properties: { resources: listTool.output.schema.properties.resources } },
      { resources: listValue.resources },
      "value"
    ),
    [],
    "ssh_list.resources satisfies its declared tool-output schema"
  );
  assert.deepEqual(validateJsonSchemaValue(listTool.output.schema, { activeConnectionId: null, connections: [] }, "value"), [], "the switch-off shape (no resources key) stays valid");
  const realAgentList = makeService({ agentAutoConnect: true, connections: [["agent-c", connection("agent-c", { sessions: new Set(["s1"]) })]] });
  realAgentList.sessions = new Map([["s1", { openedBy: "agent" }]]);
  const actualListValue = JSON.parse(JSON.stringify((await realAgentList.list()).value));
  assert.deepEqual(validateJsonSchemaValue(listTool.output.schema, actualListValue, "value"), [], "the actual agent-session list satisfies the strict tool schema");
  realAgentList.connections.get("agent-c").agentRevealId = "request-1";
  const revealedListValue = JSON.parse(JSON.stringify((await realAgentList.list()).value));
  assert.deepEqual(validateJsonSchemaValue(listTool.output.schema, revealedListValue, "value"), [], "a saved-resource reveal token also satisfies the strict tool schema");
  const listRendered = listTool.output.render({}, listValue)[0].text;
  assert.match(listRendered, /dev → deploy@dev\.example\.test:2222/);
  assert.match(listRendered, /ssh_connect_profile/);

  const connectValue = JSON.parse(JSON.stringify({
    connectionId: "c1", profileId: "11111111-1111-1111-1111-111111111111", name: "dev",
    host: "dev.example.test", port: 22, username: "deploy", reused: false, terminalOpened: true
  }));
  assert.deepEqual(validateJsonSchemaValue(connectTool.output.schema, connectValue, "value"), []);
  assert.deepEqual(validateJsonSchemaValue(connectTool.output.schema, { ...connectValue, warning: "legacy fallback used" }, "value"), [], "the optional warning shape stays valid");
  const connectRendered = connectTool.output.render({}, connectValue)[0].text;
  assert.match(connectRendered, /已连接保存的服务器「dev」/);
  assert.match(connectRendered, /可在右侧 SSH 面板查看/);
  const reusedRendered = connectTool.output.render({}, { ...connectValue, reused: true })[0].text;
  assert.match(reusedRendered, /复用了该服务器已有的连接/);
}

console.log("agent auto-connect: resolution, guidance, gating and tool contracts passed");
