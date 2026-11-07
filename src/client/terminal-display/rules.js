// rules.js — 内置语义分类的默认配色与识别规则集
//
// 本文件为独立设计产物：所有颜色值、关键词表、正则模式均依据 SPEC.md 的语义
// 定义与通用终端常识推导，不含任何第三方终端项目的派生内容。
//
// 规则数组的排列即互斥优先级（靠前优先），语义等价于 SPEC §4.4：
//   结构性 token（引号串/路径/权限位串）→ 选项拆分子段 →
//   否定短语 → 类别单词 → 命令行上下文（提示符/命令）→
//   地址/日期时间 → 软链目标 → 十六进制 → 数字 → 运算符。

// ---------------------------------------------------------------------------
// 默认配色（SPEC §5.1 独立推导；WCAG AA ≥ 4.5:1 见 tools/check-contrast.mjs）
// ---------------------------------------------------------------------------

export const COLORS = Object.freeze({
  error: "#ef6f6c",
  success: "#53c177",
  warning: "#e2a944",
  info: "#7aa2f0",
  heading: "#45bdd1",
  number: "#dd8a4e",
  string: "#3fb896",
  option: "#9a8cf0",
  command: "#aab4c8",
  prompt: "#c78ef0",
  debug: "#8a919e",
});

export const LIGHT_COLORS = Object.freeze({
  error: "#c43e39",
  success: "#247a48",
  warning: "#8a6106",
  info: "#3363c4",
  heading: "#1a7286",
  number: "#a85a20",
  string: "#1e7a5f",
  option: "#5b4bb5",
  command: "#4a5568",
  prompt: "#8a3fa8",
  debug: "#5c6470",
});

export function colorsForTheme(theme, overrides = {}) {
  const base = theme === "light" ? LIGHT_COLORS : COLORS;
  const merged = { ...base };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (Object.hasOwn(base, key) && /^#[0-9a-f]{6}$/i.test(String(value))) {
      merged[key] = String(value).toLowerCase();
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// 词表（SPEC §4.1/§4.2；通用日志级别英文单词与运维常用词，大小写不敏感整词匹配）
// ---------------------------------------------------------------------------

const ERROR_PHRASES = [
  "not supported",
  "no such file or directory",
  "operation not permitted",
  "authentication failed",
  "cannot open",
  "permission denied",
  "access denied",
  "connection refused",
  "timed out",
];

const ERROR_WORDS = [
  "fatal", "panic", "panicked", "failed", "failure", "error",
  "denied", "invalid", "cannot", "incorrect", "refused",
  "unreachable", "timeout", "aborted", "missing",
];

const SUCCESS_PHRASES = ["in sync", "exit code"];

const SUCCESS_WORDS = [
  "success", "successful", "succeeded", "passed", "ok", "yes",
  "valid", "completed", "complete", "done", "active",
];

const WARNING_PHRASES = ["rate limit reached", "connection closed", "link down"];

const WARNING_WORDS = [
  "warn", "warning", "sudo", "terminated", "skipped", "killed", "privileged",
];

const INFO_WORDS = [
  "info", "login", "connection", "password", "replication", "authenticated",
  "accepted", "listening", "ready",
];

const DEBUG_WORDS = ["debug", "trace", "verbose"];

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// ---------------------------------------------------------------------------
// 形状校验（SPEC §4.2：接受校验回调过滤形似而神不似者）
// ---------------------------------------------------------------------------

function isIpv4(text) {
  const parts = text.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function isIpv6(text) {
  if (!/^[0-9a-fA-F:]+$/.test(text) || !text.includes(":")) return false;
  const groups = (s) => (s ? s.split(":") : []);
  const validGroup = (g) => /^[0-9a-fA-F]{1,4}$/.test(g);
  if (text.includes("::")) {
    const halves = text.split("::");
    if (halves.length !== 2) return false;
    const left = groups(halves[0]);
    const right = groups(halves[1]);
    if (left.length + right.length > 7) return false;
    return [...left, ...right].every(validGroup);
  }
  const gs = groups(text);
  return gs.length === 8 && gs.every(validGroup);
}

function isMac(text) {
  const parts = text.split(":");
  return parts.length === 6 && parts.every((p) => /^[0-9a-fA-F]{2}$/.test(p));
}

function isCalendarDate(text) {
  const m = /^(\d{4})[-/](\d{2})[-/](\d{2})$/.exec(text);
  if (!m) return false;
  const month = Number(m[2]);
  const day = Number(m[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function isClockTime(text) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!m) return false;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = m[3] === undefined ? 0 : Number(m[3]);
  return h <= 23 && min <= 59 && s <= 59;
}

// ---------------------------------------------------------------------------
// 正则构造辅助
// ---------------------------------------------------------------------------

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 词/短语规则：整词边界、大小写不敏感、长词先于短词（避免前缀词截断，如
// "warning" 必须先于 "warn" 尝试，虽然 \\b 已能兜底，保持显式稳定序）。
function wordPattern(words) {
  const sorted = [...words].sort((a, b) => b.length - a.length);
  return new RegExp(`\\b(?:${sorted.map(escapeRegExp).join("|")})\\b`, "gi");
}

// ---------------------------------------------------------------------------
// 内置识别规则集（数组顺序 = 互斥优先级，SPEC §4.4）
// ---------------------------------------------------------------------------

export const HIGHLIGHT_RULES = Object.freeze([
  // —— 结构性 token（先于其组成 token）——

  {
    id: "string.quoted",
    color: "string",
    pattern: /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g,
  },

  // —— 命令行上下文：命令词先于路径解释（./run-tests.sh 归 command）；
  //      特权词 sudo/doas 由负向前瞻让给 warning 词类，其后真正的命令名
  //      由 sudo 分支的 lookbehind 取得 ——

  {
    id: "command.name",
    color: "command",
    context: true,
    // 提示符/管道段首的命令词；sudo/doas 后跳过其选项再取真正的命令名
    // （lookbehind 停在命令词之前，避免把参数误标为命令）。
    pattern: /(?<=^\S{1,24}(?:\s{1,3})?[$#%>]\s|[|&]\s)(?!(?:sudo|doas)\b)[^\s|&;]+|(?<=(?:sudo|doas)\s+(?:(?:-[A-Za-z]*[ughpCTrt]\s+\S+|-\S+)\s+)*)(?!-)[^\s|&;]+/g,
  },
  {
    id: "prompt.tail",
    color: "prompt",
    context: true,
    pattern: /(?<=^\S{1,24}(?:\s{1,3})?)[$#%>](?=\s)/g,
  },
  {
    id: "fs.path",
    color: "string",
    context: true,
    // 命令位的 token 已由 command.name 认领，这里只处理普通参数中的路径。
    pattern: /(?<![\w/])(?<![$#%>]\s)(?<![|&]\s)(?<!(?:sudo|doas)\s)(?:~(?=\/)|\.{1,2}(?=\/))?\/[^\s|&;)"']*/g,
  },

  // —— 文件权限位串（逐字符着色；先于词类，路径/词互不抢）——

  {
    id: "fs.permissions",
    color: "debug",
    permissions: true,
    pattern: /(?<![\w-])[dlbcps-][rwxsStT-]{9}[+.]?/g,
  },

  // —— 命令行选项（--key=value 拆分子段：键→option、等号→heading；值由后续
  //      number/路径等规则按其自身类别着色，SPEC §4.2/§2.3+§2.6）——

  {
    id: "option.value",
    color: "option",
    option: true,
    pattern: /(?<![\w-])(?:-{1,2}[\w-]+|[^\s=|&()]+)=(?=[\w./~@-]+)/g,
  },
  {
    id: "option.flag",
    color: "option",
    context: true,
    pattern: /(?<![\w-])-{1,2}[\w-]+/g,
  },

  // —— 词类类别：否定/多词短语先于肯定单词（SPEC §4.2/§4.4）——

  { id: "error.phrases", color: "error", pattern: wordPattern(ERROR_PHRASES) },
  { id: "error.words", color: "error", pattern: wordPattern(ERROR_WORDS) },
  { id: "success.phrases", color: "success", pattern: wordPattern(SUCCESS_PHRASES) },
  { id: "success.words", color: "success", pattern: wordPattern(SUCCESS_WORDS) },
  { id: "warning.phrases", color: "warning", pattern: wordPattern(WARNING_PHRASES) },
  { id: "warning.words", color: "warning", pattern: wordPattern(WARNING_WORDS) },
  { id: "info.words", color: "info", pattern: wordPattern(INFO_WORDS) },
  { id: "debug.words", color: "debug", pattern: wordPattern(DEBUG_WORDS) },

  {
    id: "net.ipv6",
    color: "heading",
    accept: isIpv6,
    pattern: /(?<![\w:])(?:[0-9a-fA-F]{0,4}:){2,}[0-9a-fA-F]{0,4}(?![\w:])/g,
  },
  {
    id: "net.ipv4",
    color: "heading",
    accept: isIpv4,
    pattern: /\b\d{1,3}(?:\.\d{1,3}){3}\b/g,
  },
  {
    id: "net.mac",
    color: "heading",
    accept: isMac,
    pattern: /\b[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5}\b/g,
  },
  {
    id: "time.date",
    color: "heading",
    accept: isCalendarDate,
    pattern: /\b\d{4}[-/]\d{2}[-/]\d{2}\b/g,
  },
  {
    id: "time.clock",
    color: "heading",
    accept: isClockTime,
    pattern: /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,
  },
  {
    id: "time.name",
    color: "heading",
    pattern: new RegExp(`\\b(?:${[...MONTH_NAMES, ...WEEKDAY_NAMES].join("|")})\\b`, "g"),
  },

  // —— 软链目标（"-> " 之后按 string 语义着色；先于数值规则避免端口/编号被拆走）——

  {
    id: "fs.symlink-target",
    color: "string",
    pattern: /(?<=-> )[^\s|&;]+/g,
  },

  // —— 数值：十六进制字面量（须含数字与字母，避免吞并普通单词），其后纯数字 ——

  {
    id: "number.hex",
    color: "number",
    pattern: /\b(?=[0-9a-fA-F]*[0-9])(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{4,}\b/g,
  },
  {
    id: "number.value",
    color: "number",
    pattern: /\b\d+(?:\.\d+)?%?(?![\d.])/g,
  },

  // —— shell 运算符（含 ->、&&；不含 = 与 :，避免与选项子段/时间争抢）——

  {
    id: "shell.operator",
    color: "heading",
    pattern: /->|&&|[|&><;(),[\]]/g,
  },
]);
