import { t } from "../i18n/core.js";
/**
 * Remote-file editor policy: what may open in the text editor, and how its
 * bytes become editor text and back. Kept out of the JSX so the decisions run
 * in plain Node tests — the panel only renders whatever this module allows.
 */
/** Largest file the text editor will open, matching mainstream ops tools. */
export const MAX_EDITABLE_BYTES = 10 * 1024 * 1024;

/** How far into the file a NUL byte still marks it as binary. */
export const BINARY_PROBE_BYTES = 8000;

/** A NUL byte in the first probe window is the cheap, reliable binary tell. */
export function looksBinary(bytes) {
  const window = bytes.subarray(0, Math.min(bytes.length, BINARY_PROBE_BYTES));
  for (let index = 0; index < window.length; index += 1) {
    if (window[index] === 0) return true;
  }
  return false;
}

/**
 * Turn remote bytes into editable text.
 * @param bytes - the file contents as read from SFTP.
 * @returns `{ ok: true, text, replaced }` (`replaced` flags U+FFFD from
 *   invalid UTF-8, which saving would rewrite) or `{ ok: false, reason }`.
 */
export function decodeEditableText(bytes) {
  if (bytes.length > MAX_EDITABLE_BYTES) {
    return { ok: false, reason: t(`The file is ${bytes.length} bytes, over the ${Math.round(MAX_EDITABLE_BYTES / 1024 / 1024)} MB editing limit; download it and edit locally, or use a command-line tool`) };
  }
  if (looksBinary(bytes)) {
    return { ok: false, reason: t("This looks like a binary file (null byte within the first 8 KB); not opening it in the text editor") };
  }
  // A UTF-8 BOM is an encoding marker, not content: strip it so the editor
  // does not show it and a save does not stack a second one.
  const body = bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF
    ? bytes.subarray(3)
    : bytes;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(body);
  return { ok: true, text, replaced: text.includes("\uFFFD") };
}

/** Editor text back to bytes for the SFTP write path (UTF-8, no BOM). */
export function encodeEditableText(text) {
  return new TextEncoder().encode(text);
}

/** Case-insensitive substring filter over the current directory listing. */
export function filterEntries(entries, query) {
  const needle = String(query ?? "").trim().toLowerCase();
  if (needle === "") return entries;
  return entries.filter((entry) => String(entry?.name ?? "").toLowerCase().includes(needle));
}
