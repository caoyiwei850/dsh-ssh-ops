import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/client/SshResources.jsx", import.meta.url), "utf8");

assert.match(source, /const \[expandedGroups, setExpandedGroups\] = useState\(\(\) => new Set\(\)\)/, "resources keep an independent expanded-group view state");
assert.match(source, /const toggleGroup = \(key\) =>/, "each group has a collapse toggle");
assert.match(source, /const collapsed = !expandedGroups\.has\(key\)/, "groups are collapsed by default until opened");
assert.match(source, /aria-expanded=\{!collapsed\}/, "group headers expose their expansion state");
assert.match(source, /group:\$\{group\.groupId\}/, "saved groups have stable collapse keys");
assert.match(source, /const key = "ungrouped"/, "ungrouped resources can be collapsed too");
assert.match(source, /collapsed \? "▸" : "▾"/, "the header shows its expanded/collapsed state");

console.log("resource group collapse: keyboard-accessible grouped and ungrouped sections passed");
