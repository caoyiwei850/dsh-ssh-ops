
/**
 * Single source for the host-side policy strings that reach the terminal and
 * the agent tool results. These constants are IDENTIFIERS as much as text:
 * keep them as stable Chinese literals and translate at the display site
 * (t(...)), so language can never change what downstream logic compares.
 */
import { t } from "./i18n/core.js";

export function policyBlockedReason(category) {
  return t(`安全策略已阻止：${t(category)}。请勿重试/绕行，由操作者在右侧终端确认执行。`);
}

/** Enter blocked because the local line mirror is untrustworthy. */
export const UNVERIFIED_LINE_REASON =
  "安全策略已阻止：无法验证历史命令或自动补全后的内容。请手动输入只读诊断命令。"; // i18n-identifier

/** Prefix of the notice appended to the terminal buffer on a policy block. */
export const POLICY_NOTICE_PREFIX = "[DSH SSH 安全策略]"; // i18n-identifier

/** Default reason for the blocked-command confirmation card. */
export const DANGEROUS_DEFAULT_REASON = "危险操作"; // i18n-identifier
