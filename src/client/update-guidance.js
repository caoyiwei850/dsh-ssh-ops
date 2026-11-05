/** Interpret the host's bundle inventory without acting on the installation. */
export function installationKind(bundle) {
  if (!bundle || typeof bundle.source !== "string") return "unknown";
  const source = bundle.source.trim();
  if (/^(?:link:|file:|\/|[a-z]:[\\/])/i.test(source)) return "local";
  if (/^(?:git\+|git:|github:|https?:|ssh:|git@)/i.test(source)) return "git";
  if (/^(?:dsh-ssh-ops)(?:@[^\s]+)?$/i.test(source) || /^[~^*\d]/.test(source)) return "registry";
  return "unknown";
}

export async function inspectInstallation(manager) {
  if (typeof manager?.listBundles !== "function") return "unknown";
  try {
    const bundles = await manager.listBundles();
    return installationKind(Array.isArray(bundles) ? bundles.find((item) => item.name === "dsh-ssh-ops" && item.installed) : undefined);
  } catch {
    return "unknown";
  }
}
