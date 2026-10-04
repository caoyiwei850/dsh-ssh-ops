// Operator-owned command snippets. Never place passwords, tokens, or other
// secrets here: this is ordinary browser local storage, not the credential vault.
import { t } from "../i18n/core.js";

const KEY = "dsh-ssh-ops.command-snippets.v1";

export const STARTER_COMMAND_SNIPPETS = [
  ["System load", "uptime"], ["Disk usage", "df -h"], ["Memory usage", "free -h"],
  ["Listening ports", "ss -tlnp"], ["List Docker containers", "docker ps"],
  ["Nginx status", "systemctl status nginx --no-pager"], ["Nginx logs", "journalctl -u nginx -n 100 --no-pager"],
  ["Ubuntu: refresh package index (changes state)", "sudo apt-get update"],
  ["Ubuntu: upgrade installed packages (changes state)", "sudo apt-get upgrade"],
  ["Ubuntu: install Nginx (changes state)", "sudo apt-get install -y nginx"],
  ["RHEL: refresh DNF cache (changes state)", "sudo dnf makecache"],
  ["RHEL: upgrade installed packages (changes state)", "sudo dnf upgrade"],
  ["RHEL: install Nginx (changes state)", "sudo dnf install -y nginx"],
  ["Legacy CentOS: update software (changes state)", "sudo yum update"],
  ["Legacy CentOS: install Nginx (changes state)", "sudo yum install -y nginx"],
  ["Service: status", "systemctl status <service> --no-pager"],
  ["Service: recent logs", "journalctl -u <service> -n 100 --no-pager"],
  ["Service: restart (changes state)", "sudo systemctl restart <service>"],
  ["Docker: list all containers", "docker ps -a"],
  ["Docker Compose: service status", "docker compose ps"],
  ["Docker Compose: recent logs", "docker compose logs --tail=100 <service>"],
  ["Docker: prune unused images (changes state)", "docker image prune"],
  ["Logs: last 100 lines", "tail -n 100 <log-path>"],
  ["Logs: follow", "tail -f <log-path>"],
  ["Logs: filter errors", "grep -n 'error' <log-path> | tail -n 50"],
  ["Processes: top by memory", "ps aux --sort=-%mem | head"],
  ["Network: health check", "curl -fsS http://127.0.0.1:<port>/health"],
  ["Network: interface addresses", "ip addr"],
  ["Network: routing table", "ip route"],
  ["Network: DNS lookup", "dig <domain>"],
  ["Network: connectivity test", "ping -c 4 <host>"],
  ["Disk: total size of a directory", "du -sh <directory>"],
  ["Disk: first-level directory sizes", "du -xh <directory> --max-depth=1 | sort -h"],
  ["Files: find files older than 30 days", "find <directory> -type f -mtime +30"],
  ["Files: long listing of a directory", "ls -lah <directory>"],
  ["System: kernel info", "uname -a"],
  ["System: distribution info", "cat /etc/os-release"],
  ["Security: recent logins", "last -n 20"],
  ["Scheduled tasks: current user", "crontab -l"],
  ["Scheduled tasks: systemd timers", "systemctl list-timers --all"]
];

/**
 * Built-ins are available immediately and never need writing to localStorage.
 * Names are translated on every call rather than at module load, so switching
 * the language re-labels the whole command library.
 */
export function defaultCommandSnippets() {
  return STARTER_COMMAND_SNIPPETS.map(([name, command], index) => ({
    id: `builtin-${index}`,
    name: t(name),
    command,
    scope: "global",
    scopeId: null,
    builtIn: true
  }));
}

export function loadCommandSnippets() {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((item) => item && typeof item.id === "string" && typeof item.name === "string" && typeof item.command === "string") : [];
  } catch { return []; }
}

export function saveCommandSnippets(items) {
  localStorage.setItem(KEY, JSON.stringify(items));
  window.dispatchEvent(new Event("dsh-ssh-ops-command-snippets"));
}

export function matchingCommandSnippets(items, connection, profiles) {
  if (!connection) return items.filter((item) => item.scope === "global");
  const profile = profiles.find((item) => item.host === connection.host && item.port === connection.port && item.username === connection.username);
  return items.filter((item) => item.scope === "global" || (item.scope === "profile" && item.scopeId === profile?.profileId) || (item.scope === "group" && item.scopeId === profile?.groupId));
}

export function searchCommandSnippets(items, query) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return items;
  return items.filter((item) => `${item.name}\n${item.command}`.toLocaleLowerCase().includes(needle));
}

/**
 * Merge persisted custom commands with built-ins, without showing duplicates.
 * Dedup keys use the untranslated starter names, because `item.name` follows
 * the active language and would otherwise stop matching after a switch.
 */
export function availableCommandSnippets(customItems) {
  const builtIns = defaultCommandSnippets();
  const keys = new Set(STARTER_COMMAND_SNIPPETS.map(([name, command]) => `${name}\u0000${command}`));
  const translatedCommands = new Set(STARTER_COMMAND_SNIPPETS.map(([, command]) => command));
  return [
    ...builtIns,
    ...customItems.filter((item) => !keys.has(`${item.name}\u0000${item.command}`)
      && !translatedCommands.has(item.command))
  ];
}
