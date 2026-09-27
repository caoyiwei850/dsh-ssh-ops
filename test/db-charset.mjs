// MySQL text columns whose charset the server reports as binary/unknown come
// back from mysql2 as Buffers. The single value serializer must decode them
// as UTF-8 on EVERY result path (query/preview/export/run/tx) — this pins the
// serializer itself; the paths all funnel through it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeDbValue } from "../src/db-ops.js";
import { toCsv, toJson } from "../src/db-drivers.js";

test("buffers with unknown-charset text decode as UTF-8", () => {
  assert.equal(serializeDbValue(Buffer.from("hello", "utf8")), "hello");
  assert.equal(serializeDbValue(Buffer.from("中文文本", "utf8")), "中文文本");
  assert.equal(serializeDbValue(Buffer.from("emoji \u{1F600}", "utf8")), "emoji \u{1F600}");
});

test("binary garbage degrades to a lossy string instead of an object or crash", () => {
  const value = serializeDbValue(Buffer.from([0xff, 0xfe, 0xfa]));
  assert.equal(typeof value, "string");
  assert.ok(value.length >= 1, "replacement characters still surface something readable");
});

test("non-buffer driver scalars keep their JSON shape", () => {
  assert.equal(serializeDbValue(42n), "42");
  assert.equal(serializeDbValue(undefined), null);
  assert.equal(serializeDbValue(new Date(Date.UTC(2026, 0, 2, 3, 4, 5))), "2026-01-02T03:04:05.000Z");
  assert.deepEqual(serializeDbValue({ a: 1 }), { a: 1 });
  assert.equal(serializeDbValue(null), null);
});

test("csv/json export receive already-decoded strings", () => {
  const rows = [{ name: Buffer.from("café") }];
  const columns = ["name"];
  const csv = toCsv(columns, rows.map(serializeDbValue));
  assert.match(csv, /café/);
  const json = toJson(columns, rows.map(serializeDbValue));
  assert.match(json, /café/);
});
