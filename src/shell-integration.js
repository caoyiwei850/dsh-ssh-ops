/**
 * Shell integration (OSC 133): the remote shell marks where each command's
 * prompt, input and output begin and end, plus its exit code and working
 * directory. Tracking those markers turns the terminal byte stream into
 * structured facts an agent can rely on — the current directory, the last
 * exit status, and whether the shell is sitting at a prompt — instead of
 * heuristics over raw output.
 *
 * The tracker consumes escape sequences that may be split across chunks, so it
 * keeps a small carry buffer. Sequences are ALSO left in the stream: the
 * terminal renders them as nothing, and stripping would rewrite what the user
 * saw.
 */

/** OSC introducer and the two terminators a shell may use (BEL and ST). */
const OSC_START = "\x1b]";
const BEL = "\x07";
const ST = "\x1b\\";
/** Longest prefix kept when a chunk ends mid-sequence. */
const MAX_CARRY = 512;

/**
 * The one-liner typed into a POSIX/bash session to install the markers. Single
 * line on purpose: it rides the same write path as any other terminal input,
 * so it must be safe to submit with one Enter. `$?` is captured by the first
 * printf of the function, before anything else can clobber it.
 *
 * The snippet is deliberately parsed ONE TIME by every shell it may meet: a
 * single line is parsed whole before anything runs, so a construct one shell
 * cannot parse (a zsh array assignment under POSIX sh, say) would abort the
 * entire line with only a stderr message — which is invisible on a pipe. The
 * zsh arm therefore lives in its own variant, chosen by the caller after
 * asking the shell who it is.
 */
export const SHELL_INTEGRATION_BASH_COMMAND = [
  "__dsh_osc133(){ printf '\\033]133;D;%s\\007\\033]133;A\\007\\033]633;P;Cwd=%s\\007' \"$?\" \"$PWD\"; }",
  "PROMPT_COMMAND=\"__dsh_osc133${PROMPT_COMMAND:+;$PROMPT_COMMAND}\"",
  "PS1='\\[\\033]133;B\\007\\]'\"$PS1\""
].join("; ");

/** zsh flavour: precmd_functions is the zsh hook, and PS1 needs %{...%} wrapping. */
export const SHELL_INTEGRATION_ZSH_COMMAND = [
  "__dsh_osc133(){ printf '\\033]133;D;%s\\007\\033]133;A\\007\\033]633;P;Cwd=%s\\007' \"$?\" \"$PWD\"; }",
  "precmd_functions+=(__dsh_osc133)",
  "PS1=$'%{\\033]133;B\\007%}'\"$PS1\""
].join("; ");

/** Back-compat alias for callers that only ever target bash (and the tests). */
export const SHELL_INTEGRATION_COMMAND = SHELL_INTEGRATION_BASH_COMMAND;

/**
 * Pick the snippet for a shell family reported by the session's `$ZSH_VERSION`
 * probe: anything non-empty is zsh, everything else (bash, dash, sh) uses the
 * POSIX-compatible variant.
 */
export function shellIntegrationCommand(zshVersion) {
  return String(zshVersion ?? "").trim() === "" ? SHELL_INTEGRATION_BASH_COMMAND : SHELL_INTEGRATION_ZSH_COMMAND;
}

/** Extract the payload of `ESC ] <code> ; <rest> (BEL|ST)`. */
function readSequence(buffer) {
  if (!buffer.startsWith(OSC_START)) return null;
  const bel = buffer.indexOf(BEL, OSC_START.length);
  const st = buffer.indexOf(ST, OSC_START.length);
  let end = -1;
  let terminatorLength = 1;
  if (bel >= 0 && (st < 0 || bel < st)) {
    end = bel;
  } else if (st >= 0) {
    end = st;
    terminatorLength = 2;
  }
  if (end < 0) {
    return buffer.length > MAX_CARRY ? { skip: true } : { incomplete: true };
  }
  const payload = buffer.slice(OSC_START.length, end);
  return { payload, consumed: end + terminatorLength };
}

/** One session's shell-integration state. */
export class ShellIntegrationTracker {
  constructor() {
    this.state = {
      /** True between the prompt marker (A) and the input marker (B). */
      atPrompt: false,
      /** Exit status of the last finished command (OSC 133;D;<code>). */
      lastExitCode: null,
      /** Directory the shell reported last (OSC 633;P;Cwd=<path>). */
      cwd: null,
      /** ISO timestamp of the last command-finished marker. */
      lastCommandAt: null,
      /** How many command-finished markers have been seen. */
      commands: 0
    };
    this.carry = "";
  }

  /**
   * Feed one output chunk; returns the tracker itself so callers can chain.
   * Unknown OSC payloads are ignored, and a malformed escape is dropped rather
   * than poisoning the carry buffer.
   */
  feed(chunk) {
    let buffer = this.carry + String(chunk ?? "");
    this.carry = "";
    for (;;) {
      const escapeAt = buffer.indexOf("\x1b");
      if (escapeAt < 0) return this;
      const next = buffer.slice(escapeAt);
      if (next === "\x1b") { this.carry = next; return this; }          // possibly OSC split after ESC
      if (!next.startsWith(OSC_START)) {
        // Not an OSC introducer: drop one byte and keep scanning.
        buffer = buffer.slice(escapeAt + 1);
        continue;
      }
      const sequence = readSequence(next);
      if (sequence === null) { buffer = buffer.slice(escapeAt + 2); continue; }
      if (sequence.incomplete) { this.carry = next.slice(0, MAX_CARRY); return this; }
      if (sequence.skip) { buffer = buffer.slice(escapeAt + 1); continue; }
      buffer = buffer.slice(escapeAt + sequence.consumed);
      this.apply(sequence.payload);
    }
  }

  /** Apply one OSC payload ("133;D;0", "633;P;Cwd=/srv", …). */
  apply(payload) {
    const separator = payload.indexOf(";");
    const code = separator < 0 ? payload : payload.slice(0, separator);
    const rest = separator < 0 ? "" : payload.slice(separator + 1);
    if (code === "133") {
      const kind = rest.slice(0, 1);
      if (kind === "A") { this.state.atPrompt = true; return; }
      if (kind === "B") { this.state.atPrompt = false; return; }
      if (kind === "C") { this.state.atPrompt = false; return; }
      if (kind === "D") {
        this.state.atPrompt = false;
        this.state.commands += 1;
        this.state.lastCommandAt = new Date().toISOString();
        const value = rest.slice(2);
        const code2 = Number.parseInt(value, 10);
        if (Number.isFinite(code2)) this.state.lastExitCode = code2;
        return;
      }
      return;
    }
    if (code === "633" && rest.startsWith("P;Cwd=")) {
      this.state.cwd = rest.slice("P;Cwd=".length);
    }
  }

  /** Immutable snapshot for API results. */
  snapshot() {
    return { ...this.state };
  }
}
