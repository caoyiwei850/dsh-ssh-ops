/**
 * i18n coverage checker: keeps the t() call sites and the English dictionary
 * in sync. Reports four classes of drift and exits non-zero on the first two:
 *
 *   missing   — a t() call whose key has no dictionary entry (renders Chinese
 *               in English mode; usually a freshly added string)
 *   unwrapped — a user-facing Chinese string literal that never goes through
 *               t() at all (never translates)
 *   orphan    — a dictionary entry no call site uses (dead weight)
 *   dynamic   — a t() call with a non-literal argument (the checker cannot see
 *               its keys; avoid this pattern)
 *
 * Usage: npm run i18n:extract [-- --quiet]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "espree";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const quiet = process.argv.includes("--quiet");

function* walkFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "i18n") continue; // the dictionary itself
      yield* walkFiles(p);
    } else if (/\.(js|jsx)$/.test(name)) yield p;
  }
}

function walk(node, visit, parent = null) {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const item of node) walk(item, visit, parent); return; }
  if (typeof node.type !== "string") return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "parent" || key === "range" || key === "loc") continue;
    walk(node[key], visit, node);
  }
}

const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff01-\uff5e]/;
const PARSER_OPTIONS = { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true }, loc: true, range: true };

/** Rebuild a template's source text (quasis + ${expr}) from the AST. */
function templateSource(node, source) {
  let out = "";
  for (let i = 0; i < node.quasis.length; i++) {
    out += node.quasis[i].value.raw;
    if (i < node.expressions.length) {
      out += "${" + source.slice(node.expressions[i].range[0], node.expressions[i].range[1]) + "}";
    }
  }
  return out;
}

/**
 * Normalize a template key for comparison: the pattern engine matches on the
 * literal segments only (every ${…} becomes an anonymous capture), so two
 * templates with the same literal parts are the same key even when their
 * expressions differ textually. Nested ${…} inside an interpolation is
 * consumed by the same brace counting the engine uses.
 */
function normalizeKey(key) {
  let out = "";
  let index = 0;
  while (index < key.length) {
    const start = key.indexOf("${", index);
    if (start === -1) {
      out += key.slice(index);
      break;
    }
    out += key.slice(index, start) + "\u0000";
    let depth = 0;
    let cursor = start + 1;
    for (; cursor < key.length; cursor++) {
      if (key[cursor] === "{") depth++;
      else if (key[cursor] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    index = cursor + 1;
  }
  return out;
}

const callKeys = new Map(); // normalized key → [file:line, …]
const unwrapped = [];
const dynamic = [];

for (const abs of walkFiles(join(root, "src"))) {
  const file = relative(root, abs);
  const source = readFileSync(abs, "utf8");
  if (file === "client/locale.js") continue; // the binding module (label data, not UI)
  const sourceLines = source.split("\n");
  // Identifier convention: `// i18n-identifier` on a line, or a
  // `// i18n-identifier-start` … `// i18n-identifier-end` range, marks string
  // literals that are stable IDENTIFIERS at declaration (compared downstream)
  // and reach t() dynamically at their display sites. They count as used and
  // are exempt from the unwrapped check, but their dictionary entries stay
  // mandatory — dropping one breaks the display translation silently.
  const identifierLines = new Set();
  let inIdentifierRange = false;
  for (let i = 0; i < sourceLines.length; i++) {
    const line = sourceLines[i];
    if (line.includes("i18n-identifier-start")) inIdentifierRange = true;
    if (line.includes("i18n-identifier-end")) { inIdentifierRange = false; identifierLines.add(i); continue; }
    if (inIdentifierRange || line.includes("i18n-identifier")) identifierLines.add(i);
  }
  const ast = parse(source, PARSER_OPTIONS);
  const wrappedNodes = new Set();
  walk(ast, (node) => {
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "t") {
      for (const argument of node.arguments) wrappedNodes.add(argument);
    }
  });
  walk(ast, (node, parent) => {
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "t") {
      const [argument] = node.arguments;
      if (argument?.type === "Literal" && typeof argument.value === "string") {
        push(callKeys, normalizeKey(argument.value), `${file}:${node.loc.start.line}`);
      } else if (argument?.type === "TemplateLiteral") {
        const key = templateSource(argument, source);
        push(callKeys, normalizeKey(key), `${file}:${node.loc.start.line}`);
      } else if (node.arguments.length > 0) {
        dynamic.push(`${file}:${node.loc.start.line}`);
      }
      return;
    }
    // Chinese strings that never reach t().
    const isString = (node.type === "Literal" && typeof node.value === "string")
      || (node.type === "TemplateLiteral" && node.quasis.some((q) => CJK.test(q.value.cooked ?? "")));
    if (!isString || wrappedNodes.has(node)) return;
    const value = node.type === "Literal" ? node.value : templateSource(node, source);
    if (!CJK.test(value)) return;
    if (parent?.type === "Property" && node === parent.key && !parent.computed) return;
    if (parent?.type === "ImportDeclaration" || parent?.type === "ExportAllDeclaration") return;
    if (parent?.type === "ExportNamedDeclaration" && parent.source === node) return;
    const startLine = node.loc.start.line - 1;
    if (identifierLines.has(startLine)) {
      // Declared identifier consumed via t(variable) elsewhere: count as used.
      push(callKeys, normalizeKey(value), `${file}:${node.loc.start.line}`);
      return;
    }
    // Opt-out marker for strings that must stay outside the dictionary: host
    // DOM sniffers (they match the HOST's labels, not ours) and the host
    // locale registration consumed by DSH itself.
    if (sourceLines[startLine]?.includes("i18n-ignore")) return;
    unwrapped.push(`${file}:${node.loc.start.line}  ${value.slice(0, 70)}`);
  });
}

function push(map, key, where) {
  const list = map.get(key) ?? [];
  list.push(where);
  map.set(key, list);
}

// pathToFileURL: on Windows a plain `D:\…` path is parsed as a URL with
// protocol "d:" and the dynamic import dies with ERR_UNSUPPORTED_ESM_URL_SCHEME
// (same class as the checker-path fix from PR #28, one level deeper).
const { en } = await import(pathToFileURL(join(root, "src/i18n/messages.en.js")).href);

const dictNormalized = new Map(Object.keys(en).map((key) => [normalizeKey(key), key]));
const missing = [...callKeys.entries()].filter(([key]) => !dictNormalized.has(key)).map(([key, where]) => `${where.join(", ")}  ${key.slice(0, 70)}`);
const orphan = Object.keys(en).filter((key) => !callKeys.has(normalizeKey(key)));

if (missing.length > 0) {
  console.error(`✖ missing dictionary entries (${missing.length}):`);
  for (const line of missing) console.error("  " + line);
}
if (unwrapped.length > 0) {
  console.error(`✖ Chinese strings not passed through t() (${unwrapped.length}):`);
  for (const line of unwrapped) console.error("  " + line);
}
if (dynamic.length > 0 && !quiet) {
  console.warn(`⚠ dynamic t() keys (not statically checkable, ${dynamic.length}):`);
  for (const line of dynamic) console.warn("  " + line);
}
if (orphan.length > 0 && !quiet) {
  console.warn(`⚠ orphan dictionary entries (${orphan.length}):`);
  for (const key of orphan) console.warn("  " + key.slice(0, 70));
}

const status = missing.length === 0 && unwrapped.length === 0 ? "clean" : "drift";
if (!quiet) console.log(`i18n: ${callKeys.size} keys, ${Object.keys(en).length} dictionary entries — ${status}`);
process.exitCode = missing.length === 0 && unwrapped.length === 0 ? 0 : 1;
