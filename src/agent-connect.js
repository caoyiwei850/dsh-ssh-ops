/**
 * Agent auto-connect (issue #25): the operator's switch that lets the agent
 * connect a *saved* SSH resource by name instead of stumbling over
 * `connection "dev" does not exist`. Risk lives in connecting (waking a
 * machine), not in switching, so the whole verb sits behind one explicit
 * operator switch and every connect lands visibly in the right-side panel.
 *
 * Pure helpers here; the service methods live in index.js.
 */

/** "dev, data, prod" for one-line resource lists; "(none)" when empty. */
export function formatSavedResources(names) {
  return names.length > 0 ? names.join(", ") : "(none)";
}

/**
 * Resolve a resource reference (saved-server name or profile id) against the
 * saved profiles. Exact id first, then exact name (case-insensitive), then a
 * UNIQUE case-insensitive substring match — a bare "dev" must not silently
 * pick "dev-1" of "dev-2", it fails with the candidates instead.
 * Returns { ok, profileId, name } or { ok: false, code, message }.
 */
export function resolveProfileRef(entries, query) {
  const text = String(query ?? "").trim();
  const names = entries.map((entry) => entry.name).sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));
  if (text === "") {
    return { ok: false, code: "no-profile", message: `no saved SSH resource was given. Available resources: ${formatSavedResources(names)}.` };
  }
  const byId = entries.find((entry) => entry.profileId === text);
  if (byId !== undefined) return { ok: true, profileId: byId.profileId, name: byId.name };
  const lowered = text.toLowerCase();
  const byName = entries.filter((entry) => entry.name.toLowerCase() === lowered);
  if (byName.length === 1) return { ok: true, profileId: byName[0].profileId, name: byName[0].name };
  if (byName.length > 1) {
    return { ok: false, code: "profile-ambiguous", message: `resource name "${text}" matches multiple saved SSH resources (${formatSavedResources(byName.map((entry) => entry.name))}); use the full name or the resource id from ssh_list.` };
  }
  const partial = entries.filter((entry) => entry.name.toLowerCase().includes(lowered));
  if (partial.length === 1) return { ok: true, profileId: partial[0].profileId, name: partial[0].name };
  if (partial.length > 1) {
    return { ok: false, code: "profile-ambiguous", message: `resource "${text}" matches multiple saved SSH resources (${formatSavedResources(partial.map((entry) => entry.name))}); use a longer name.` };
  }
  return { ok: false, code: "no-profile", message: `no saved SSH resource named "${text}". Available resources: ${formatSavedResources(names)}.` };
}

/**
 * One structured "which server do you even mean" message for no-connection
 * failures: names the requested id (when given), lists the operator's saved
 * resources, and points the agent at the right next move — ssh_connect_profile
 * only when the operator's switch is on, otherwise asking the operator.
 */
export function noConnectionGuidance(requestedId, resourceNames, autoConnectEnabled) {
  const named = requestedId !== undefined && requestedId !== null && String(requestedId) !== "";
  const listed = !autoConnectEnabled ? "" : resourceNames.length > 0
    ? ` Saved SSH resources: ${formatSavedResources(resourceNames)}.`
    : " The operator has no saved SSH resources yet.";
  if (named) {
    const head = `connection "${requestedId}" does not exist.${listed}`;
    return autoConnectEnabled
      ? `${head} Call ssh_connect_profile with one of those resource names to connect it.`
      : `${head} Ask the operator to connect the server in the SSH panel.`;
  }
  const head = `no active SSH connection.${listed}`;
  return autoConnectEnabled
    ? `${head} Call ssh_connect_profile with one of those resource names to connect it, or ask the operator.`
    : `${head} Ask the operator to connect a server in the SSH panel.`;
}

/** Fixed refusal when the agent reaches for a saved resource while the switch is off. */
export const AUTO_CONNECT_DISABLED_MESSAGE = "AI 自动连接已保存服务器未开启。请操作者在 设置 → SSH 资源 → 「允许 AI 自动连接已保存服务器」打开开关，或由操作者在 SSH 面板手动连接目标服务器。";
