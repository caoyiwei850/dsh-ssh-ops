/**
 * 剧本化的链路演练。让真实的上传引擎跑在一个内存 SFTP 上，所以唯一变化的就是
 * 链路本身：健康 -> 塌陷 -> 恢复。没有网络、没有服务器、没有时钟漂移 ——
 * 每次都跑出同样的结果。
 *
 *   node test/link-drill.mjs
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadPipelined, PIPELINE_DEFAULTS } from "../src/sftp-push.js";

const MIB = 1024 * 1024;
const PHASES = [
  { from: 0, to: 2, mbps: 4, label: "healthy   4 MiB/s" },
  { from: 2, to: 10, mbps: 0.3, label: "collapsed 0.3 MiB/s" },
  { from: 10, to: Infinity, mbps: 4, label: "recovered 4 MiB/s" }
];
const phaseAt = (seconds) => PHASES.find((p) => seconds >= p.from && seconds < p.to) ?? PHASES.at(-1);

const dir = mkdtempSync(join(tmpdir(), "link-drill-"));
const localFile = join(dir, "payload.bin");
const SIZE = 16 * MIB;
writeFileSync(localFile, Buffer.alloc(SIZE, 7));

const store = Buffer.alloc(SIZE);
const startedAt = Date.now();
let nextAt = 0;
const queue = [];
let timer = null;
let busy = false;

const pump = () => {
  if (busy) return;
  busy = true;
  for (;;) {
    if (!queue.length) {
      busy = false;
      return;
    }
    const now = Date.now();
    if (now < nextAt) {
      timer = setTimeout(pump, nextAt - now);
      busy = false;
      return;
    }
    const item = queue.shift();
    const limit = phaseAt((now - startedAt) / 1000);
    nextAt = now + (item.length / (limit.mbps * MIB)) * 1000;
    item.deliver();
  }
};

const sftp = {
  open: (_path, _flags, cb) => setTimeout(() => cb(null, 1), 1),
  close: (_handle, cb) => cb(null),
  write: (_handle, buffer, offset, length, position, cb) => {
    buffer.copy(store, position, offset, offset + length);
    queue.push({ length, deliver: () => cb(null) });
    if (!busy) pump();
  }
};

let lastPrint = 0;
const stats = await uploadPipelined({
  sftp,
  localFile,
  remotePath: "/dev/null",
  size: SIZE,
  options: { ...PIPELINE_DEFAULTS },
  onProgress: (acked, total, live) => {
    const now = Date.now();
    if (now - lastPrint < 1000 && acked < total) return;
    lastPrint = now;
    const seconds = (now - startedAt) / 1000;
    console.log(
      `  ${seconds.toFixed(1).padStart(5)}s  ${(acked / MIB).toFixed(2).padStart(6)} MiB  ` +
        `${((acked / MIB) / seconds).toFixed(2).padStart(5)} MiB/s  win ${String(live.conc).padStart(3)}  ` +
        `stalls ${live.stalls}   ${phaseAt(seconds).label}`
    );
  }
});
if (timer) clearTimeout(timer);

const expected = Buffer.alloc(SIZE, 7);
const identical = store.equals(expected);
rmSync(dir, { recursive: true, force: true });
console.log(
  `\n${(stats.bytes / MIB).toFixed(2)} MiB in ${stats.seconds.toFixed(1)}s  ` +
    `peak window ${stats.peakConcurrency}  stalls ${stats.stalls ?? 0}  bytes ${identical ? "match" : "CORRUPT"}`
);
process.exit(identical ? 0 : 1);
