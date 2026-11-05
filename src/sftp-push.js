/**
 * 自适应窗口的 SFTP 上传器。
 *
 * 基于流的 SFTP 写入路径（`createWriteStream`、`fastPut`）每轮往返只放行固定的
 * 少量数据块。在 RTT 数百毫秒的链路上，这会把 40 MiB 的镜像压在几百 KiB/s；而在
 * 有丢包的链路上，塌陷毫无规律：第一次停滞就可能赔上整个文件。本模块直接驱动最
 * 底层的 SFTP 写原语，让一个窗口的数据块同时在途，并用「已确认字节」而不是
 * socket 事件来做 AIMD：
 *
 *   - 只有在 `stallMs` 内一个字节都没被确认时才缩窗，且每次停滞最多缩一次，
 *     这样一次慢往返不会把窗口一路棘轮到底；
 *   - 每 `growMs` 只在确认速率还在变好时扩窗 —— 速率走平或下降就保持当前窗口，
 *     而不是一路试探到停滞为止；
 *   - 单个数据块先在原地退避重试，重试完再让整个传输失败；
 *   - 硬停滞时明确报错，而不是一直挂着；
 *   - 绝不重写已确认的字节，所以续传的代价是最后一个窗口，不是整个文件。
 *
 * `sftp` 是 ssh2 的原始 SFTP 句柄（connection.sftp），不是服务层的包装。
 * 目标路径、原子提交的 rename、远端工作区校验都由调用方负责。
 */
import { openSync, readSync, closeSync } from "node:fs";

/** 文件小于这个尺寸时，一整个窗口的往返开销还不如省掉这些记账。 */
export const MIN_PIPELINE_BYTES = 256 * 1024;

export const PIPELINE_DEFAULTS = Object.freeze({
  chunk: 64 * 1024,
  concStart: 32,
  concMin: 4,
  concMax: 256,
  stallMs: 15_000,
  hardStallMs: 40_000,
  retries: 2,
  tickMs: 500,
  growMs: 500,
  shrinkRatio: 0.7,
  growRatio: 1.15,
  progressMs: 250
});

function bounded(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

/** 比例类参数用同样的夹取，但它们是分数，不能取整。 */
function boundedFraction(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * 在途字节的硬上限，与调用方怎么切 chunk × window 无关。
 *
 * 在 322 ms / 13% 丢包的同一条链路上实测，同一进程、同一分钟、同一种连接：
 *   64 KiB x 256 = 16 MiB 在途 -> 20.6 s（1.8 MiB/s）
 *   64 KiB x  64 =  4 MiB 在途 ->  4.4 s（8.3 MiB/s）
 * ssh2 给每条通道 2 MiB 的流控窗口（Channel.js 的 MAX_WINDOW），超过这个量的字节
 * 根本不算「在途」：它们堆在 ssh2 的待写队列里，窗口开得越宽传输越慢。
 *
 * 但这只是安全网，不是调节旋钮：真正决定窗口停在哪里的是控制回路 —— 一旦发现更宽
 * 的窗口买不到吞吐就停止探索（见下面的平台判定）。4 MiB 只适合 300 ms 的链路，
 * 对低延迟服务器毫无理由地设限，所以上限留在远高于本工具实测过的任何链路的位置。
 */
export const MAX_WINDOW_BYTES = 16 * 1024 * 1024;

/** 把调用方给的参数夹进不会把传输搞死的区间。 */
export function normalizePipelineOptions(options = {}) {
  const chunk = bounded(options.chunk, PIPELINE_DEFAULTS.chunk, 4 * 1024, 1024 * 1024);
  const requestedMax = bounded(options.concMax, PIPELINE_DEFAULTS.concMax, 1, 512);
  const concMax = Math.max(1, Math.min(requestedMax, Math.floor(MAX_WINDOW_BYTES / chunk)));
  const concMin = Math.min(bounded(options.concMin, PIPELINE_DEFAULTS.concMin, 1, 512), concMax);
  return {
    chunk,
    concMin,
    concMax,
    concStart: Math.min(bounded(options.concStart, PIPELINE_DEFAULTS.concStart, concMin, 512), concMax),
    stallMs: bounded(options.stallMs, PIPELINE_DEFAULTS.stallMs, 1_000, 600_000),
    hardStallMs: bounded(options.hardStallMs, PIPELINE_DEFAULTS.hardStallMs, 5_000, 1_800_000),
    retries: bounded(options.retries, PIPELINE_DEFAULTS.retries, 0, 5),
    tickMs: PIPELINE_DEFAULTS.tickMs,
    growMs: bounded(options.growMs, PIPELINE_DEFAULTS.growMs, 250, 10_000),
    shrinkRatio: boundedFraction(options.shrinkRatio, PIPELINE_DEFAULTS.shrinkRatio, 0.1, 0.95),
    growRatio: boundedFraction(options.growRatio, PIPELINE_DEFAULTS.growRatio, 1.01, 3),
    progressMs: PIPELINE_DEFAULTS.progressMs
  };
}

const call = (sftp, method, ...args) =>
  new Promise((resolve, reject) => {
    sftp[method](...args, (error, value) => (error ? reject(error) : resolve(value)));
  });

/**
 * 把 `localFile[0..size)` 从 `start` 开始写进 `remotePath`，保持一个窗口的数据块
 * 在途。成功时以传输统计 resolve；失败时以底层错误、或调用方的中止原因 reject。
 */
/**
 * 自适应窗口的一次控制步，保持纯函数，这样规则可以由测试里的合成链路驱动，
 * 而不是靠一条一小时摆动 8 倍的真实链路。
 *
 * 规则是刻意对称的：采样比上次差 `shrinkRatio` 就砍半，比上次好 `growRatio` 就按
 * 同样的倍数扩张；掉下去之后，只要链路没有继续变差，窗口就直接翻倍爬回它掉下来的
 * 那个 `ssthresh`。下降时砍半、上升时爬行，正是让长传输在 322 ms 链路上趴在窗口
 * 底部的元凶。
 */
export function nextWindow(state, rate, now) {
  const { concMin, concMax, growMs, shrinkRatio, growRatio } = state;
  const ratio = state.lastRate > 0 ? rate / state.lastRate : 1;
  let { conc, ssthresh, slowStart, lastShrinkAt } = state;
  // 探索必须自己把钱赚回来。更宽的窗口并不免费：多出来的块会排队堆进 ssh2，
  // 在那里增加延迟，在有丢包的链路上最终把通道堵死。所以每一步扩窗都要结算，
  // 连续三步的收益都不到 2% 就停止爬升。
  let bestRate = state.bestRate ?? 0;
  let staleGrows = state.staleGrows ?? 0;
  let plateau = state.plateau ?? false;

  // 两个间隔内最多缩一次：砍半之后紧接的那个采样必然比之前小，若让它再砍一次，
  // 一秒的坏运气就会变成自由落体。
  if (ratio < shrinkRatio && conc > concMin && now - lastShrinkAt >= growMs * 2) {
    return {
      conc: Math.max(Math.floor(conc / 2), concMin),
      // 记住最后那次健康的窗口，而不是跌到的谷底：连着砍几次之后，恢复的目标
      // 仍然应该是链路曾经跑得好的那个位置。
      ssthresh: Math.max(ssthresh, conc),
      slowStart: false,
      lastRate: rate,
      lastShrinkAt: now,
      shrunk: true,
      // 链路在脚下变了，之前测出来的平台作废。
      bestRate: 0,
      staleGrows: 0,
      plateau: false
    };
  }

  const growTo = (target) => {
    const next = Math.min(target, concMax);
    if (next <= conc || plateau) return conc;
    if (bestRate > 0 && rate <= bestRate * 1.02) {
      staleGrows += 1;
      if (staleGrows >= 3) plateau = true;
    } else {
      bestRate = rate;
      staleGrows = 0;
    }
    return next;
  };

  if (conc < concMax) {
    if (conc < ssthresh) {
      // 快速恢复：链路没有继续变差，就朝它上次推回的位置爬回去，翻倍而不是爬行。
      //
      // 这里刻意没有「绝对速率」规则。因为链路「此刻很慢」就缩窗是自毁的：
      // 窗口更小 → 速率更低 → 「慢」的判定继续成立 → 挡住那个能把速率抬起来的恢复。
      // 真实链路上量过：24 MiB 在窗口趴在底部时只有 1.58 MiB/s，而同样字节在固定
      // 窗口下跑到 4.82 MiB/s。
      if (ratio >= shrinkRatio) conc = growTo(Math.min(conc * 2, ssthresh));
    } else if (ratio >= growRatio) {
      // 链路变好了多少倍就按同样的倍数扩张，最多 4 倍。
      conc = growTo(Math.ceil(conc * Math.min(ratio, 4)));
    } else if (slowStart) {
      conc = growTo(conc * 2);
    } else if (ratio >= 1) {
      conc = growTo(Math.ceil(conc * 1.25));
    }
  }

  return { conc, ssthresh, slowStart, lastRate: rate, lastShrinkAt, shrunk: false, bestRate, staleGrows, plateau };
}

export async function uploadPipelined({
  sftp,
  localFile,
  remotePath,
  size,
  start = 0,
  options = {},
  signal,
  onProgress
}) {
  const opts = normalizePipelineOptions(options);
  if (signal?.aborted) throw signal.reason ?? new Error("upload cancelled");

  const handle = await call(sftp, "open", remotePath, start > 0 ? "r+" : "w");
  const fd = openSync(localFile, "r");

  // 按块预读，而不是每个数据块都读一次盘。单次同步读在普通 Node 进程里很便宜，
  // 但在 DSH 宿主里要花 50–70 ms，而每个块都要付一次：用 64 KiB 的块，光这一项
  // 就让 36 MiB 的推送卡在 1 MiB/s 附近，窗口开多大都没用。按块读让系统调用次数
  // 与字节数成正比，而不是与块大小成正比。
  const prefetchBytes = Math.ceil(Math.max(1024 * 1024, opts.chunk * 4) / opts.chunk) * opts.chunk;
  let block = { start: 0, end: 0, buffer: null };

  return await new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let next = start;
    let acked = start;
    let inflight = 0;
    let conc = opts.concStart;
    let peakConc = conc;
    let retries = 0;
    let stalls = 0;
    let settled = false;
    let slowStart = true;
    // 链路最后一次推回时的窗口；恢复会直接爬回这里。
    let ssthresh = opts.concMax;

    let lastAckAt = Date.now();
    let lastAckValue = acked;
    let lastShrinkAt = 0;
    let lastGrowAt = startedAt;
    let growAcked = acked;
    let lastRate = 0;
    // 平台判定的记账：扩窗至今买到过的最好速率、连续多少步没能超过它、
    // 以及探索是否已经关掉。
    let bestRate = 0;
    let staleGrows = 0;
    let plateau = false;
    // 尚未确认的写入，以及它们交给 ssh2 的时刻。最老的那一条能说明：更宽的窗口
    // 到底还在买带宽，还是仅仅把字节停在发送队列里 —— 等了超过两个往返还没被确认的，
    // 是排队，不是在途。
    const pendingWrites = [];
    let rttMin = 0;
    let lastProgressAt = 0;

    let tickHandle = null;

    const cleanup = () => {
      if (tickHandle) clearInterval(tickHandle);
      tickHandle = null;
      signal?.removeEventListener("abort", onAbort);
      try { closeSync(fd); } catch { /* the transfer is already over */ }
      try { sftp.close(handle, () => {}); } catch { /* channel may be gone */ }
    };

    function finish(error) {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        reject(error);
        return;
      }
      const seconds = (Date.now() - startedAt) / 1000;
      resolve({
        bytes: acked - start,
        start,
        seconds,
        bytesPerSecond: seconds > 0 ? (acked - start) / seconds : 0,
        peakConcurrency: peakConc,
        stalls,
        retries
      });
    }

    function onAbort() {
      finish(signal?.reason instanceof Error ? signal.reason : new Error("upload cancelled"));
    }

    function reportProgress() {
      if (!onProgress) return;
      const now = Date.now();
      if (now - lastProgressAt < opts.progressMs && acked < size) return;
      lastProgressAt = now;
      onProgress(acked, size, { conc, stalls, inflight });
    }

    function writeChunk(offset, buffer, length, attempt = 0) {
      const stamp = { at: Date.now() };
      pendingWrites.push(stamp);
      sftp.write(handle, buffer, 0, length, offset, (error) => {
        const seen = pendingWrites.indexOf(stamp);
        if (seen >= 0) pendingWrites.splice(seen, 1);
        if (settled) return;
        if (!error) {
          const age = Date.now() - stamp.at;
          if (rttMin === 0 || age < rttMin) rttMin = age;
        }
        // 失败的数据块保留它占的窗口位置并原地重试：服务器没有确认这些字节，
        // 所以重发不会在目标端造成重复数据。
        if (error && attempt < opts.retries) {
          retries += 1;
          const timer = setTimeout(() => {
            if (!settled) writeChunk(offset, buffer, length, attempt + 1);
          }, 150 * 2 ** attempt);
          timer.unref?.();
          return;
        }
        inflight -= 1;
        if (error) {
          finish(error);
          return;
        }
        acked += length;
        reportProgress();
        pump();
      });
    }

    /**
     * 从预读块里按 `offset` 切出 `length` 字节，只有请求落在块外时才重新填充。
     * 引用该块的写入还在途时，这个视图会让块保持存活。
     */
    function chunkAt(offset, length) {
      if (!block.buffer || offset < block.start || offset + length > block.end) {
        const span = Math.min(prefetchBytes, size - offset);
        const buffer = Buffer.allocUnsafe(span);
        const read = readSync(fd, buffer, 0, span, offset);
        if (read < length) {
          throw new Error(`unexpected end of ${localFile} at ${offset}; expected ${length} bytes, read ${read}`);
        }
        block = { start: offset, end: offset + read, buffer };
      }
      const from = offset - block.start;
      return block.buffer.subarray(from, from + length);
    }

    function pump() {
      if (settled) return;
      while (inflight < conc && next < size) {
        const length = Math.min(opts.chunk, size - next);
        let buffer;
        try {
          buffer = chunkAt(next, length);
        } catch (error) {
          finish(error);
          return;
        }
        const offset = next;
        next += length;
        inflight += 1;
        writeChunk(offset, buffer, length);
      }
      if (inflight === 0 && acked >= size) finish(null);
    }

    tickHandle = setInterval(() => {
      const now = Date.now();
      if (acked > lastAckValue) {
        lastAckAt = now;
        lastAckValue = acked;
      }

      if (now - lastAckAt > opts.stallMs && now - lastShrinkAt >= opts.stallMs) {
        conc = Math.max(Math.floor(conc / 2), opts.concMin);
        stalls += 1;
        lastShrinkAt = now;
        // 链路推回来了：退出慢启动、停止翻倍，并忘掉根据之前行为测出的平台。
        slowStart = false;
        plateau = false;
        staleGrows = 0;
        bestRate = 0;
      }

      // 扩窗只在字节真的进入链路时才有用。一旦最老的未确认写入已经等了两个往返，
      // 多出来的窗口就是在 ssh2 的队列里：在这里停止探索，但不缩窗 ——
      // 链路没有失败，它只是满了。
      let queueing = false;
      if (pendingWrites.length && rttMin > 0) {
        const oldestAge = now - pendingWrites[0].at;
        queueing = oldestAge > Math.max(rttMin * 2, 400);
      }
      // 超过两个带宽延迟积的窗口不可能再增加吞吐：BDP 之外的部分是排队，不是在途。
      // 这个积是量出来的而不是假设的，所以 1 ms 的链路可以自由地用比 322 ms 链路
      // 宽得多的窗口，不需要按链路调参。
      if (lastRate > 0 && rttMin > 0) {
        const bdpBytes = lastRate * (rttMin / 1000);
        const capBytes = Math.max(2 * 1024 * 1024, 2 * bdpBytes);
        if (conc * opts.chunk > capBytes) queueing = true;
      }

      if (!queueing && now - lastGrowAt >= opts.growMs) {
        const seconds = (now - lastGrowAt) / 1000;
        const rate = (acked - growAcked) / seconds;
        const step = nextWindow(
          {
            conc,
            concMin: opts.concMin,
            concMax: opts.concMax,
            ssthresh,
            slowStart,
            lastRate,
            lastShrinkAt,
            growMs: opts.growMs,
            shrinkRatio: opts.shrinkRatio,
            growRatio: opts.growRatio,
            bestRate,
            staleGrows,
            plateau,
          },
          rate,
          now
        );
        conc = step.conc;
        ssthresh = step.ssthresh;
        slowStart = step.slowStart;
        lastRate = step.lastRate;
        bestRate = step.bestRate;
        staleGrows = step.staleGrows;
        plateau = step.plateau;
        lastShrinkAt = step.lastShrinkAt;
        if (step.shrunk) stalls += 1;
        if (process.env.SFTP_PUSH_TRACE) {
          process.stderr.write(
            `trace t=${((now - startedAt) / 1000).toFixed(1)}s rate=${(rate / 1048576).toFixed(2)}MiB/s ` +
              `win=${conc} ssthresh=${ssthresh} slow=${slowStart} shrunk=${step.shrunk}
`
          );
        }
        growAcked = acked;
        lastGrowAt = now;
      }

      peakConc = Math.max(peakConc, conc);

      if (now - lastAckAt > opts.hardStallMs) {
        const idle = Math.round((now - lastAckAt) / 1000);
        finish(new Error(`SFTP upload stalled: no write acknowledged for ${idle}s (${acked - start}/${size - start} bytes written)`));
      }
    }, opts.tickMs);
    tickHandle.unref?.();

    signal?.addEventListener("abort", onAbort, { once: true });
    pump();
  });
}
