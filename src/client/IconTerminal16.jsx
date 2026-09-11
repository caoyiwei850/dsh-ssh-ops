/**
 * Terminal glyph in the official Sidebar guide's filled-sheet style.
 *
 * The primitives package (`@deepseek-ai/dsh-client-ui-primitives`) has no
 * terminal icon, and the code glyph reads as a bare `#` next to the Files
 * tab's folder — so this plugin ships its own, drawn to match the official
 * set's conventions exactly:
 *
 * - 28×28 viewBox, like the official FileTypeIcon artwork used by the Files
 *   guide entry
 * - DeepSeek-blue solid sheet with white marks, so it has the same visual
 *   weight as the official amber folder rather than the former thin outline
 * - semantic static tokens rather than hard-coded colors, so it remains stable
 *   across the light and dark Sidebar themes
 *
 * Same props contract as the official icons ({ size = 16, className }) so the
 * guide body can render it interchangeably (`<Icon size={16} />`).
 */
import * as React from "react";

export function IconTerminal16({ size = 16, className }) {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 28 28" fill="none" aria-hidden="true">
      {/* The solid terminal face mirrors FileTypeIcon's coloured folder sheet. */}
      <rect x="2.8" y="5.25" width="22.4" height="17.5" rx="4.2" fill="var(--dsw-static-deepseek-500)" />
      {/* White prompt and cursor follow the file glyphs' high-contrast inner marks. */}
      <path d="M8.75 10.8L12.15 14L8.75 17.2" stroke="var(--dsw-static-neutral-00)" strokeWidth="2.15" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14.8 17.25H19.3" stroke="var(--dsw-static-neutral-00)" strokeWidth="2.15" strokeLinecap="round" />
    </svg>
  );
}
