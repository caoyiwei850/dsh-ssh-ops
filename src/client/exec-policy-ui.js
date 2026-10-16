/**
 * Shared execution-policy presentation. Both operator surfaces — the terminal
 * panel's tier pill and the settings page's segment control — must agree on
 * which switches count as loosening, what each tier is called, and what a
 * loosening actually releases: an operator asked a different question in each
 * place cannot tell what they are approving.
 */
import { t } from "../i18n/core.js";

export const EXEC_POLICY_TIERS = ["standard", "custom", "allowAll"];

/** Loosening is "a larger number"; every tier switch compares against this. */
export const TIER_ORDER = { standard: 0, custom: 1, allowAll: 2 };

/** Human name for a tier, for buttons, menus and confirmation titles. */
export function execPolicyLabel(mode) {
  if (mode === "custom") return t("自定义放行");
  if (mode === "allowAll") return t("全部放行");
  return t("标准");
}

/** What switching to `tier` releases, in the operator's words. */
export function execPolicyLooseningDetail(tier, allowCount) {
  if (tier === "allowAll") {
    return t("将允许 AI 直接执行任何命令——包括不可逆删除、格式化磁盘、重启关机；删除不再进回收站。仅建议用于测试或可丢弃的环境。");
  }
  return t(`将允许 AI 直接执行自定义放行清单中的 ${allowCount} 类命令（可在设置中调整清单），其余类别照常拦截。`);
}
