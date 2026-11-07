import { compileScheme } from "./scheme.js";
import { matchText } from "./matcher.js";

let previous, compiled;
self.onmessage = ({ data }) => {
  try {
    const signature = JSON.stringify(data.entries);
    if (signature !== previous) { previous = signature; compiled = compileScheme(data.entries); }
    let remaining = 4096;
    const lines = data.texts.map(() => []);
    for (let index = data.texts.length - 1; index >= 0 && remaining > 0; index--) {
      const spans = matchText(data.texts[index], compiled.rules, compiled.colors, remaining);
      remaining -= spans.length;
      lines[index] = spans;
    }
    self.postMessage({ id: data.id, lines });
  } catch { self.postMessage({ id: data.id, error: "invalid-regex" }); }
};
self.postMessage({ ready: true });
