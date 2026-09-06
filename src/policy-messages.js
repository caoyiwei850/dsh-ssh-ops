/**
 * Single source for the host-side policy strings that reach the terminal and
 * the agent tool results. They are user-facing Chinese today; migrating them
 * onto the client locale dictionaries (zh/en) is tracked in docs/roadmap.md.
 */

export function policyBlockedReason(category) {
  return `安全策略已阻止：${category}。请勿重试/绕行，由操作者在右侧终端确认执行。`;
}

/** Enter blocked because the local line mirror is untrustworthy. */
export const UNVERIFIED_LINE_REASON =
  "安全策略已阻止：无法验证历史命令或自动补全后的内容。请手动输入只读诊断命令。";

/** Prefix of the notice appended to the terminal buffer on a policy block. */
export const POLICY_NOTICE_PREFIX = "[DSH SSH 安全策略]";

/** Default reason for the blocked-command confirmation card. */
export const DANGEROUS_DEFAULT_REASON = "危险操作";
