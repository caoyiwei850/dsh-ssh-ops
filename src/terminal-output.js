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
    },
    readRange(after, maxBytes) {
      const start = end - text.length;
      const bounded = Number.isSafeInteger(maxBytes) ? maxBytes : 32768;
      let from = Number.isSafeInteger(after) ? Math.max(start, Math.min(end, after)) : start;
      const cursorClamped = Number.isSafeInteger(after) && after < start;
      let available = text.slice(from - start);
      let bytes = Buffer.from(available, 'utf8');
      if (!Number.isSafeInteger(after) && bytes.length > bounded) {
        bytes = bytes.subarray(bytes.length - bounded);
        while (bytes.length > 0 && (bytes[0] & 0xc0) === 0x80) bytes = bytes.subarray(1);
        available = bytes.toString('utf8');
        from = end - available.length;
      } else if (bytes.length > bounded) {
        bytes = bytes.subarray(0, bounded);
        while (bytes.length > 0 && (bytes[bytes.length - 1] & 0xc0) === 0x80) bytes = bytes.subarray(0, bytes.length - 1);
        available = bytes.toString('utf8');
      }
      const nextOffset = from + available.length;
      return { data: available, journalStartOffset: start, journalEndOffset: end, startOffset: from, nextOffset, cursorClamped, hasMore: nextOffset < end };
    }
  };
  journal.append(initial);
  return journal;
}
