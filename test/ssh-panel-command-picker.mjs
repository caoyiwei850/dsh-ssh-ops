import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The command library is a panel tab, not a popover over the connection tabs.
// Keep its render-state declaration in the panel itself so it remains usable
// after a successful connection has made a server active.
const source = await readFile(new URL("../src/client/SshPanel.jsx", import.meta.url), "utf8");
const panelSource = source.slice(source.indexOf("export function SshPanel"));

assert.match(
  panelSource,
  /\["snippets", "快捷命令"\]/,
  "command library must have its own panel tab"
);
assert.match(
  panelSource,
  /const \[snippetQuery, setSnippetQuery\] = useState\(""\);/,
  "command picker search state must be declared"
);
assert.doesNotMatch(panelSource, /snippetPickerOpen|snippetMenu/, "command library must not overlay the connection tabs");
assert.match(panelSource, /＋ 自定义/, "custom commands must be managed inside the command-library tab");
assert.doesNotMatch(source.slice(0, source.indexOf("export function SshPanel")), /snippetPickerOpen/, "the connection dialog must not own command-library state");

console.log("ssh panel command picker state: passed");
