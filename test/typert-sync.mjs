// Drift guard for the hand-maintained TYPERT declarations: the descriptor
// table (one source of truth for the wire contract) and the type strings in
// src/typert.js must keep naming the same types, and the DB driver union in
// the declarations must equal the zod enum the host actually validates
// against. Adding a driver type to schemas without updating the declarations
// (or vice versa) is exactly the class of bug this catches.
import assert from "node:assert/strict";
import { TYPERT } from "../src/typert.js";
import { DESCRIPTORS } from "../src/descriptors.js";
import { dbTypeSchema } from "../src/schemas.js";

const types = new Map(TYPERT.model.services[0].types.map((entry) => [entry.name, entry.declaration]));
const members = TYPERT.model.services[0].members.map((member) => member.name);

// ── every descriptor names types that exist, in both directions ─────────────
const referenced = new Set();
for (const descriptor of DESCRIPTORS) {
  const names = [
    ...descriptor.parameters.map((parameter) => parameter.codec.typeSymbol.split("#").pop()),
    descriptor.result.typeSymbol.split("#").pop()
  ];
  for (const name of names) {
    referenced.add(name);
    assert.ok(types.has(name), `descriptor ${descriptor.id} references undeclared type ${name}`);
  }
}
// Nested/shared shapes (DbColumn, KnownHostInfo, …) are referenced from other
// declarations rather than from a descriptor directly; a type that appears
// nowhere at all is dead weight and must go.
for (const [name, declaration] of types) {
  if (referenced.has(name)) continue;
  const mentionedElsewhere = [...types.entries()].some(
    ([other, otherDeclaration]) => other !== name && new RegExp(`\\b${name}\\b`).test(otherDeclaration)
  );
  assert.ok(mentionedElsewhere, `declared type ${name} is referenced by nothing`);
  void declaration;
}

// ── every descriptor has a service member entry ─────────────────────────────
for (const descriptor of DESCRIPTORS) {
  assert.ok(members.includes(descriptor.method), `descriptor ${descriptor.id} has no member row for ${descriptor.method}`);
}

// ── the DB driver unions match the validated enum ───────────────────────────
const union = dbTypeSchema.options.map((value) => `'${value}'`).join(" | ");
for (const name of ["DbConnectRequest", "DbConnectResult", "DbConnectionInfo", "DbProfileSaveRequest", "DbProfileInfo"]) {
  const declaration = types.get(name);
  assert.ok(declaration.includes(union), `${name} must carry the driver union ${union}`);
}

// ── a SQLite-capable connect request leaves host/port optional ──────────────
for (const name of ["DbConnectRequest", "DbProfileSaveRequest"]) {
  const declaration = types.get(name);
  assert.ok(/readonly host\?: string/.test(declaration), `${name} must let host be absent (SQLite)`);
  assert.ok(/readonly port\?: number/.test(declaration), `${name} must let port be absent (SQLite)`);
}

console.log("typert sync: descriptor references, member rows and driver unions all match");
