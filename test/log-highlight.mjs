import assert from "node:assert/strict";
import { classifyLogLine, segmentLogText } from "../src/client/log-highlight.js";

// 会话日志查看器的 warning/error 行高亮（issue #36-2）：分类与分段纯逻辑。

// ── classify ────────────────────────────────────────────────────────────────
assert.equal(classifyLogLine("2026-10-18 10:00:00 ERROR: connection refused"), "error");
assert.equal(classifyLogLine("[Err] something broke"), "error");
assert.equal(classifyLogLine("CRITICAL: database unavailable"), "error");
assert.equal(classifyLogLine("Traceback (most recent call last):"), "error");
assert.equal(classifyLogLine("java.lang.NullPointerException"), "error");
assert.equal(classifyLogLine("kernel: EEXIST on path"), "error", "E+四位数字（如 nginx/EACCES 风格）算 error");
assert.equal(classifyLogLine("WARNING: disk almost full"), "warning");
assert.equal(classifyLogLine("[warn] retrying in 2s"), "warning");
assert.equal(classifyLogLine("DeprecationWarning: option X"), "warning");
assert.equal(classifyLogLine("2026-10-18 10:00:00 INFO: started"), null);
assert.equal(classifyLogLine("root@host:~$ systemctl status nginx"), null);
assert.equal(classifyLogLine("total 42"), null);
assert.equal(classifyLogLine(""), null);
assert.equal(classifyLogLine(undefined), null);
assert.equal(classifyLogLine("error_log /var/log/nginx/error.log;"), "error", "宽松策略：宁可误亮不漏亮");

// error 与 warning 同时命中时 error 胜。
assert.equal(classifyLogLine("ERROR: failed to load warnings"), "error");

// ── segment ─────────────────────────────────────────────────────────────────
{
  const input = "line one\nERROR: boom\nline two\nWARN: slow\n";
  const segments = segmentLogText(input);
  assert.equal(
    segments.map((s) => `${s.kind}:${JSON.stringify(s.text)}`).join(" | "),
    'null:"line one\\n" | error:"ERROR: boom" | null:"\\nline two\\n" | warning:"WARN: slow" | null:"\\n"',
    "高亮行独立成段且不带换行，普通行合并"
  );
  assert.equal(segments.map((s) => s.text).join(""), input, "拼接必须精确还原原文（含末尾换行）");
}

{
  const only = "ERROR: everything";
  assert.deepEqual(segmentLogText(only), [{ kind: "error", text: only }]);
  assert.deepEqual(segmentLogText("plain\nplain"), [{ kind: null, text: "plain\nplain" }]);
  assert.deepEqual(segmentLogText(""), []);
  // 相邻高亮行之间只落一个换行段。
  const adjacent = "ERROR: a\nERROR: b\n";
  const adjacentSegments = segmentLogText(adjacent);
  assert.deepEqual(
    adjacentSegments.map((s) => `${s.kind}:${s.text}`),
    ["error:ERROR: a", "null:\n", "error:ERROR: b", "null:\n"]
  );
  assert.equal(adjacentSegments.map((s) => s.text).join(""), adjacent);
}

console.log("log-highlight ok");
