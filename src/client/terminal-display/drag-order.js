/**
 * Pure geometry for the pointer drag-reorder of color-scheme rows.
 *
 * The dialog measures the rows once when a drag starts (their top/height in the
 * scroll container's content coordinates) and this module turns the pointer
 * position into a drop slot plus the per-row shift that previews it. Keeping
 * this free of React/DOM lets the ordering rules be unit-tested and keeps the
 * drag hot path to arithmetic only.
 */

/**
 * Resolve the pointer position to the row/side it would drop into.
 * `rows` is ordered top to bottom: `[{ id, top, height }]` where `top` is in the
 * scroll container's content coordinates (already scroll-corrected).
 * Returns `{ id, side: "before" | "after" }`, or null when there are no rows.
 */
export function dropSlot(rows, pointerY) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const first = rows[0], last = rows[rows.length - 1];
  if (pointerY < first.top) return { id: first.id, side: "before" };
  if (pointerY >= last.top + last.height) return { id: last.id, side: "after" };
  for (const row of rows) {
    const middle = row.top + row.height / 2;
    if (pointerY < row.top + row.height) return { id: row.id, side: pointerY < middle ? "before" : "after" };
  }
  return { id: last.id, side: "after" };
}

/**
 * Index a dragged row would occupy after the drop. The dragged row is removed
 * from its current slot before the target index is computed, so dropping just
 * below its own position is a no-op rather than an off-by-one move.
 */
export function dropIndex(rows, draggedId, slot) {
  if (!Array.isArray(rows) || rows.length === 0 || !slot) return -1;
  const sourceIndex = rows.findIndex((row) => row.id === draggedId);
  const targetIndex = rows.findIndex((row) => row.id === slot.id);
  if (sourceIndex < 0 || targetIndex < 0) return -1;
  let index = slot.side === "after" ? targetIndex + 1 : targetIndex;
  if (index > sourceIndex) index -= 1;
  return Math.max(0, Math.min(rows.length - 1, index));
}

/** The visual order after the drop (dragged row removed then re-inserted). */
export function previewOrder(rows, draggedId, slot) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const sourceIndex = rows.findIndex((row) => row.id === draggedId);
  const targetIndex = dropIndex(rows, draggedId, slot);
  if (sourceIndex < 0 || targetIndex < 0) return null;
  const order = rows.slice();
  const [moved] = order.splice(sourceIndex, 1);
  order.splice(targetIndex, 0, moved);
  return order;
}

/**
 * Per-row vertical shift for the preview: the placeholder itself moves to the
 * drop slot and the rows in between slide to close its old slot and open the
 * new one, so exactly one gap exists and no two rows overlap.
 * Returns `Map<id, pixels>` for every row that moves (including the dragged
 * row). No-op drops produce an empty map.
 *
 * Rows may have different heights (tags wrap), so the previewed position is
 * accumulated from each row's height instead of multiplying the dragged row's
 * height by a row count.
 */
export function previewShifts(rows, draggedId, slot) {
  const shifts = new Map();
  const order = previewOrder(rows, draggedId, slot);
  if (!order) return shifts;
  const start = rows[0].top;
  const previousTop = new Map(rows.map((row) => [row.id, row.top]));
  let top = start;
  for (const row of order) {
    const shift = top - previousTop.get(row.id);
    if (shift) shifts.set(row.id, shift);
    top += row.height;
  }
  return shifts;
}

/**
 * Y coordinate (content coordinates) of the drop slot in the previewed order —
 * the top edge of the moved row's new position. Returns null for no-op drops.
 */
export function insertionOffset(rows, draggedId, slot) {
  if (dropIndex(rows, draggedId, slot) === rows.findIndex((row) => row.id === draggedId)) return null;
  const order = previewOrder(rows, draggedId, slot);
  if (!order) return null;
  let top = rows[0].top;
  for (const row of order) {
    if (row.id === draggedId) return top;
    top += row.height;
  }
  return null;
}
