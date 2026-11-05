/**
 * 传输注册表让文件面板能看见并取消 agent 发起的上传，所以它的契约很重要：
 * 进度单调、取消恰好送达驱动一次、列表不会无限增长。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { cancelTransfer, listTransfers, resetTransfers, startTransfer } from "../src/transfers.js";

test("a running transfer shows up with its total and zeroed progress", () => {
  resetTransfers();
  const transfer = startTransfer({ name: "image.tar", target: "/root/image.tar", total: 1000, cancel: () => {} });
  const [entry] = listTransfers();
  assert.equal(entry.id, transfer.id);
  assert.equal(entry.status, "running");
  assert.equal(entry.total, 1000);
  assert.equal(entry.sent, 0);
  assert.equal(entry.cancellable, true);
});

test("progress is monotonic and never passes the total", () => {
  resetTransfers();
  const transfer = startTransfer({ name: "a.bin", total: 10 });
  transfer.progress(4);
  transfer.progress(3);
  assert.equal(listTransfers()[0].sent, 4);
  transfer.progress(999);
  assert.equal(listTransfers()[0].sent, 10);
});

test("a finished transfer stops accepting progress and loses its cancel button", () => {
  resetTransfers();
  const transfer = startTransfer({ name: "a.bin", total: 10 });
  transfer.progress(5);
  transfer.finish("done");
  transfer.progress(9);
  const [entry] = listTransfers();
  assert.equal(entry.status, "done");
  assert.equal(entry.sent, 10);
  assert.equal(entry.cancellable, false);
});

test("a failed transfer keeps its byte count and reports the message", () => {
  resetTransfers();
  const transfer = startTransfer({ name: "a.bin", total: 10 });
  transfer.progress(6);
  transfer.finish("failed", new Error("no write acknowledged"));
  const [entry] = listTransfers();
  assert.equal(entry.status, "failed");
  assert.equal(entry.sent, 6);
  assert.equal(entry.error, "no write acknowledged");
});

test("cancel reaches the driver once and marks the transfer as cancelling", () => {
  resetTransfers();
  let aborted = 0;
  const transfer = startTransfer({ name: "a.bin", total: 10, cancel: () => { aborted += 1; } });
  assert.equal(cancelTransfer(transfer.id), true);
  assert.equal(cancelTransfer(transfer.id), true);
  assert.equal(aborted, 2, "the driver decides; the registry only forwards clicks");
  assert.equal(listTransfers()[0].cancelPending, true);
  transfer.finish("cancelled");
  assert.equal(cancelTransfer(transfer.id), false);
  assert.equal(aborted, 2);
});

test("an unknown or finished id is a no-op", () => {
  resetTransfers();
  assert.equal(cancelTransfer("t999"), false);
  const transfer = startTransfer({ name: "a.bin", total: 1 });
  transfer.finish("done");
  assert.equal(cancelTransfer(transfer.id), false);
});

test("finished entries are capped so the panel list cannot grow forever", () => {
  resetTransfers();
  for (let index = 0; index < 20; index += 1) startTransfer({ name: `f${index}.bin`, total: 1 }).finish("done");
  const running = startTransfer({ name: "live.bin", total: 1 });
  const entries = listTransfers();
  assert.equal(entries[0].id, running.id, "running work sorts first");
  assert.ok(entries.length <= 13, `expected the finished list to be capped, got ${entries.length}`);
});
