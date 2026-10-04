/**
 * Browser-side language binding.
 *
 * The shared core in `src/i18n/core.js` holds the active language and the
 * dictionaries; this module only adapts it to React and to the DSH locale
 * service, and it is the single place the client bundle reads the language
 * selection from.
 *
 * DSH itself knows exactly two languages (`LOCALE_IDS = ["zh", "en"]` in
 * `@deepseek-ai/dsh-client-locale`), so "follow DSH Settings → Language" is a
 * plain read of its active locale rather than a mapping table. A user who
 * installs a third-party DSH language pack still gets one of these two, which
 * is why the combobox offers no "auto" entry: the two languages are the whole
 * surface the plugin supports.
 */
import { useSyncExternalStore } from "react";
import {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  LANGUAGE_LABELS,
  getLanguage,
  normalizeLanguage,
  setLanguage,
  subscribeLanguage,
  t
} from "../i18n/core.js";

export { t, setLanguage, getLanguage, normalizeLanguage, subscribeLanguage, LANGUAGES, LANGUAGE_LABELS, DEFAULT_LANGUAGE };

/** Snapshot identity must be stable across renders, so cache per language. */
const SNAPSHOTS = new Map(LANGUAGES.map((id) => [id, Object.freeze({ language: id })]));

function getSnapshot() {
  return SNAPSHOTS.get(getLanguage()) ?? SNAPSHOTS.get(DEFAULT_LANGUAGE);
}

/**
 * Subscribe a component to the active language. Every panel component calls
 * this, so a change in Settings → SSH Resources repaints the whole plugin
 * immediately, without a page reload.
 */
export function useLanguage() {
  return useSyncExternalStore(subscribeLanguage, getSnapshot).language;
}

/**
 * The language DSH itself is showing. `getSnapshot().active` is the documented
 * read (`ctx.locale.getSnapshot()`); older builds expose `getLocale()`. Either
 * may be missing in a legacy drawer-mode host, in which case the caller's
 * fallback applies.
 */
export function readHostLanguage(locale) {
  try {
    const snapshot = locale?.getSnapshot?.();
    if (snapshot && typeof snapshot.active === "string") return normalizeLanguage(snapshot.active);
    const direct = locale?.getLocale?.();
    if (typeof direct === "string") return normalizeLanguage(direct);
  } catch {
    // A host without a locale face must not break the settings page.
  }
  return null;
}
