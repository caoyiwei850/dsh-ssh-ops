/** Bounded terminal history with UTF-16 offsets, shared by independent readers. */
export function createTerminalOutput(initial = '', maxBytes = 1024 * 1024) {
  let text = '';
  let end = 0;
  const limit = Number.isFinite(maxBytes) ? Math.max(0, maxBytes) : 1024 * 1024;
  const journal = {
    append(chunk) {
      end += chunk.length;
      const bytes = Buffer.from(text + chunk, 'utf8');
      let start = Math.max(0, bytes.length - limit);
      // Never retain half a UTF-8 code point: offsets must match decoded text.
      while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
      text = bytes.subarray(start).toString('utf8');
    },
    read(after) {
      const start = end - text.length;
      let from = Number.isSafeInteger(after) ? Math.min(end, Math.max(start, after)) : start;
      // A caller cannot start in the middle of a surrogate pair.
      const code = text.charCodeAt(from - start);
      if (code >= 0xdc00 && code <= 0xdfff) from++;
      return { data: text.slice(from - start), startOffset: from, offset: end };
    }
  };
  journal.append(initial);
  return journal;
}
