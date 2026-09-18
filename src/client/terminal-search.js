/**
 * Terminal search helpers: the copy and the option set the terminal pane uses.
 * The searching itself is xterm's search addon; this module owns what the
 * pane shows and which decorations are drawn, so both are unit-testable.
 */

/** Highlight colours that read on the light and dark terminal themes alike.
 *
 * Green, and translucent by design: the search addon can only paint a
 * background (it has no foreground option), so the text keeps whatever colour
 * the terminal gave it. An opaque amber fill left white text unreadable on a
 * dark theme; a green wash blends with the theme background instead, so light
 * text on dark and dark text on light both stay legible, and the focused match
 * is simply a denser mix of the same hue.
 */
export const SEARCH_DECORATIONS = Object.freeze({
  // Every match: a light wash that leaves the text contrast intact.
  matchBackground: "rgba(46, 160, 67, 0.32)",
  matchBorder: "rgba(46, 160, 67, 0.65)",
  matchOverviewRuler: "#2EA043",
  // The focused match: the same green, denser, with a bright edge. The alpha
  // stays below 1 on purpose — the addon cannot recolour the text, so a solid
  // fill would fight the terminal's own foreground; a 0.6 mix keeps light text
  // readable on a dark theme and dark text readable on a light one.
  activeMatchBackground: "rgba(35, 134, 54, 0.6)",
  activeMatchBorder: "#7EE787",
  activeMatchColorOverviewRuler: "#3FB950"
});

/**
 * The counting label next to the search box.
 * @param results - xterm's `{ resultIndex, resultCount }` (1-based index, -1 when none).
 * @param query - the current query text.
 * @returns "" while there is nothing to say, otherwise a short label.
 */
export function searchResultLabel(results, query) {
  const count = Number(results?.resultCount ?? 0);
  const index = Number(results?.resultIndex ?? -1);
  if (String(query ?? "").trim() === "") return "";
  if (count <= 0) return "无匹配";
  const position = index >= 0 && index < count ? index + 1 : 1;
  return `${position}/${count}`;
}

/** Find options shared by next/previous so both walks behave identically. */
export const SEARCH_FIND_OPTIONS = Object.freeze({
  decorations: SEARCH_DECORATIONS,
  // Searching from the current position is what a terminal reader expects as
  // they type; the alternative restarts from the top on every keystroke.
  incremental: true
});

// ── the shortcut: platform-aware, and never a plain readline binding ────────

/** macOS and iOS use the Command key; everyone else uses Control. */
export function isMacPlatform(platform) {
  return /Mac|iPhone|iPad|iPod/i.test(String(platform ?? ""));
}

/** The label a tooltip should show for this platform. */
export function searchShortcutLabel(isMac) {
  return isMac ? "⌘F" : "Ctrl+F";
}

/**
 * Does a keydown mean "open terminal search"?
 *
 * The platform's own modifier is required (⌘ on macOS, Ctrl elsewhere) plus F.
 * Ctrl+F is deliberately NOT taken on macOS: there it is readline's
 * forward-char, and a terminal that steals it breaks the shell's own editing
 * keys. Ctrl+Shift+F is accepted everywhere as well — the binding GNOME
 * Terminal and Windows Terminal use — so the feature is reachable even where
 * the reader's habit comes from those.
 * @param event - a KeyboardEvent-shaped object (`key`, `ctrlKey`, `metaKey`, `shiftKey`).
 * @param isMac - whether the platform uses the Command key.
 */
export function searchShortcutMatches(event, isMac) {
  const key = String(event?.key ?? "").toLowerCase();
  if (key !== "f") return false;
  if (event?.ctrlKey && event?.shiftKey) return true;
  return isMac ? Boolean(event?.metaKey) && !event?.ctrlKey : Boolean(event?.ctrlKey) && !event?.metaKey;
}

/** Options without decorations, for hosts that reject the proposed API. */
export const SEARCH_FIND_OPTIONS_PLAIN = Object.freeze({ incremental: true });

/**
 * Run one find, degrading gracefully: xterm gates the decoration (highlight)
 * API behind `allowProposedApi`, and a build without it throws instead of
 * searching. A reader searching for text should still get the jump, so the
 * first refusal retries without decorations and reports that it did.
 * @param search - the SearchAddon (or a test double).
 * @param text - the query.
 * @param options - `{ backwards, warn }`.
 * @returns `{ ok, decorated }` — whether a match was found, and whether
 *   highlights were drawn.
 */
export function runFind(search, text, { backwards = false, warn = () => {} } = {}) {
  const query = String(text ?? "").trim();
  if (query === "") return { ok: false, decorated: false };
  const attempt = (findOptions) => (backwards
    ? search.findPrevious(query, findOptions)
    : search.findNext(query, findOptions));
  try {
    return { ok: attempt(SEARCH_FIND_OPTIONS) !== false, decorated: true };
  } catch (error) {
    warn("terminal search: highlights unavailable, searching without decorations", error);
    try {
      return { ok: attempt(SEARCH_FIND_OPTIONS_PLAIN) !== false, decorated: false };
    } catch (plainError) {
      warn("terminal search: find failed", plainError);
      return { ok: false, decorated: false };
    }
  }
}
