/**
 * Network-CLI command execution over the interactive PTY (VRP, Comware,
 * Cisco IOS and friends). These devices have no POSIX exec channel — an exec
 * request opens but never produces data or a close (#33) — so an agent
 * command is typed into the already-open visible terminal and completion is
 * detected by the prompt returning, which is the network-CLI design contract
 * ("one line, one command, back to the prompt").
 *
 * Everything here is pure and unit-testable; the PTY orchestration (mutex,
 * collection, paging) lives in the service.
 */
import { t } from "./i18n/core.js";

/** Strip ANSI escape sequences (CSI and OSC) from terminal output. */
export function stripAnsiCodes(text) {
  return String(text ?? "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

/** Last non-empty line of a text blob, CR-stripped; "" when none. */
function lastNonEmptyLine(text) {
  const lines = String(text ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].replace(/\r/g, "").trim();
    if (line !== "") return line;
  }
  return "";
}

/**
 * Recognise a network-CLI prompt line. Covered families:
 *   VRP / Comware: `<S12712>` (user view), `[S12712]` / `[S12712-GigabitEthernet0/0/1]` (system/interface views)
 *   Cisco IOS:     `Router>`, `Router#`, `Router(config)#`, `Router(config-if)#
 * Anything else (a bare word, mid-scroll output) returns null: the caller
 * must then refuse rather than guess (#33 expectation 4).
 */
export function extractCliPrompt(tail) {
  const line = lastNonEmptyLine(stripAnsiCodes(tail));
  if (
    /^(?:<[^<>\s]{1,63}>|\[[^\s[\]]{1,63}\]|[\w.:-]{1,63}(?:\([\w. -]+\))*[>#])$/.test(line)
  ) {
    return line;
  }
  return null;
}

/**
 * Whether the collected output ends with the prompt again — the completion
 * signal for a CLI command. Exact full-line match: the echoed command line
 * (`<host>display clock`) never equals the bare prompt.
 */
export function promptReturned(collected, promptLine) {
  return lastNonEmptyLine(stripAnsiCodes(collected)) === promptLine;
}

/** VRP paging marker: the device stopped and waits for a keypress. */
export function cliPageRequested(collected) {
  return stripAnsiCodes(collected).slice(-60).includes("---- More ----");
}

/**
 * Build the stdout for a completed CLI command: drop the echoed command line
 * (prompt + command) at the head and the returned prompt at the tail, then
 * trim. When the command did not finish (timedOut), only the head is dropped
 * — the tail is unfinished output, not a prompt.
 */
export function stripCliOutput(collected, promptLine, command, { timedOut = false } = {}) {
  // The paging marker is terminal chrome, not device output: the keypress
  // that advances the page erases it on screen, so the collected bytes must
  // not carry it into the result either.
  let lines = stripAnsiCodes(collected)
    .split("\n")
    .map((line) => line.replace(/\r/g, ""))
    .filter((line) => !line.includes("---- More ----"));
  if (lines.length > 0 && lines[0].trimEnd().endsWith(command.trim())) lines = lines.slice(1);
  if (!timedOut) {
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    if (lines.length > 0 && lines[lines.length - 1].trim() === promptLine) lines.pop();
  }
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.join("\n");
}

/**
 * Screen a command for the CLI path: printable single line, sane length.
 * (The destructive-command deny-list has already run for this command in
 * execOnConnection — this is the format gate, not the safety gate.)
 */
export function sanitizeCliCommand(command) {
  if (typeof command !== "string") return { ok: false, reason: t("命令不是文本") };
  const value = command.trim();
  if (value === "") return { ok: false, reason: t("命令为空") };
  if (value.length > 512) return { ok: false, reason: t("命令超过 512 字符") };
  if (/[\x00-\x1f\x7f]/.test(value)) return { ok: false, reason: t("命令包含控制字符或换行") };
  return { ok: true, value };
}
