import { compileScheme } from "./scheme.js";
import { matchText } from "./matcher.js";

let previous, compiled;
self.onmessage = ({ data }) => {
  try {
    const signature = JSON.stringify(data.entries);
    if (signature !== previous) { previous = signature; compiled = compileScheme(data.entries); }
    let remaining = 4096;
    const lines = data.texts.map((text) => {
      if (remaining <= 0) return [];
      const spans = matchText(text, compiled.rules, compiled.colors, remaining);
      remaining -= spans.length;
      return spans;
    });
    self.postMessage({ id: data.id, lines });
  } catch { self.postMessage({ id: data.id, error: "invalid-regex" }); }
};
self.postMessage({ ready: true });
