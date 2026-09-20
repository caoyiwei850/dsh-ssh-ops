/**
 * Contract test: every registered db tool's declared output schema must accept
 * the payload the service actually produces.
 *
 * Regression for `db_list_connections`: `DbOpsManager.list()` has always
 * returned `username`, but the tool's item schema never declared it. Because
 * the item carries `additionalProperties: false`, the DSH output validator
 * rejected the *entire* result with
 *   "value.connections[0].username" is not a declared property
 * and the tool failed on every call that had at least one open connection —
 * while passing trivially with zero connections, which is why it went unnoticed.
 *
 * The test drives the real `list()` implementation (borrowed onto a stub
 * receiver so no driver/socket is needed) and validates its output against the
 * schema `defineTool` will hand to the runtime validator, so either side
 * drifting again fails CI.
 */
import assert from "node:assert/strict";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { DbOpsManager } from "../src/db-ops.js";
import { registerDbTools } from "../src/tools/db.js";

/** Minimal ctx that captures whatever the db tools register. */
function captureTools() {
  const tools = new Map();
  const ctx = { tools: { register: (tool) => tools.set(tool.name, tool) } };
  registerDbTools(ctx, {}); // service is never reached by this test
  return tools;
}

const tools = captureTools();

// ── db_list_connections: declared schema must accept list()'s real output ────

const tool = tools.get("db_list_connections");
assert.ok(tool, "db_list_connections must be registered");

const itemProps = tool.output.schema.properties.connections.items.properties;

// The exact shape DbOpsManager.list() emits, one of each nullability.
const records = [
  {
    id: "db-aaaaaaaa",
    name: "postgresql:10.0.0.1",
    type: "postgresql",
    config: { host: "10.0.0.1", port: 9999, database: "ngsoc", username: "postgres", ssl: "disabled", sshConnectionId: null },
    createdAt: "2026-09-20T09:04:52.699Z"
  },
  {
    id: "db-bbbbbbbb",
    name: "postgresql:127.0.0.1",
    type: "postgresql",
    config: { host: "127.0.0.1", port: 5432, database: null, username: null, ssl: "verify", sshConnectionId: "conn-1" },
    createdAt: "2026-09-20T09:12:00.000Z"
  }
];

// Borrow the real implementation; `list()` only touches `this.dbConnections`.
const fakeThis = { dbConnections: new Map(records.map((r) => [r.id, r])) };
const listed = DbOpsManager.prototype.list.call(fakeThis);
assert.equal(listed.ok, true);

const payload = listed.value;
assert.equal(payload.connections.length, 2);

// 1) The runtime validator (dsh-tools/lib/index.js validates tool.output.schema)
//    must accept the real payload verbatim.
const violations = validateJsonSchemaValue(tool.output.schema, payload, "value");
assert.deepEqual(violations, [], `declared schema rejects the real payload:\n${violations.join("\n")}`);

// 2) Pin the key set both ways, so the failure message says exactly what drifted.
const declared = Object.keys(itemProps).sort();
const returned = Object.keys(payload.connections[0]).sort();
assert.deepEqual(
  declared,
  returned,
  "db_list_connections schema properties must match DbOpsManager.list() keys"
);

// 3) `username` specifically — the field this regression is about.
assert.ok(declared.includes("username"), "username must be declared in the item schema");
assert.ok(
  (tool.output.schema.properties.connections.items.required ?? []).includes("username"),
  "username must be a required item property"
);

// 4) Every declared property is nullable-compatible with what list() may emit:
//    a null value must not be rejected for the fields list() nulls out.
for (const key of ["database", "username", "sshConnectionId"]) {
  const nullPayload = { connections: [{ ...payload.connections[0], [key]: null }] };
  assert.deepEqual(
    validateJsonSchemaValue(tool.output.schema, nullPayload, "value"),
    [],
    `${key}=null must be accepted (list() coerces it to null)`
  );
}

// 5) render() must surface the account, otherwise a fixed schema still hides it.
const rendered = tool.output.render({}, payload).map((part) => part.text).join("\n");
assert.ok(rendered.includes("postgres"), `render() should show the username, got:\n${rendered}`);

// 6) Empty state still renders its dedicated message.
const empty = tools.get("db_list_connections").output.render({}, { connections: [] });
assert.equal(empty[0].text, "No database connection is currently open.");

console.log("db tool output schemas: all cases passed");
