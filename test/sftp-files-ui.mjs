// SFTP panel additions: the editor's byte policy (size cap, binary refusal,
// BOM handling), the favorites store, the listing filter — plus a source-level
// contract for the JSX wiring (no DOM in this suite, matching the repo style).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  BINARY_PROBE_BYTES,
  MAX_EDITABLE_BYTES,
  decodeEditableText,
  encodeEditableText,
  filterEntries,
  looksBinary
} from "../src/client/file-editor.js";
import { favoritesKey, readFavorites, toggleFavorite, writeFavorites } from "../src/client/sftp-favorites.js";

const utf8 = (text) => new TextEncoder().encode(text);

// ── editor byte policy ──────────────────────────────────────────────────────
assert.equal(MAX_EDITABLE_BYTES, 10 * 1024 * 1024);

{
  const text = "server { listen 80; }\n";
  const decoded = decodeEditableText(utf8(text));
  assert.deepEqual(decoded, { ok: true, text, replaced: false });
  assert.deepEqual([...encodeEditableText(decoded.text)], [...utf8(text)], "text survives the round trip byte for byte");

  const bom = decodeEditableText(Uint8Array.from([0xEF, 0xBB, 0xBF, ...utf8("配置")]));
  assert.equal(bom.ok, true);
  assert.equal(bom.text, "配置", "a UTF-8 BOM is stripped, not shown as content");
  assert.equal(bom.replaced, false);

  const binary = decodeEditableText(Uint8Array.from([0x7F, 0x45, 0x4C, 0x46, 0x00, 0x01]));
  assert.equal(binary.ok, false);
  assert.match(binary.reason, /二进制/);

  const invalid = decodeEditableText(Uint8Array.from([0x41, 0xC3, 0x28, 0x42]));
  assert.equal(invalid.ok, true);
  assert.equal(invalid.replaced, true, "invalid UTF-8 is flagged so the UI can warn about a rewrite");

  const empty = decodeEditableText(new Uint8Array(0));
  assert.deepEqual(empty, { ok: true, text: "", replaced: false });

  const big = decodeEditableText(new Uint8Array(MAX_EDITABLE_BYTES + 1));
  assert.equal(big.ok, false);
  assert.match(big.reason, /编辑上限/);

  const beyondWindow = new Uint8Array(BINARY_PROBE_BYTES + 10).fill(0x41);
  beyondWindow[BINARY_PROBE_BYTES + 5] = 0;
  assert.equal(looksBinary(beyondWindow), false, "a NUL beyond the probe window is not inspected");
  assert.equal(looksBinary(Uint8Array.from([0, ...new Uint8Array(BINARY_PROBE_BYTES)])), true);
}

// ── listing filter ──────────────────────────────────────────────────────────
{
  const entries = [{ name: "nginx.conf" }, { name: "NGINX.d" }, { name: "app.log" }];
  assert.equal(filterEntries(entries, "").length, 3);
  assert.equal(filterEntries(entries, "   ").length, 3);
  assert.deepEqual(filterEntries(entries, "nginx").map((e) => e.name), ["nginx.conf", "NGINX.d"]);
  assert.deepEqual(filterEntries(entries, ".log").map((e) => e.name), ["app.log"]);
  assert.deepEqual(filterEntries(entries, "missing"), []);
}

// ── favorites store ─────────────────────────────────────────────────────────
{
  assert.equal(favoritesKey({ host: "10.0.0.1", port: 22, username: "ops" }), "dsh-ssh-ops:sftp-favorites:ops@10.0.0.1:22");
  assert.equal(favoritesKey({ host: "10.0.0.1", port: 2222 }), "dsh-ssh-ops:sftp-favorites:-@10.0.0.1:2222");
  assert.equal(favoritesKey({ port: 22 }), null, "a connection without a host has no stable key");
  assert.equal(favoritesKey(undefined), null);

  const store = new Map();
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, value); }
  };
  const key = "k";

  assert.deepEqual(readFavorites(storage, key), []);
  writeFavorites(storage, key, ["/etc/nginx", "/var/log"]);
  assert.deepEqual(readFavorites(storage, key), ["/etc/nginx", "/var/log"]);

  storage.setItem(key, "{not json");
  assert.deepEqual(readFavorites(storage, key), [], "corrupt storage reads as no favorites");
  storage.setItem(key, JSON.stringify(["/a", "/a", "relative", 42, "/b", ""]));
  assert.deepEqual(readFavorites(storage, key), ["/a", "/b"], "duplicates, non-strings and relative entries are dropped");

  const throwing = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("quota"); }
  };
  assert.deepEqual(readFavorites(throwing, key), []);
  assert.doesNotThrow(() => writeFavorites(throwing, key, ["/x"]), "a full/blocked storage must not break the panel");
  assert.doesNotThrow(() => writeFavorites(storage, null, ["/x"]));
  assert.deepEqual(readFavorites(storage, null), []);

  assert.deepEqual(toggleFavorite(["/a"], "/b"), { paths: ["/a", "/b"], added: true });
  assert.deepEqual(toggleFavorite(["/a", "/b"], "/a"), { paths: ["/b"], added: false });
  assert.deepEqual(toggleFavorite(["/a"], "  "), { paths: ["/a"], added: false });
  assert.deepEqual(toggleFavorite(["/a"], "/a"), { paths: [], added: false });
}

// ── JSX contract: the panel wires exactly these behaviours ──────────────────
{
  const files = await readFile(new URL("../src/client/SshFiles.jsx", import.meta.url), "utf8");
  const checks = [
    [/from "\.\/file-editor\.js"/, "the editor policy module is imported"],
    [/from "\.\/sftp-favorites\.js"/, "the favorites module is imported"],
    [/onDragOver=\{.*setDragActive\(true\)/, "dragging over the list highlights the drop zone"],
    [/onDrop=\{[\s\S]{0,260}upload\(files\)/, "dropping files uploads them through the existing path"],
    [/visibleEntries = entries === null \? null : filterEntries\(entries, filter\)/, "the filter narrows the rendered listing"],
    [/openEditor\(entry\)/, "file rows offer the editor"],
    [/api\.sftpReadFile\(connectionId, path, MAX_EDITABLE_BYTES \+ 1\)/, "the editor reads with the size cap as its bound"],
    [/encodeEditableText\(editing\.text\)/, "saving writes the editor text as UTF-8 bytes"],
    [/fresh\.mtime !== editing\.mtime[\s\S]{0,120}confirm/, "a moved mtime asks before overwriting"],
    [/toggleFavorite\(favorites, cwd\)/, "the star pins the current directory"],
    [/writeFavorites\(globalThis\.localStorage, favoritesStorageKey, next\)/, "favorites persist per server key"],
    [/readFavorites\(globalThis\.localStorage, key\)/, "favorites load from storage on connect"],
    [/favorites\.map\(\(path\) => \(/, "pinned paths render as chips"]
  ];
  for (const [pattern, label] of checks) {
    assert.match(files, pattern, `SshFiles.jsx: ${label}`);
  }
}

console.log("sftp files ui: editor policy, favorites store, filter and JSX wiring all passed");
