import { COLORS } from "./rules.js";
import { normalizeCustomRules, MAX_CUSTOM_RULES } from "./custom-rules.js";
import { normalizeScheme, getScheme, defaultScheme, parseSchemeBackup } from "./scheme.js";

const KEY = "dsh-ssh-ops.terminal-display.v1";
const LEGACY_KEY = "dsh-ssh-ops.private-output-highlight.enabled";
const DEFAULTS = Object.freeze({ highlightEnabled: false, theme: "system" });
function parse(value) {
  try {
    const data = JSON.parse(value);
    if (typeof data?.highlightEnabled === "boolean" && ["system", "dark", "light"].includes(data.theme)) {
      const colors = {};
      for (const theme of ["dark", "light"]) {
        const overrides = {};
        for (const key of Object.keys(COLORS)) {
          const color = data.colors?.[theme]?.[key];
          if (typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)) overrides[key] = color.toLowerCase();
        }
        if (Object.keys(overrides).length) colors[theme] = Object.freeze(overrides);
      }
      const customRules = normalizeCustomRules(data.customRules);
      const schemes = {};
      for (const theme of ["dark", "light"]) {
        const scheme = normalizeScheme(data.schemes?.[theme]);
        if (scheme) schemes[theme] = scheme;
      }
      const backgrounds = {};
      for (const theme of ["dark", "light"]) {
        const color = data.backgrounds?.[theme];
        if (typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)) backgrounds[theme] = color.toLowerCase();
      }
      return Object.freeze({ ...(data.builtinEnabled === false ? { builtinEnabled: false } : {}),
        ...(Object.keys(schemes).length ? { schemes: Object.freeze(schemes) } : {}),
        ...(customRules.length ? { customRules: Object.freeze(customRules) } : {}), highlightEnabled: data.highlightEnabled, theme: data.theme,
        ...(Object.keys(backgrounds).length ? { backgrounds: Object.freeze(backgrounds) } : {}),
        ...(Object.keys(colors).length ? { colors: Object.freeze(colors) } : {}) });
    }
  } catch {}
  return DEFAULTS;
}

// One origin-wide snapshot for every connection and pane. Storage events
// propagate changes from other DSH windows; same-window changes notify directly.
export function createDisplaySettings({ storage, eventTarget = globalThis } = {}) {
  let snapshot = DEFAULTS;
  let lastStoredValue;
  try {
    storage ??= globalThis.localStorage;
    const saved = storage?.getItem(KEY);
    lastStoredValue = saved;
    snapshot = saved === null || saved === undefined
      ? Object.freeze({ ...DEFAULTS, highlightEnabled: storage?.getItem(LEGACY_KEY) === "true" })
      : parse(saved);
  } catch {}
  const listeners = new Set();
  const apply = (next) => {
    if (JSON.stringify(snapshot) === JSON.stringify(next)) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const refresh = () => {
    try {
      const saved = storage?.getItem(KEY);
      // Preserve in-memory changes when storage writes are blocked. Only an
      // actual change on disk should replace the local snapshot.
      if (saved !== lastStoredValue) {
        lastStoredValue = saved;
        apply(parse(saved));
      }
    } catch {}
  };
  const onStorage = (event) => {
    if ((event.key === KEY || event.key === null) && (!event.storageArea || event.storageArea === storage)) {
      // Read the current value: queued storage events may already be stale.
      refresh();
    }
  };
  return {
    getSnapshot: () => snapshot,
    update(patch) {
      refresh();
      const next = parse(JSON.stringify({ ...snapshot, ...(typeof patch === "function" ? patch(snapshot) : patch) }));
      try {
        const saved = JSON.stringify(next);
        storage?.setItem(KEY, saved);
        lastStoredValue = storage?.getItem(KEY);
      } catch {}
      apply(next);
    },
    subscribe(listener) {
      if (listeners.size === 0) {
        // A retained terminal may subscribe again after a different window
        // changed storage while no settings UI/terminal was listening.
        refresh();
        eventTarget.addEventListener?.("storage", onStorage);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) eventTarget.removeEventListener?.("storage", onStorage);
      };
    }
  };
}
const settings = createDisplaySettings();
export const getDisplaySettings = settings.getSnapshot;
export const setDisplaySettings = settings.update;
export const subscribeDisplaySettings = settings.subscribe;

export function restoreDisplayBackup(text) {
  const restored = parseSchemeBackup(text);
  settings.update((state) => {
    const schemes = { ...state.schemes };
    if (state.builtinEnabled === false) {
      const other = restored.theme === "dark" ? "light" : "dark";
      schemes[other] = getScheme(state, other);
    }
    schemes[restored.theme] = restored.entries;
    return { builtinEnabled: true, schemes, backgrounds: { ...state.backgrounds, [restored.theme]: restored.background } };
  });
  return restored.theme;
}

export function updateScheme(theme, update) {
  if (!["dark", "light"].includes(theme)) return;
  settings.update((state) => ({ schemes: { ...state.schemes,
    [theme]: normalizeScheme(update(getScheme(state, theme))) ?? getScheme(state, theme) } }));
}
export function resetScheme(theme) {
  updateScheme(theme, () => defaultScheme(theme));
}

/** Override one theme's terminal background (validated #rrggbb). */
export function setDisplayBackground(theme, color) {
  if (!["dark", "light"].includes(theme) || !/^#[0-9a-f]{6}$/i.test(color)) return;
  settings.update((state) => ({ backgrounds: { ...state.backgrounds, [theme]: color.toLowerCase() } }));
}
/** Drop one theme's background override (restores DSH's background). */
export function resetDisplayBackground(theme) {
  if (!["dark", "light"].includes(theme)) return;
  settings.update((state) => {
    const backgrounds = { ...state.backgrounds };
    delete backgrounds[theme];
    return { backgrounds: Object.keys(backgrounds).length ? backgrounds : undefined };
  });
}
/** Drop every background override, returning both themes to DSH's colors. */
export function resetDisplayBackgrounds() {
  settings.update(() => ({ backgrounds: undefined }));
}

export function setDisplayColor(theme, key, color) {
  if (!["dark", "light"].includes(theme) || !Object.hasOwn(COLORS, key) || !/^#[0-9a-f]{6}$/i.test(color)) return;
  settings.update((state) => ({ colors: { ...state.colors, [theme]: { ...state.colors?.[theme], [key]: color } } }));
}
export function resetDisplayColors(theme) {
  if (!["dark", "light"].includes(theme)) return;
  settings.update((state) => ({ colors: { ...state.colors, [theme]: {} } }));
}

export function saveDisplayRule(rule) {
  const [valid] = normalizeCustomRules([rule]);
  if (!valid) return false;
  let saved = false;
  settings.update((state) => {
    const rules = [...(state.customRules ?? [])];
    const index = rules.findIndex((item) => item.id === valid.id);
    if (index >= 0) rules[index] = valid;
    else if (rules.length < MAX_CUSTOM_RULES) rules.push(valid);
    else return {};
    saved = true;
    return { customRules: rules };
  });
  return saved;
}
export function deleteDisplayRule(id) {
  settings.update((state) => ({ customRules: (state.customRules ?? []).filter((rule) => rule.id !== id) }));
}
export function moveDisplayRule(id, direction) {
  settings.update((state) => {
    const rules = [...(state.customRules ?? [])], index = rules.findIndex((rule) => rule.id === id);
    const next = index + direction;
    if (![1, -1].includes(direction) || index < 0 || next < 0 || next >= rules.length) return {};
    [rules[index], rules[next]] = [rules[next], rules[index]];
    return { customRules: rules };
  });
}
