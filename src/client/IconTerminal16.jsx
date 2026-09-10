/**
 * Terminal glyph in the official 16px outline style.
 *
 * The primitives package (`@deepseek-ai/dsh-client-ui-primitives`) has no
 * terminal icon, and the code glyph reads as a bare `#` next to the Files
 * tab's folder — so this plugin ships its own, drawn to match the official
 * set's conventions exactly:
 *
 * - 16×16 viewBox, root `fill="none"`, single-color `currentColor`
 * - the official glyphs' visual outline weight is 1.3px (IconFolderClose16's
 *   path offsets are ±0.65), reproduced here with `strokeWidth: 1.3`
 * - rounded caps/joins, matching the rounded corners of the folder outline
 *
 * Same props contract as the official icons ({ size = 16, className }) so the
 * guide body can render it interchangeably (`<Icon size={16} />`).
 */
import * as React from "react";

export function IconTerminal16({ size = 16, className }) {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {/* Terminal window, optically sized like IconFolderClose16 (outer ~14×12). */}
      <rect x="1.65" y="2.65" width="12.7" height="10.7" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      {/* Prompt chevron and cursor underscore share one baseline. */}
      <path d="M4.9 6.1L7.4 8L4.9 9.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.9 9.9H11.3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
