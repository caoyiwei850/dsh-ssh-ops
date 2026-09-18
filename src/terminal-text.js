/**
 * Terminal output → readable text.
 *
 * Session logs keep the raw byte stream on purpose (a recording must be
 * faithful), but printing those bytes verbatim shows unreadable debris:
 * escape sequences, and — worse — every line redraw. An interactive shell
 * re-prints its prompt by returning the carriage and erasing the line; a real
 * terminal shows one prompt, a naive viewer shows dozens.
 *
 * So this is a *line-oriented* renderer, not a screen emulator: it honours
 * carriage returns, backspaces, tab stops and "erase in line" (plus horizontal
 * cursor parking), which is what line-shaped output uses, and it removes every
 * other sequence. Cursor up/down, scroll regions and alternate screens are NOT
 * modelled — a full-screen TUI replays approximately, which is the documented
 * trade: readable logs, not pixel-faithful playback.
 */

// CSI with its final byte: parameter bytes, intermediates, then @-~ .
const CSI = /\u001b\[([0-?]*)([ -/]*)([@-~])/y;
// OSC payload up to BEL or ST; the terminator is optional because streams do
// contain markers whose payload runs straight into the next escape, and a
// stranded remnant is exactly the debris this module exists to remove.
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/y;
// Two-character escapes (charset selection, ESC =, ESC >) and ESC ( B.
const SHORT_ESCAPE = /\u001b[@-Z\\-_]|\u001b\([0-9A-Za-z]/y;

/** One line buffer with a cursor, matching how a terminal line behaves. */
class LineBuffer {
  constructor() {
    this.lines = [];
    this.chars = [];
    this.cursor = 0;
  }

  /** Write text at the cursor, appending and overwriting like a terminal row. */
  write(text) {
    for (const char of Array.from(text)) {
      if (this.cursor >= this.chars.length) {
        while (this.chars.length < this.cursor) this.chars.push(" ");
        this.chars.push(char);
      } else {
        this.chars[this.cursor] = char;
      }
      this.cursor += 1;
    }
  }

  carriageReturn() {
    this.cursor = 0;
  }

  backspace() {
    this.cursor = Math.max(0, this.cursor - 1);
  }

  tab() {
    const next = (Math.floor(this.cursor / 8) + 1) * 8;
    this.write(" ".repeat(next - this.cursor));
  }

  /** CSI n K — 0 (or absent): cursor→end, 1: start→cursor, 2: whole line. */
  eraseInLine(mode) {
    if (mode === 2) {
      this.chars = [];
      this.cursor = 0;
    } else if (mode === 1) {
      this.chars = this.chars.map((char, index) => (index < this.cursor ? " " : char));
    } else {
      this.chars.length = Math.min(this.chars.length, this.cursor);
    }
  }

  /** CSI n G — park the cursor at column n (1-based). */
  column(n) {
    this.cursor = Math.max(0, (Number(n) || 1) - 1);
  }

  newline() {
    this.lines.push(this.chars.join("").replace(/\s+$/, ""));
    this.chars = [];
    this.cursor = 0;
  }

  finish() {
    if (this.chars.length > 0 || this.cursor > 0) this.newline();
    return this.lines.join("\n");
  }
}

/** One stream of terminal output as readable text. */
export function toReadableText(raw) {
  const buffer = new LineBuffer();
  const input = String(raw ?? "");
  let index = 0;
  while (index < input.length) {
    if (input[index] === "\u001b") {
      const rest = input.slice(index);
      OSC.lastIndex = 0;
      const osc = OSC.exec(rest);
      if (osc !== null && osc.index === 0) { index += osc[0].length; continue; }
      CSI.lastIndex = 0;
      const csi = CSI.exec(rest);
      if (csi !== null && csi.index === 0) {
        const first = Number.parseInt(String(csi[1] ?? "").replace(/^[?>!]/, ""), 10);
        const final = csi[3];
        if (final === "K") buffer.eraseInLine(Number.isFinite(first) ? first : 0);
        else if (final === "G") buffer.column(Number.isFinite(first) ? first : 1);
        index += csi[0].length;
        continue;
      }
      SHORT_ESCAPE.lastIndex = 0;
      const short = SHORT_ESCAPE.exec(rest);
      if (short !== null && short.index === 0) { index += short[0].length; continue; }
      index += 1; // a lone ESC carries nothing readable
      continue;
    }

    const char = input[index];
    if (char === "\n") { buffer.newline(); index += 1; continue; }
    if (char === "\r") { buffer.carriageReturn(); index += 1; continue; }
    if (char === "\b") { buffer.backspace(); index += 1; continue; }
    if (char === "\t") { buffer.tab(); index += 1; continue; }
    const code = char.codePointAt(0);
    if (code < 32 || code === 127) { index += 1; continue; }

    // A printable run: take it in one go so the per-character buffer work is
    // paid once per run rather than once per character.
    let end = index;
    while (end < input.length) {
      const next = input[end];
      if (next === "\n" || next === "\r" || next === "\b" || next === "\t" || next === "\u001b") break;
      const nextCode = next.codePointAt(0);
      if (nextCode < 32 || nextCode === 127) break;
      end += 1;
    }
    buffer.write(input.slice(index, end));
    index = end;
  }
  return buffer.finish();
}

/**
 * Same treatment for one line — used by search hits, which arrive as raw lines
 * straight out of the log file.
 */
export function readableLine(line) {
  return toReadableText(line).trimEnd();
}
