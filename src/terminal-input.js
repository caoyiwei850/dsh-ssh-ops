/**
 * Local terminal line mirror, shared by two paths that were previously two
 * copies of the same per-character state machine:
 *
 * - prepareTerminalInput (agent path): an Enter is forwarded to the PTY only
 *   when the mirrored line passes the shell-command policy; a denied line is
 *   killed with Ctrl-U (\x15) before it can execute. History navigation and
 *   completion poison the mirror and fail closed.
 * - updateInputMirror (operator path): trusted keystrokes are forwarded
 *   verbatim; the mirror is only kept honest so a later agent-driven Enter
 *   cannot submit a human-typed destructive line invisibly.
 */
import { UNVERIFIED_LINE_REASON } from "./policy-messages.js";

export const MAX_INPUT_LINE_LENGTH = 8192;

/**
 * Advance the mirror over `text`.
 * @param {{ inputLine: string, inputKnown: boolean }} state mirror, mutated in place
 * @param {string} text raw characters heading for the PTY
 * @param {((line: string) => { ok: boolean, reason?: string }) | null} decide
 *   Enter gate; null forwards everything (operator path).
 * @returns {{ forwarded: string, blockedReason: string | null }}
 */
export function processTerminalInput(state, text, decide) {
  let forwarded = "";
  let blockedReason = null;
  for (const char of text) {
    if (char === "\r" || char === "\n") {
      if (decide !== null) {
        const decision = state.inputKnown
          ? decide(state.inputLine)
          : { ok: false, reason: UNVERIFIED_LINE_REASON };
        if (decision.ok) {
          forwarded += char;
        } else {
          // The already-echoed command remains in the remote line editor until
          // Ctrl-U clears it; crucially, Enter itself never reaches the shell.
          forwarded += "\x15";
          blockedReason ??= decision.reason;
        }
      } else {
        forwarded += char;
      }
      state.inputLine = "";
      state.inputKnown = true;
      continue;
    }
    if (char === "\x03") {
      state.inputLine = "";
      state.inputKnown = true;
      forwarded += char;
      continue;
    }
    if (char === "\b" || char === "\x7f") {
      if (state.inputKnown) state.inputLine = state.inputLine.slice(0, -1);
      forwarded += char;
      continue;
    }
    if (char === "\x1b" || char === "\t") {
      // Escape sequences (history/navigation) and completion can change the
      // remote line without a trustworthy local representation.
      state.inputKnown = false;
      forwarded += char;
      continue;
    }
    if (char.codePointAt(0) < 32) {
      forwarded += char;
      continue;
    }
    if (state.inputKnown) {
      state.inputLine += char;
      if (state.inputLine.length > MAX_INPUT_LINE_LENGTH) state.inputKnown = false;
    }
    forwarded += char;
  }
  return { forwarded, blockedReason };
}
