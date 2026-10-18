/**
 * Session-log viewer highlighting (issue #36): error-ish lines read red,
 * warning-ish lines amber. Plain-text heuristics over readable (ANSI-stripped)
 * log lines — a reading aid in the spirit of `grep --color`, not a classifier,
 * so it deliberately errs on the loud side ("0 errors" lights up too).
 */

const ERROR_RE = /\b(?:error|errors|fatal|failed|failure|panic|traceback|critical|crit|emerg|segfault|refused|denied)\b|\w*Exception\b|\w*Errno\b|\[(?:e|err|error|fatal|crit|critical)\]|(?:^|\s)E(?:ACCES|EXIST|NOENT|PERM|INVAL|AGAIN|NOMEM|CONNREFUSED|CONNRESET|ADDRINUSE)\b|(?:^|\s)E\d{4}\b/i;
const WARNING_RE = /\b(?:warn|warnings|deprecated|caution)\b|\w*Warning\b|\[(?:w|warn|warning)\]|(?:^|\s)W\d{4}\b/i;

/** "error" | "warning" | null for one readable log line; error wins a tie. */
export function classifyLogLine(line) {
  if (typeof line !== "string" || line === "") return null;
  if (ERROR_RE.test(line)) return "error";
  if (WARNING_RE.test(line)) return "warning";
  return null;
}

/**
 * Split readable text into render runs: each highlighted line is its own
 * segment (without its newline, so the mark hugs the text), consecutive plain
 * lines — newlines included — collapse into one segment. Concatenating every
 * segment's text reproduces the input exactly.
 */
export function segmentLogText(text) {
  const segments = [];
  if (typeof text !== "string" || text === "") return segments;
  const lines = text.split("\n");
  let plain = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const newline = index < lines.length - 1 ? "\n" : "";
    const kind = classifyLogLine(line);
    if (kind === null) {
      plain += line + newline;
      continue;
    }
    if (plain !== "") segments.push({ kind: null, text: plain });
    segments.push({ kind, text: line });
    plain = newline;
  }
  if (plain !== "") segments.push({ kind: null, text: plain });
  return segments;
}
