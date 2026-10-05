/**
 * One-shot codemod: wrap every user-facing Chinese string in `t()` so the
 * i18n layer (src/i18n/core.js) can translate it when English is selected.
 *
 * Handled shapes:
 *  - string literals        → t("已连接")
 *  - template literals      → t(`已连接 ${host}`)   (interpolated values ride along)
 *  - JSX attribute values   → title={t("刷新")}
 *  - JSX text               → <span>{t("会话日志")}</span>
 *  - JSX text⇄expression runs → 共 {n} 台  becomes  {t(`共 ${n} 台`)}
 *
 * Skipped: comments (never in the AST), import specifiers, object property
 * keys, strings already inside a t() call, and the exclusion list below
 * (the i18n modules themselves and client/index.jsx, handled by hand).
 *
 * Idempotent: running it twice changes nothing.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { relative, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parse as espreeParse } from "espree";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXCLUDE = new Set([
  "src/i18n/core.js",
  "src/i18n/messages.en.js",
  "src/client/locale.js",
  "src/client/index.jsx"
]);
const files = execFileSync("git", ["ls-files", "src"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .map((f) => f.trim())
  .filter((f) => f.endsWith(".js") || f.endsWith(".jsx"));

const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff01-\uff5e]/;
const PARSER_OPTIONS = { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true }, loc: true, range: true };

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

const insideT = new Set();     // node ids already an argument of t(...)
const insideImport = new Set();

function analyze(ast) {
  walk(ast, (node) => {
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "t") {
      for (const argument of node.arguments) {
        if (argument.type === "Literal" || argument.type === "TemplateLiteral") insideT.add(argument);
      }
    }
    if (node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration" || node.type === "ExportNamedDeclaration") {
      if (node.source) insideImport.add(node.source);
    }
  });
}

function literalIsValue(node, parent) {
  if (parent === null) return true;
  if (parent.type === "Property") return node !== parent.key || parent.computed;
  if (parent.type === "MemberExpression") return node === parent.property && parent.computed;
  if (parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") return false;
  return true;
}

function escapeTemplateText(text) {
  return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

let totalWrapped = 0;
const perFile = [];

for (const file of files) {
  if (EXCLUDE.has(file)) continue;
  const abs = join(root, file);
  const source = readFileSync(abs, "utf8");
  let ast;
  try {
    ast = espreeParse(source, PARSER_OPTIONS);
  } catch (error) {
    console.error(`SKIP (parse error) ${file}: ${error.message}`);
    continue;
  }

  insideT.clear();
  insideImport.clear();
  analyze(ast);

  /** [start, end, replacement] */
  const edits = [];
  let count = 0;

  const wrapLiteral = (node, parent = null) => {
    const wrapped = `t(${source.slice(node.range[0], node.range[1])})`;
    // A string attribute value must become a JSX expression container.
    const replacement = parent?.type === "JSXAttribute" ? `{${wrapped}}` : wrapped;
    edits.push([node.range[0], node.range[1], replacement]);
    count += 1;
  };

  const collect = () => {
    walk(ast, (node, parent) => {
      // Plain string literal with CJK.
      if (node.type === "Literal" && typeof node.value === "string" && CJK.test(node.value)
        && !insideT.has(node) && !insideImport.has(node) && literalIsValue(node, parent)) {
        wrapLiteral(node, parent);
        return;
      }
      // Whole template literal with CJK in any cooked quasi (with or without
      // expressions — interpolated values ride along inside t(`…${x}…`)).
      if (node.type === "TemplateLiteral" && !insideT.has(node)
        && node.quasis.some((quasi) => quasi.value.cooked !== null && CJK.test(quasi.value.cooked))) {
        edits.push([node.range[0], node.range[1], `t(${source.slice(node.range[0], node.range[1])})`]);
        count += 1;
        return;
      }
    });
  };

  // JSX: merge consecutive [JSXText | JSXExpressionContainer] runs that contain
  // CJK into one {t(`text${expr}text`)} container.
  const collectJsxRuns = () => {
    walk(ast, (node) => {
      if (node.type !== "JSXElement" && node.type !== "JSXFragment") return;
      const children = node.children ?? [];
      let index = 0;
      while (index < children.length) {
        const run = [];
        while (index < children.length
          && (children[index].type === "JSXText" || children[index].type === "JSXExpressionContainer")) {
          run.push(children[index]);
          index += 1;
        }
        if (run.length === 0) { index += 1; continue; }
        const hasCjk = run.some((child) => child.type === "JSXText" && CJK.test(child.value));
        // A lone expression container (no text) is left alone; a lone
        // non-CJK text run is left alone.
        if (!hasCjk) continue;
        let template = "";
        let onlyText = true;
        for (const child of run) {
          if (child.type === "JSXText") {
            template += escapeTemplateText(child.value);
          } else {
            onlyText = false;
            template += "${" + source.slice(child.expression.range[0], child.expression.range[1]) + "}";
          }
        }
        template = template.replace(/^\s+/, "").replace(/\s+$/, "");
        const start = run[0].range[0];
        const end = run[run.length - 1].range[1];
        const replacement = onlyText ? `{t(${JSON.stringify(template)})}` : "{t(`" + template + "`)}";
        edits.push([start, end, replacement]);
        count += 1;
      }
    });
  };

  collect();
  collectJsxRuns();

  if (edits.length === 0) continue;

  // Apply bottom-up so earlier ranges stay valid.
  edits.sort((a, b) => b[0] - a[0]);
  let output = source;
  let lastStart = Infinity;
  for (const [start, end, replacement] of edits) {
    if (end > lastStart) continue; // overlapping (JSX run vs literal inside it) — run wins
    output = output.slice(0, start) + replacement + output.slice(end);
    lastStart = start;
  }

  // Add the t import after the last import declaration unless present.
  if (!/\bimport\s*\{[^}]*\bt\b[^}]*\}\s*from\s*["'][^"']*i18n/.test(output)
    && !/import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*["']\.\/locale\.js["']/.test(output)) {
    let lastImportEnd = 0;
    walk(ast, (node) => {
      if (node.type === "ImportDeclaration") lastImportEnd = Math.max(lastImportEnd, node.range[1]);
    });
    const rel = relative(dirname(abs), join(root, "src/i18n/core.js")).replace(/\\/g, "/");
    // Safe: insert relative to the same offset in output (edits never touch the import block).
    output = output.slice(0, lastImportEnd) + `\nimport { t } from "${rel.startsWith(".") ? rel : "./" + rel}";` + output.slice(lastImportEnd);
  }

  writeFileSync(abs, output);
  totalWrapped += count;
  perFile.push(`${file}: ${count}`);
}

console.log(perFile.join("\n"));
console.log(`\ncodemod: ${totalWrapped} strings wrapped across ${perFile.length} files`);
