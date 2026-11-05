/**
 * 面向「会成片塌陷的链路」的大文件分段上传循环。
 *
 * 引擎（`sftp-push.js`）已经会单独重试某个数据块，但它只能在给定的 socket 上工作。
 * 当整条 TCP 流死掉时 —— 在长距离链路上这不会报错，socket 只是不再回 ack ——
 * 等引擎的硬停滞兜底要花掉一分钟，而且改变不了任何东西。真正能治好它的是换一条流，
 * 所以本循环盯着已确认速率：一旦它低于底线并持续足够久，就向调用方要一个新会话，
 * 并从最后确认的字节继续。
 *
 * 这里不引入 ssh2，也不碰服务类，好让这个决策能脱离网络测试：
 * 会话、重拨、分段写入全部由调用方注入。
 */

/** 一次塌陷判定，只是采样值的纯函数。 */
export function shouldRedraw({ elapsedMs, bytes, floor, afterMs }) {
  if (!(afterMs > 0) || !(floor > 0)) return false;
  if (!(elapsedMs >= afterMs)) return false;
  const rate = (bytes * 1000) / elapsedMs;
  return rate < floor;
}

/**
 * 以分段方式推送 [start, size)，某一段的流塌陷时重拨会话。
 * 这里每个数字都是量出来的，没有假设：看门狗读的就是面板上显示的那份 onProgress。
 */
export async function uploadWithRedraw(options) {
  const {
    size,
    start = 0,
    segmentBytes = 32 * 1024 * 1024,
    floor = 256 * 1024,
    afterMs = 6000,
    maxRedraws = 20,
    maxAttemptsPerSegment = 3,
    getSession,
    redraw,
    putSegment,
    onProgress,
    signal,
    delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    setInterval: setIntervalImpl = setInterval,
    clearInterval: clearIntervalImpl = clearInterval
  } = options;

  const totals = { seconds: 0, peakConcurrency: 0, stalls: 0, retries: 0 };
  const origin = Math.max(0, Math.min(size, start));
  let cursor = origin;
  let segments = 0;
  let redraws = 0;

  while (cursor < size) {
    const end = segmentBytes > 0 ? Math.min(size, cursor + segmentBytes) : size;
    for (let attempt = 1; ; attempt += 1) {
      const attemptController = new AbortController();
      const relayAbort = () => attemptController.abort(signal?.reason ?? new Error("upload cancelled"));
      if (signal) {
        if (signal.aborted) relayAbort();
        else signal.addEventListener("abort", relayAbort, { once: true });
      }
      let ackedAt = cursor;
      const startedAt = now();
      const watchdog = setIntervalImpl(() => {
        if (attemptController.signal.aborted) return;
        const collapsed = shouldRedraw({
          elapsedMs: now() - startedAt,
          bytes: ackedAt - cursor,
          floor,
          afterMs
        });
        if (!collapsed) return;
        const rate = Math.round(((ackedAt - cursor) * 1000) / Math.max(1, now() - startedAt) / 1024);
        const error = new Error(`flow collapsed: ${rate} KiB/s after ${((now() - startedAt) / 1000).toFixed(1)}s`);
        error.code = "sftp-upload-slow";
        attemptController.abort(error);
      }, 500);
      watchdog.unref?.();
      try {
        const part = await putSegment(getSession(), cursor, end, {
          signal: attemptController.signal,
          onProgress: (absolute) => {
            ackedAt = absolute;
            onProgress?.(absolute);
          }
        });
        totals.seconds += part.seconds ?? 0;
        totals.peakConcurrency = Math.max(totals.peakConcurrency, part.peakConcurrency ?? 0);
        totals.stalls += part.stalls ?? 0;
        totals.retries += part.retries ?? 0;
        break;
      } catch (error) {
        if (signal?.aborted) throw error;
        const collapsed =
          error?.code === "sftp-upload-slow" ||
          attemptController.signal.reason?.code === "sftp-upload-slow";
        if (collapsed && typeof redraw === "function" && redraws < maxRedraws) {
          redraws += 1;
          cursor = Math.max(cursor, ackedAt);
          onProgress?.(cursor);
          await redraw();
          continue;
        }
        if (attempt >= maxAttemptsPerSegment) throw error;
        await delay(500 * attempt);
      } finally {
        clearIntervalImpl(watchdog);
        signal?.removeEventListener("abort", relayAbort);
      }
    }
    cursor = end;
    segments += 1;
  }

  // 字节数按游标前进量算，而不是把各段相加：重拨后的那一次只携带该段的剩余部分，
  // 把各段直接相加会少报服务器上真实落盘的量。
  return { ...totals, bytes: cursor - origin, segments, redraws };
}
