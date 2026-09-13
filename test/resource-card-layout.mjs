import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/client/SshResources.jsx", import.meta.url), "utf8");

assert.doesNotMatch(source, /指纹校验：\{HOST_KEY_MODE_LABELS/, "the resource card omits the long host-key mode summary");
assert.doesNotMatch(source, /credentialConfigured \? "凭据已保存"/, "the resource card omits authentication and credential-status summaries");
assert.match(source, /cardActions: \{ display: "flex", flexWrap: "nowrap", flexShrink: 0/, "card actions remain a single non-shrinking row");

console.log("resource card layout: concise metadata and single-row actions passed");
