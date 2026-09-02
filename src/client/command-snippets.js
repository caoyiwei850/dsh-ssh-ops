// Operator-owned command snippets. Never place passwords, tokens, or other
// secrets here: this is ordinary browser local storage, not the credential vault.
const KEY = "dsh-ssh-ops.command-snippets.v1";

export const STARTER_COMMAND_SNIPPETS = [
  ["查看系统负载", "uptime"], ["查看磁盘空间", "df -h"], ["查看内存", "free -h"],
  ["查看监听端口", "ss -tlnp"], ["查看 Docker 容器", "docker ps"],
  ["查看 Nginx 状态", "systemctl status nginx --no-pager"], ["查看 Nginx 日志", "journalctl -u nginx -n 100 --no-pager"],
  ["Ubuntu：刷新软件索引（会变更）", "sudo apt-get update"],
  ["Ubuntu：升级已装软件（会变更）", "sudo apt-get upgrade"],
  ["Ubuntu：安装 Nginx（会变更）", "sudo apt-get install -y nginx"],
  ["RHEL：刷新 DNF 缓存（会变更）", "sudo dnf makecache"],
  ["RHEL：升级已装软件（会变更）", "sudo dnf upgrade"],
  ["RHEL：安装 Nginx（会变更）", "sudo dnf install -y nginx"],
  ["旧版 CentOS：更新软件（会变更）", "sudo yum update"],
  ["旧版 CentOS：安装 Nginx（会变更）", "sudo yum install -y nginx"],
  ["服务：查看状态", "systemctl status <服务> --no-pager"],
  ["服务：查看最近日志", "journalctl -u <服务> -n 100 --no-pager"],
  ["服务：重启（会变更）", "sudo systemctl restart <服务>"],
  ["Docker：查看全部容器", "docker ps -a"],
  ["Docker Compose：服务状态", "docker compose ps"],
  ["Docker Compose：最近日志", "docker compose logs --tail=100 <服务>"],
  ["Docker：清理未使用镜像（会变更）", "docker image prune"],
  ["日志：查看末尾 100 行", "tail -n 100 <日志路径>"],
  ["日志：持续跟踪", "tail -f <日志路径>"],
  ["日志：筛选错误", "grep -n 'error' <日志路径> | tail -n 50"],
  ["进程：内存占用前列", "ps aux --sort=-%mem | head"],
  ["网络：健康检查", "curl -fsS http://127.0.0.1:<端口>/health"],
  ["网络：网卡地址", "ip addr"],
  ["网络：路由表", "ip route"],
  ["网络：DNS 查询", "dig <域名>"],
  ["网络：连通性测试", "ping -c 4 <主机>"],
  ["磁盘：目录总大小", "du -sh <目录>"],
  ["磁盘：一级目录大小", "du -xh <目录> --max-depth=1 | sort -h"],
  ["文件：查找 30 天前文件", "find <目录> -type f -mtime +30"],
  ["文件：详细列出目录", "ls -lah <目录>"],
  ["系统：内核信息", "uname -a"],
  ["系统：发行版信息", "cat /etc/os-release"],
  ["安全：最近登录", "last -n 20"],
  ["计划任务：当前用户", "crontab -l"],
  ["计划任务：systemd 定时器", "systemctl list-timers --all"]
];

/** Built-ins are available immediately and never need writing to localStorage. */
export function defaultCommandSnippets() {
  return STARTER_COMMAND_SNIPPETS.map(([name, command], index) => ({
    id: `builtin-${index}`,
    name,
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

/** Merge persisted custom commands with built-ins, without showing duplicates. */
export function availableCommandSnippets(customItems) {
  const builtIns = defaultCommandSnippets();
  const keys = new Set(builtIns.map((item) => `${item.name}\u0000${item.command}`));
  return [...builtIns, ...customItems.filter((item) => !keys.has(`${item.name}\u0000${item.command}`))];
}
