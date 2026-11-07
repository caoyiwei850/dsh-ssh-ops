import { useEffect, useMemo, useRef, useState } from "react";
import { acquireRegexMatcher } from "./regex-runner.js";

export function useRegexMatches(entries, text) {
  const lease = useRef(null);
  const texts = useMemo(() => text.split("\n"), [text]);
  const [result, setResult] = useState({ lines: [], error: "" });
  useEffect(() => {
    const current = acquireRegexMatcher(); lease.current = current;
    return () => { current.release(); lease.current = null; };
  }, []);
  useEffect(() => {
    let current = true;
    // Keep the previous colours on screen while the next match runs; clearing
    // first makes the preview flicker on every keystroke.
    const timer = setTimeout(() => {
      lease.current?.match(entries, texts).then((value) => {
        if (!current || value.cancelled) return;
        if (value.error) setResult({ lines: [], error: value.error });
        else setResult({ lines: value.lines ?? [], error: "" });
      });
    }, 80);
    return () => { current = false; clearTimeout(timer); };
  }, [entries, texts]);
  return result;
}
