/**
 * Terminal glyph in the official outline style (currentColor, medium stroke).
 *
 * The primitives package (`@deepseek-ai/dsh-client-ui-primitives`) has no
 * terminal icon, so this plugin ships its own, drawn to match the official
 * set's conventions exactly:
 *
 * - 16×16 viewBox with 1.3px stroke, the official medium-stroke language
 * - DeepSeek brand blue (`--dsw-static-deepseek-500`), the same token the
 *   host's start-page guide icons use (New terminal, Browser) — requested
 *   after the outline/currentColor variant read as plain text next to them
 * - the settings-nav mask keeps `currentColor`; only this guide glyph is blue
 * - geometry scaled from the former 28×28 filled sheet (rect and prompt marks
 *   divided by 1.75), so the mark itself is unchanged
 *
 * Same props contract as the official icons ({ size = 16, className }).
 */
import * as React from "react";

export function IconTerminal16({ size = 16, className }) {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" stroke="var(--dsw-static-deepseek-500, #4176e6)" aria-hidden="true">
      <rect x="1.6" y="3" width="12.8" height="10" rx="2.4" strokeWidth="1.3" />
      <path d="M5 6.17L6.94 8L5 9.83" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.46 9.86H11.03" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
