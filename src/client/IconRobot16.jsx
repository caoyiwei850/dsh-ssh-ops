/**
 * Robot-head glyph for the "the agent is using this connection" badge.
 *
 * Drawn as an outline rather than the solid-sheet style of the guide's terminal
 * icon: this glyph renders at ~13px inside a text-sized pill, and a filled
 * silhouette at that size loses the eyes and reads as a plain rounded box.
 *
 * `currentColor` throughout, so the badge's own colour drives the glyph and it
 * stays legible on both Sidebar themes without a second palette.
 *
 * Same props contract as the other plugin icons ({ size, className }).
 */
import * as React from "react";

export function IconRobot16({ size = 13, className }) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* antenna, so the silhouette is a robot and not a rounded rectangle */}
      <path d="M8 5.1V2.9" />
      <circle cx="8" cy="2" r="0.95" fill="currentColor" stroke="none" />
      <rect x="2.7" y="5.2" width="10.6" height="7.7" rx="2.2" />
      {/* ears */}
      <path d="M2.7 8.2H1.5" />
      <path d="M13.3 8.2h1.2" />
      {/* eyes: filled, because a stroked eye closes up at this size */}
      <circle cx="5.95" cy="9" r="1.05" fill="currentColor" stroke="none" />
      <circle cx="10.05" cy="9" r="1.05" fill="currentColor" stroke="none" />
    </svg>
  );
}
