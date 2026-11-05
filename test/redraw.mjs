import test from "node:test";
import assert from "node:assert/strict";
import { shouldRedraw, uploadWithRedraw } from "../src/upload-redraw.js";

const mib = 1024 * 1024;

test("shouldRedraw stays quiet inside the grace window", () => {
  assert.equal(shouldRedraw({ elapsedMs: 2000, bytes: 0, floor: 256 * 1024, afterMs: 6000 }), false);
});

test("shouldRedraw ignores a flow that is still fast", () => {
  assert.equal(shouldRedraw({ elapsedMs: 6000, bytes: 60 * mib, floor: 256 * 1024, afterMs: 6000 }), false);
});

test("shouldRedraw fires when the rate stays under the floor past the grace window", () => {
  assert.equal(shouldRedraw({ elapsedMs: 6000, bytes: 1024, floor: 256 * 1024, afterMs: 6000 }), true);
});

test("shouldRedraw is inert when the floor or the window is disabled", () => {
  assert.equal(shouldRedraw({ elapsedMs: 60000, bytes: 0, floor: 0, afterMs: 6000 }), false);
  assert.equal(shouldRedraw({ elapsedMs: 60000, bytes: 0, floor: 256 * 1024, afterMs: 0 }), false);
});

test("a collapsed segment redraws the session and resumes from the acknowledged byte", async () => {
  const size = 8 * mib;
  let session = { id: 1 };
  const opened = [];
  const calls = [];

  const result = await uploadWithRedraw({
    size,
    segmentBytes: size,
    floor: 256 * 1024,
    afterMs: 10,
    maxRedraws: 3,
    setInterval: (fn, ms) => setInterval(fn, 5),
    getSession: () => session,
    redraw: async () => {
      session = { id: session.id + 1 };
      opened.push(session.id);
    },
    putSegment: async (current, from, to, { signal, onProgress }) => {
      calls.push({ session: current.id, from, to });
      if (calls.length === 1) {
        // 先有真实的部分进展，然后这条流无声地死掉（不报错）。
        onProgress(from + 4096);
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      onProgress(to);
      return { bytes: to - from, seconds: 0.1, peakConcurrency: 64, stalls: 0, retries: 0 };
    }
  });

  assert.equal(result.redraws, 1);
  assert.equal(result.segments, 1);
  assert.equal(result.bytes, size);
  assert.deepEqual(opened, [2]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].session, 1);
  assert.equal(calls[1].session, 2, "the second attempt must use the fresh session");
  assert.equal(calls[1].from, 4096, "it must resume from the last acknowledged byte");
});

test("reconnects are bounded and the upload fails honestly at the limit", async () => {
  const size = mib;
  let redraws = 0;
  await assert.rejects(
    uploadWithRedraw({
      size,
      segmentBytes: size,
      floor: 256 * 1024,
      afterMs: 10,
      maxRedraws: 2,
      maxAttemptsPerSegment: 5,
      setInterval: (fn, ms) => setInterval(fn, 5),
      getSession: () => ({}),
      redraw: async () => { redraws += 1; },
      putSegment: async (session, from, to, { signal, onProgress }) => {
        onProgress(from);
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        throw new Error("unreachable");
      }
    }),
    /flow collapsed/
  );
  assert.equal(redraws, 2, "maxRedraws caps the number of dials");
});

test("without a redraw callback the loop retries the segment instead of dialing", async () => {
  let attempts = 0;
  await assert.rejects(
    uploadWithRedraw({
      size: mib,
      segmentBytes: mib,
      floor: 256 * 1024,
      afterMs: 10,
      maxAttemptsPerSegment: 2,
      delay: async () => {},
      setInterval: (fn, ms) => setInterval(fn, 5),
      getSession: () => ({}),
      putSegment: async (session, from, to, { signal, onProgress }) => {
        attempts += 1;
        onProgress(from + 1024);
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
    }),
    /flow collapsed/
  );
  assert.equal(attempts, 2);
});

test("progress is reported as an absolute file offset across segments", async () => {
  const size = 3 * mib;
  const seen = [];
  await uploadWithRedraw({
    size,
    segmentBytes: mib,
    floor: 256 * 1024,
    afterMs: 60000,
    getSession: () => ({}),
    putSegment: async (session, from, to, { onProgress }) => {
      onProgress(to);
      return { bytes: to - from, seconds: 0.1, peakConcurrency: 8, stalls: 0, retries: 0 };
    },
    onProgress: (absolute) => seen.push(absolute)
  });
  assert.deepEqual(seen, [mib, 2 * mib, 3 * mib]);
});
