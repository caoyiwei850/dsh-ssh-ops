/**
 * Single source for the host-side policy strings that reach the terminal and
 * the agent tool results. The wording is looked up at call time, so these
 * follow the language selected in Settings → SSH Resources together with the
 * rest of the plugin.
 */
import { t } from "./i18n/core.js";

export function policyBlockedReason(category) {
  return t(`Blocked by the safety policy: ${category}. Do not retry or work around it; the operator must confirm execution in the terminal on the right.`);
}

/** Enter blocked because the local line mirror is untrustworthy. */
export function unverifiedLineReason() {
  return t("Blocked by the safety policy: the command or its completion could not be verified. Type a read-only diagnostic command manually.");
}

/** Prefix of the notice appended to the terminal buffer on a policy block. */
export function policyNoticePrefix() {
  return t("[DSH SSH safety policy]");
}

/** Default reason for the blocked-command confirmation card. */
export function dangerousDefaultReason() {
  return t("Dangerous operation");
}
