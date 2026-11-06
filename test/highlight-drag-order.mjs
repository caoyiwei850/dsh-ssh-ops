import { test } from "node:test";
import assert from "node:assert/strict";
import { dropSlot, dropIndex, previewOrder, previewShifts, insertionOffset } from "../src/client/terminal-display/drag-order.js";

const rows = [
  { id: "a", top: 0, height: 50 },
  { id: "b", top: 50, height: 40 },
  { id: "c", top: 90, height: 60 },
  { id: "d", top: 150, height: 50 }
];

test("drop slot resolves pointer positions above, inside (both halves) and below the rows", () => {
  assert.deepEqual(dropSlot([], 10), null);
  assert.deepEqual(dropSlot(rows, -1), { id: "a", side: "before" });
  assert.deepEqual(dropSlot(rows, 10), { id: "a", side: "before" });
  assert.deepEqual(dropSlot(rows, 40), { id: "a", side: "after" });
  assert.deepEqual(dropSlot(rows, 60), { id: "b", side: "before" });
  assert.deepEqual(dropSlot(rows, 140), { id: "c", side: "after" });
  assert.deepEqual(dropSlot(rows, 400), { id: "d", side: "after" });
});

test("drop index removes the dragged row from its slot before landing", () => {
  // dragging "a" down below "b": a,b -> b,a
  assert.equal(dropIndex(rows, "a", { id: "b", side: "after" }), 1);
  // dragging "a" down to just after itself is a no-op
  assert.equal(dropIndex(rows, "a", { id: "a", side: "after" }), 0);
  // dragging "c" up before "a"
  assert.equal(dropIndex(rows, "c", { id: "a", side: "before" }), 0);
  // dragging "b" up before "a" stays first
  assert.equal(dropIndex(rows, "b", { id: "a", side: "before" }), 0);
  // dragging "a" below "d"
  assert.equal(dropIndex(rows, "a", { id: "d", side: "after" }), 3);
  assert.equal(dropIndex(rows, "missing", { id: "a", side: "before" }), -1);
  assert.equal(dropIndex(rows, "a", null), -1);
});

test("the preview order removes the dragged row and re-inserts it at the slot", () => {
  assert.deepEqual(previewOrder(rows, "a", { id: "c", side: "after" }).map((row) => row.id), ["b", "c", "a", "d"]);
  assert.deepEqual(previewOrder(rows, "d", { id: "b", side: "before" }).map((row) => row.id), ["a", "d", "b", "c"]);
  assert.deepEqual(previewOrder(rows, "b", { id: "b", side: "before" }).map((row) => row.id), ["a", "b", "c", "d"]);
  assert.equal(previewOrder(rows, "missing", { id: "a", side: "before" }), null);
});

test("preview shifts move the placeholder into the slot and close the old one", () => {
  // a (h50) is dragged below c: b and c slide up by a's height, a itself moves down 100
  assert.deepEqual([...previewShifts(rows, "a", { id: "c", side: "after" })], [["b", -50], ["c", -50], ["a", 100]]);
  // d (h50) is dragged before b: d moves up 100, b and c slide down 50
  assert.deepEqual([...previewShifts(rows, "d", { id: "b", side: "before" })], [["d", -100], ["b", 50], ["c", 50]]);
  // no-op drops do not move anything
  assert.equal(previewShifts(rows, "a", { id: "a", side: "after" }).size, 0);
  assert.equal(previewShifts(rows, "b", { id: "b", side: "before" }).size, 0);
  assert.equal(previewShifts(rows, "missing", { id: "a", side: "before" }).size, 0);
  assert.equal(previewShifts([], "a", { id: "a", side: "before" }).size, 0);
});

test("insertion line sits at the moved row's new top and disappears for no-op drops", () => {
  // preview order a->after c is [b, c, a, d]: b=0..40, c=40..100, a starts at 100
  assert.equal(insertionOffset(rows, "a", { id: "c", side: "after" }), 100);
  // preview order d->before b is [a, d, b, c]: d starts at 50
  assert.equal(insertionOffset(rows, "d", { id: "b", side: "before" }), 50);
  assert.equal(insertionOffset(rows, "a", { id: "a", side: "after" }), null);
  assert.equal(insertionOffset([], "a", { id: "a", side: "before" }), null);
});
