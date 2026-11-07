// terminal-appearance-semantic.mjs — TESTS.md §2 语义断言 + fixtures 样例
//
// 直接跑仓库真实的 matcher 管线（互斥优先级、上下文门控、accept 过滤、
// 选项/权限子段着色都由 matcher.js 实现），对 HIGHLIGHT_RULES 与默认方案
// 验证 SPEC/TESTS 的语义契约。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { matchText as rawMatchText } from "../src/client/terminal-display/matcher.js";
import { COLORS } from "../src/client/terminal-display/rules.js";
import { compileScheme, defaultScheme } from "../src/client/terminal-display/scheme.js";

const here = dirname(fileURLToPath(import.meta.url));
const samplesDir = join(here, "fixtures", "terminal-appearance");

// matcher 输出的是最终前景色；断言以类别标识符表达（TESTS.md 的语义级断言）。
// 这里只把默认色表反查回类别 id，管线本身仍是仓库真实实现。
const HEX_TO_ID = new Map(Object.entries(COLORS).map(([id, hex]) => [hex, id]));
const matchText = (text, rules, colors, limit) =>
  rawMatchText(text, rules, colors, limit).map((span) => ({
    ...span,
    color: HEX_TO_ID.get(span.color) ?? span.color,
  }));
const readSample = (name) => readFileSync(join(samplesDir, name), "utf8").split(/\r?\n/);

const promptLines = readSample("prompt-and-commands.txt");
const serviceLines = readSample("service-log.txt");
const listingLines = readSample("file-listing.txt");

test("compiled defaults preserve fixture tokenization used by the worker", () => {
  const compiled = compileScheme(defaultScheme("dark"));
  for (const line of [...promptLines, ...serviceLines, ...listingLines]) {
    assert.deepEqual(rawMatchText(line, compiled.rules, compiled.colors), rawMatchText(line), line);
  }
});

test("quoted pipelines stay opaque and sudo flags do not consume command arguments", () => {
  const compiled = compileScheme(defaultScheme("dark"));
  const line = 'host$ echo "foo | ERROR"';
  const quoted = line.indexOf('"');
  const spans = rawMatchText(line, compiled.rules, compiled.colors);
  assert.ok(spans.some((s) => s.start === quoted && s.end === line.length && s.color === COLORS.string));
  const command = "host$ sudo -n systemctl status app";
  const commands = rawMatchText(command, compiled.rules, compiled.colors)
    .filter((s) => s.color === COLORS.command).map((s) => command.slice(s.start, s.end));
  assert.deepEqual(commands, ["systemctl"]);
});

test("IPv6 compression at either edge is recognized and invalid groups are rejected", () => {
  const compiled = compileScheme(defaultScheme("dark"));
  for (const address of ["::", "::1", "2001:db8::", "fe80::abcd", "2001:db8:0:0:0:0:0:1"]) {
    assert.deepEqual(rawMatchText(address, compiled.rules, compiled.colors),
      [{ start: 0, end: address.length, color: COLORS.heading }], address);
  }
  for (const address of ["1::2::3", "12345::", "1:2:3:4:5:6:7:8:9"]) {
    assert.ok(!rawMatchText(address, compiled.rules, compiled.colors).some((s) => s.color === COLORS.heading), address);
  }
});

// 子串 occurrence 的类别：要求存在恰好覆盖该子串的 span
function catOf(line, substring, occurrence = 0) {
  const spans = matchText(line);
  let from = 0;
  let idx = -1;
  for (let i = 0; i <= occurrence; i++) {
    idx = line.indexOf(substring, from);
    if (idx < 0) return undefined;
    from = idx + 1;
  }
  const span = spans.find((s) => s.start === idx && s.end === idx + substring.length);
  return span?.color;
}

function assertCat(line, substring, category, occurrence = 0) {
  const got = catOf(line, substring, occurrence);
  assert.equal(got, category, `expected ${category}("${substring}"#${occurrence}) in: ${line} (got ${got})`);
}

function assertNoCat(line, substring, category) {
  const got = catOf(line, substring);
  assert.notEqual(got, category, `expected ~${category}("${substring}") in: ${line}`);
}

function assertMutuallyExclusive(line) {
  const spans = matchText(line);
  for (let i = 1; i < spans.length; i++) {
    assert.ok(
      spans[i].start >= spans[i - 1].end,
      `overlapping spans in: ${line} -> ${JSON.stringify(spans)}`
    );
  }
}

function assertNoContextSpans(line) {
  const spans = matchText(line);
  for (const cat of ["command", "option", "prompt"]) {
    assert.ok(
      !spans.some((s) => s.color === cat),
      `unexpected ${cat} span in non-prompt line: ${line} -> ${JSON.stringify(spans)}`
    );
  }
}

// ---------------------------------------------------------------------------
// §2.1 日志级别与结果词（service-log.txt）
// ---------------------------------------------------------------------------

test("service-log: error 类别", () => {
  assertCat(serviceLines[0], "INFO", "info"); // sanity：行定位正确
  assertCat(serviceLines[1], "ERROR", "error");
  assertCat(serviceLines[1], "authentication failed", "error");
  assertCat(serviceLines[1], "incorrect", "error");
  assertCat(serviceLines[6], "FATAL", "error");
  assertCat(serviceLines[5], "failed", "error");
  assertCat(serviceLines[5], "cannot open", "error");
  assertCat(serviceLines[12], "Operation not permitted", "error");
  assertCat(serviceLines[13], "No such file or directory", "error");
  assertCat(serviceLines[14], "not supported", "error");
  assertCat(serviceLines[11], "failed", "error"); // "0 failed"
});

test("service-log: success 类别", () => {
  assertCat(serviceLines[3], "successful", "success");
  assertCat(serviceLines[10], "OK", "success");
  assertCat(serviceLines[7], "in sync", "success");
  assertCat(serviceLines[15], "exit code", "success");
  assertCat(serviceLines[11], "completed", "success");
});

test("service-log: warning 类别", () => {
  assertCat(serviceLines[2], "WARN", "warning");
  assertCat(serviceLines[2], "rate limit reached", "warning");
  assertCat(serviceLines[15], "warning", "warning"); // "1 warning"
  assertCat(serviceLines[6], "terminated", "warning");
  assertCat(serviceLines[8], "Connection closed", "warning");
  assertCat(serviceLines[11], "skipped", "warning");
  assertCat(promptLines[8], "sudo", "warning"); // sudo 作为特权提示词（样例位于提示符行）
});

test("service-log: info 类别", () => {
  assertCat(serviceLines[0], "connection", "info");
  assertCat(serviceLines[3], "login", "info");
  assertCat(serviceLines[1], "password", "info");
  assertCat(serviceLines[7], "replication", "info");
});

test("service-log: 否定短语整体优先，无相反命中", () => {
  // "not supported" 整体为 error，内部不得拆出 success("supported")
  assertCat(serviceLines[14], "not supported", "error");
  assertNoCat(serviceLines[14], "supported", "success");
  assertNoCat(serviceLines[10], "OK", "error");
  assertNoCat(serviceLines[3], "successful", "error");
  assertNoCat(serviceLines[5], "failed", "success");
});

// ---------------------------------------------------------------------------
// §2.2 结构性 token（service-log.txt）
// ---------------------------------------------------------------------------

test("service-log: 地址与日期时间", () => {
  assertCat(serviceLines[0], "203.0.113.9", "heading");
  assertCat(serviceLines[3], "198.51.100.23", "heading");
  assertCat(serviceLines[8], "2001:db8:85a3::8a2e:370:7334", "heading");
  assertCat(serviceLines[9], "52:54:00:1b:9c:f2", "heading");
  assertCat(serviceLines[0], "2026-11-06", "heading");
  assertCat(serviceLines[0], "08:15:42", "heading");
  assertCat(serviceLines[10], "2026/11/06", "heading");
  assertCat(serviceLines[8], "Nov", "heading");
  assertCat(promptLines[2], "Tue", "heading");
  // 端口号独立为 number，IP 整体仍为 heading，IP 的数字段不得独立命中 number
  assertNoCat(serviceLines[0], "203.0.113.9:51444", "heading");
  assertCat(serviceLines[0], "51444", "number");
  assertNoCat(serviceLines[0], "203.0.113.9", "number");
  // 形似而非地址
  assertNoCat(serviceLines[4], "session:9f31c2a7", "heading");
  assertNoCat(serviceLines[4], "key session:9f31c2a7", "heading");
});

test("service-log: 形状校验拒绝形似而神不似者", () => {
  // 256.300.1.1 之类的非法 IPv4 不得命中 heading
  const spans = matchText("bad addr 999.1.1.1 and 256.300.1.1 here");
  assert.ok(!spans.some((s) => s.color === "heading"));
});

// ---------------------------------------------------------------------------
// §2.3 数字（service-log.txt）
// ---------------------------------------------------------------------------

test("service-log: number 类别", () => {
  assertCat(serviceLines[2], "128", "number");
  assertCat(serviceLines[6], "536870912", "number");
  assertCat(serviceLines[7], "0.4", "number");
  assertCat(serviceLines[10], "3", "number"); // "3ms" 中仅 3
  assertCat(serviceLines[9], "1000", "number"); // "1000Mb/s" 中仅 1000
  assertCat(serviceLines[11], "47", "number");
  assertCat(serviceLines[11], "50", "number");
  assertCat(serviceLines[11], "3", "number");
  assertCat(serviceLines[11], "0", "number", 1); // "0 failed"（"0" 首次出现在 "50" 中）
  assertCat(serviceLines[10], "200", "number"); // "status=200" 值子段之外的时间… 该行内独立数字
  assertCat(serviceLines[10], "8443", "number");
  assertCat(serviceLines[15], "0", "number", 1); // "exit code 0" 的 0（首次出现在 "0 errors"）
  assertCat(serviceLines[4], "9f31c2a7", "number"); // 十六进制字面量
  // 1000Mb/s 只命中 1000，Mb 不吞入
  const spans = matchText(serviceLines[9]);
  const s1000 = spans.find((s) => s.color === "number" && serviceLines[9].slice(s.start, s.end) === "1000");
  assert.ok(s1000, "number(1000) expected");
  // 时间分量 08 不单独命中（被 time span 互斥占用）
  assert.equal(catOf(serviceLines[0], "08"), undefined);
});

// ---------------------------------------------------------------------------
// §2.4 命令行上下文（prompt-and-commands.txt）
// ---------------------------------------------------------------------------

test("prompt: 命令与管道段首", () => {
  assertCat(promptLines[0], "systemctl", "command");
  assertCat(promptLines[3], "tail", "command");
  assertCat(promptLines[3], "grep", "command"); // "| grep" 管道段首
  assertCat(promptLines[9], "tee", "command"); // "| tee" 管道段首
  assertCat(promptLines[4], "rsync", "command");
  assertCat(promptLines[6], "chmod", "command");
  assertCat(promptLines[6], "echo", "command"); // "&& echo"
  assertCat(promptLines[10], "node", "command");
  assertCat(promptLines[11], "make", "command");
  assertCat(promptLines[8], "psql", "command"); // sudo 包装后的命令
  assertCat(promptLines[9], "./run-tests.sh", "command");
});

test("prompt: 提示符尾符仅命中尾符", () => {
  assertCat(promptLines[0], "$", "prompt");
  assertCat(promptLines[8], "#", "prompt");
  // 行内其他提示符符号（如 2>&1 的 >）不得误判为 prompt
  const spans = matchText(promptLines[9]);
  const gt = promptLines[9].indexOf(">", promptLines[9].indexOf("2>"));
  const covering = spans.find((s) => s.start === gt && s.color === "prompt");
  assert.equal(covering, undefined, "inline > must not be prompt");
  assert.equal(spans.find((s) => s.start === gt)?.color, "heading");
});

test("prompt: 选项与选项值子段", () => {
  assertCat(promptLines[4], "-avz", "option");
  assertCat(promptLines[4], "--progress", "option");
  assertCat(promptLines[3], "-n", "option");
  assertCat(promptLines[5], "-r", "option"); // grep -r
  assertCat(promptLines[8], "-u", "option");
  assertCat(promptLines[8], "-d", "option");
  assertCat(promptLines[8], "-h", "option");
  // --key=value 拆分子段着色：键→option、等号→heading、值按其自身类别（number）
  assertCat(promptLines[10], "--port", "option");
  assertCat(promptLines[9], "--suite", "option");
  const line = promptLines[10];
  const spans = matchText(line);
  const eq = line.indexOf("=");
  assert.equal(spans.find((s) => s.start === eq)?.color, "heading");
  const valueStart = eq + 1;
  assert.equal(
    spans.find((s) => s.start === valueStart && s.end === valueStart + "8080".length)?.color,
    "number"
  );
  // 2>&1：数字/运算符拆分子段
  assertCat(promptLines[9], ">", "heading");
});

test("prompt: 引号串与路径", () => {
  assertCat(promptLines[3], '"500"', "string");
  assertCat(promptLines[5], '"connection refused"', "string");
  assertCat(promptLines[6], '"done"', "string");
  assertCat(promptLines[9], "~/results.txt", "string");
  assertCat(promptLines[3], "/var/log/nginx/access.log", "string");
  assertCat(promptLines[4], "./build/", "string");
  assertCat(promptLines[4], "/srv/www/", "string");
  assertCat(promptLines[6], "/usr/local/bin/deploy.sh", "string");
  assertCat(promptLines[11], "/opt/app", "string");
});

test("非提示符行：上下文规则全部不生效", () => {
  assertNoContextSpans(promptLines[1]); // "● nginx.service …"
  assertNoContextSpans(promptLines[2]); // "Active: active (running) …"
  assertNoContextSpans(promptLines[7]); // "done"
  assertNoContextSpans(serviceLines[0]); // 日志行
});

// ---------------------------------------------------------------------------
// §2.5 权限位串（file-listing.txt）
// ---------------------------------------------------------------------------

test("listing: 权限位串逐字符着色", () => {
  const cases = [
    { line: listingLines[1], perm: "drwxr-xr-x" }, // 目录
    { line: listingLines[3], perm: "-rwxr-xr-x" },
    { line: listingLines[5], perm: "lrwxrwxrwx" }, // 软链
    { line: listingLines[6], perm: "srw-------" }, // socket
    { line: listingLines[7], perm: "-rw-r-----+" }, // ACL +
    { line: listingLines[9], perm: "drwxrwsr-x" }, // setgid
  ];
  for (const { line, perm } of cases) {
    const spans = matchText(line);
    const base = line.indexOf(perm);
    assert.ok(base >= 0, `permission string ${perm} in: ${line}`);
    for (let i = 0; i < perm.length; i++) {
      const ch = perm[i];
      let expected;
      if (i === 0) expected = "debug"; // 类型位
      else if (ch === "r") expected = "info";
      else if (ch === "w") expected = "warning";
      else if ("xsStT".includes(ch)) expected = "error";
      else if (ch === "-" || ch === "+" || ch === ".") expected = "heading";
      const span = spans.find((s) => s.start === base + i && s.end === base + i + 1);
      assert.equal(span?.color, expected, `${perm}[${i}]=${ch} in: ${line}`);
    }
  }
  // setuid/setgid/sticky 特殊位：s/S/t/T → error（已在 drwxrwsr-x 中覆盖 s）
  // 文件名、属主、大小、日期列不受影响：逐行互斥且日期仍是 heading
  assertCat(listingLines[3], "deploy", undefined) ?? true;
  assertCat(listingLines[1], "Nov", "heading");
});

test("listing: 软链箭头与目标", () => {
  assertCat(listingLines[5], "->", "heading"); // operator
  assertCat(listingLines[5], "build-2041", "string"); // 目标按 string 语义
});

// ---------------------------------------------------------------------------
// §2.6 互斥与优先级
// ---------------------------------------------------------------------------

test("所有样例行 span 两两互斥", () => {
  for (const line of [...promptLines, ...serviceLines, ...listingLines]) {
    if (line.trim().length === 0) continue;
    assertMutuallyExclusive(line);
  }
});

test("引号串覆盖内部单词（password incorrect）", () => {
  const quoted = `note: "password incorrect" done`;
  const spans = matchText(quoted);
  const start = quoted.indexOf('"');
  const span = spans.find((s) => s.start === start && s.end === start + '"password incorrect"'.length);
  assert.equal(span?.color, "string");
  assert.equal(catOf(quoted, "incorrect"), undefined);
});

test("(status=200, upstream=10.0.0.15:8443) 的子段语义", () => {
  const line = serviceLines[10];
  const spans = matchText(line);
  const text = line;
  // 括号/逗号 → operator（heading 类别）
  for (const ch of ["(", ")", ","]) {
    const idx = text.indexOf(ch);
    assert.equal(spans.find((s) => s.start === idx)?.color, "heading", `operator ${ch}`);
  }
  // status=200 按 option 拆分子段
  assertCat(line, "status", "option");
  assertCat(line, "200", "number"); // 选项值由数值规则按其类别着色
  // upstream=... 的值是地址：结构化 token 优先，IP 为 heading、端口为 number
  assertCat(line, "10.0.0.15", "heading");
  assertCat(line, "8443", "number");
});

test("长模式先于短模式（not supported / rate limit reached）", () => {
  const spans = matchText(serviceLines[14]);
  const idx = serviceLines[14].indexOf("not supported");
  const span = spans.find((s) => s.start === idx && s.end === idx + "not supported".length);
  assert.equal(span?.color, "error");
  const spans2 = matchText(serviceLines[2]);
  const idx2 = serviceLines[2].indexOf("rate limit reached");
  const span2 = spans2.find((s) => s.start === idx2 && s.end === idx2 + "rate limit reached".length);
  assert.equal(span2?.color, "warning");
});
