/**
 * Session-log agent tools: list recorded sessions, search them, and read a
 * bounded range. Content-bearing reads cross the same boundary as terminal
 * context reads — operator approval plus redaction — because a recorded
 * session may contain anything the operator typed or saw.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { redactForModel } from "../redact.js";
import { toReadableText } from "../terminal-text.js";
import { t } from "../i18n/core.js";

const MAX_READ_BYTES = 48 * 1024;
const MAX_MODEL_LOG_BYTES = 8 * 1024 * 1024;

// Sanitize the complete bounded recording before slicing it. Both tools use
// offsets in the sanitized UTF-8 view so no page can begin inside a secret.
async function modelLogView(service, sessionId) {
  const result = await service.sessionLogSnapshot(sessionId, MAX_MODEL_LOG_BYTES);
  if (!result.ok) throw new Error(`ssh_session_log_read failed: ${result.error.message}`);
  return Buffer.from(redactForModel(toReadableText(result.value.toString("utf8"))).text, "utf8");
}

export function registerSessionLogTools(ctx, service) {
  ctx.tools.register(defineTool({
    name: "ssh_session_log_list",
    description: "List recorded SSH terminal sessions (metadata only: host, user, start/end, size, truncation). Use a session_id with ssh_session_log_search to find what happened in it; the log content itself is never returned here.",
    parameters: { limit: { type: "integer", description: "How many of the newest sessions to return; defaults to 20." } },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          enabled: { type: "boolean", required: true },
          logs: { type: "array", required: true, items: { type: "object", additionalProperties: true } }
        }
      },
      render(_args, value) {
        if (!value.enabled) return [{ type: "text", text: t("会话录制已关闭（config.sessionLogEnabled = false）。") }];
        if (value.logs.length === 0) return [{ type: "text", text: t("还没有已录制的会话。") }];
        const lines = value.logs.map((log) => {
          const state = log.endedAt === null ? "recording" : `ended${log.exitCode === null ? "" : ` (exit ${log.exitCode})`}`;
          const where = [log.name, log.host].filter(Boolean).join(" @ ") || "unknown host";
          return `${log.sessionId}  ${log.startedAt}  ${where}  ${Math.round((log.bytes ?? 0) / 1024)}KB${log.truncated ? " [truncated]" : ""}  ${state}`;
        });
        return [{ type: "text", text: lines.join("\n") }];
      }
    },
    async execute(args) {
      const result = await service.sessionLogList();
      if (!result.ok) throw new Error(`ssh_session_log_list failed: ${result.error.message}`);
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
      return { enabled: result.value.enabled, logs: result.value.logs.slice(0, limit) };
    }
  }));

  ctx.tools.register(defineTool({
    name: "ssh_session_log_search",
    description: "Search one recorded SSH session log (case-insensitive substring) and return matching lines with offsets in the sanitized log view. Content is redacted before it reaches you. Use the offsets with ssh_session_log_read to see surrounding output.",
    parameters: {
      session_id: { type: "string", required: true, description: "A session id from ssh_session_log_list." },
      query: { type: "string", required: true, description: "Text to look for (case-insensitive)." },
      max_hits: { type: "integer", description: "Stop after this many hits; defaults to 50." }
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          hits: { type: "array", required: true, items: { type: "object", additionalProperties: true } },
          scannedBytes: { type: "number", required: true },
          stoppedEarly: { type: "boolean", required: true }
        }
      },
      render(_args, value) {
        if (value.hits.length === 0) return [{ type: "text", text: t("没有匹配行。") }];
        const lines = value.hits.map((hit) => `@${hit.offset}  ${hit.line}`);
        return [{ type: "text", text: lines.join("\n") + (value.stoppedEarly ? t("\n[到达命中上限，已停止]") : "") }];
      }
    },
    async execute(args) {
      const data = await modelLogView(service, args.session_id);
      const query = String(args.query ?? "").toLowerCase();
      const maxHits = Math.min(Math.max(Number(args.max_hits) || 50, 1), 200);
      const hits = [];
      let offset = 0;
      let stoppedEarly = false;
      if (query) for (const line of data.toString("utf8").split("\n")) {
        if (line.toLowerCase().includes(query)) {
          hits.push({ offset, line: line.slice(0, 500) });
          if (hits.length >= maxHits) { stoppedEarly = true; break; }
        }
        offset += Buffer.byteLength(line, "utf8") + 1;
      }
      return { hits, scannedBytes: data.length, stoppedEarly };
    }
  }));

  ctx.tools.register(defineTool({
    name: "ssh_session_log_read",
    description: "Read a bounded range of one recorded SSH session log, starting at a byte offset in the sanitized log view. Content is redacted before it reaches you. Read at most a few tens of KB per call and continue with the returned nextOffset.",
    parameters: {
      session_id: { type: "string", required: true },
      offset: { type: "integer", description: "Byte offset to start at; defaults to 0 (or use an offset from a search hit)." },
      max_bytes: { type: "integer", description: `Bytes to return; defaults to 24576, capped at ${MAX_READ_BYTES}.` }
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          data: { type: "string", required: true },
          startOffset: { type: "number", required: true },
          nextOffset: { type: "number", required: true },
          eof: { type: "boolean", required: true },
          size: { type: "number", required: true }
        }
      },
      render(_args, value) {
        const tail = value.eof ? "" : t(`\n[已到 offset ${value.nextOffset} / ${value.size}，继续读取请用该 offset]`);
        return [{ type: "text", text: value.data + tail }];
      }
    },
    async execute(args) {
      const data = await modelLogView(service, args.session_id);
      let startOffset = Math.max(0, Math.min(Number(args.offset) || 0, data.length));
      // Do not split a UTF-8 character at an arbitrary cursor or page end.
      while (startOffset < data.length && (data[startOffset] & 0xc0) === 0x80) startOffset += 1;
      const length = Math.min(Math.max(Number(args.max_bytes) || 24576, 1024), MAX_READ_BYTES);
      let nextOffset = Math.min(data.length, startOffset + length);
      while (nextOffset < data.length && nextOffset > startOffset && (data[nextOffset] & 0xc0) === 0x80) nextOffset -= 1;
      return { data: data.subarray(startOffset, nextOffset).toString("utf8"), startOffset, nextOffset, eof: nextOffset === data.length, size: data.length };
    }
  }));

  // Reading recorded session content is the same trust boundary as reading a
  // live terminal: the operator approves each attempt.
  if (typeof ctx.on === "function") ctx.on("tools/pre-execute", (execution, next) => {
    if (execution?.name !== "ssh_session_log_read" && execution?.name !== "ssh_session_log_search") {
      return typeof next === "function" ? next() : undefined;
    }
    return { kind: "ask", reason: "Agent requests recorded SSH session content, which may contain sensitive output." };
  });
}
