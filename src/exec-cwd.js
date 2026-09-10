/** Resolve a unique foreground POSIX shell on this SSH transport, never by PID age. */
export const EXEC_CWD_MARKER = '__DSH_SSH_OPS_CWD_V2__';
export const EXEC_CWD_ERROR_PREFIX = 'ssh_exec:';
const POSIX_SHELLS = new Set(['bash', 'zsh', 'sh', 'dash', 'ash', 'ksh', 'mksh']);
export function posixLoginShell(name) {
  return typeof name === 'string' && POSIX_SHELLS.has(name.toLowerCase());
}
function quote(text) { return `'${text.replace(/'/g, `'\\''`)}'`; }

/** procRoot is injectable for filesystem fixtures; production always uses /proc. */
export function buildCwdResolverPrefix({ procRoot = '/proc' } = {}) {
  return `
__dsh_find_shell() {
  __dsh_count=0; __dsh_seen=0; __dsh_pid=''
  [ -n "$SSH_CONNECTION" ] || return 1
  for __dsh_p in ${quote(procRoot)}/[0-9]*; do
    __dsh_n=\${__dsh_p##*/}
    case $__dsh_n in ''|*[!0-9]*) continue ;; esac
    __dsh_t=$(readlink "$__dsh_p/fd/0" 2>/dev/null) || continue
    case $__dsh_t in /dev/pts/*|/dev/tty[0-9]*|/dev/ttys[0-9]*) ;; *) continue ;; esac
    __dsh_c=$(cat "$__dsh_p/comm" 2>/dev/null) || continue
    case $__dsh_c in bash|zsh|sh|dash|ash|ksh|mksh) ;; *) continue ;; esac
    tr '\\0' '\\n' < "$__dsh_p/environ" 2>/dev/null | grep -Fxq "SSH_CONNECTION=$SSH_CONNECTION" || continue
    __dsh_seen=$((__dsh_seen + 1))
    __dsh_stat=$(cat "$__dsh_p/stat" 2>/dev/null) || continue
    __dsh_stat=\${__dsh_stat##*) }
    set -- $__dsh_stat
    [ "$#" -ge 6 ] && [ "$3" = "$6" ] && [ "$5" != 0 ] || continue
    # Foreground is necessary but not sufficient: bash -c/script jobs are
    # noninteractive, even when they inherit the terminal and SSH environment.
    __dsh_args=$(tr '\\0' '\\n' < "$__dsh_p/cmdline" 2>/dev/null | sed '1d')
    __dsh_valid=yes
    while IFS= read -r __dsh_arg; do
      case $__dsh_arg in ''|-i|-l|-il|-li|--login|--noprofile|--norc) ;; *) __dsh_valid=no ;; esac
    done <<EOF
$__dsh_args
EOF
    [ "$__dsh_valid" = yes ] || continue
    __dsh_count=$((__dsh_count + 1)); __dsh_pid=$__dsh_n
  done
  if [ "$__dsh_count" -eq 1 ]; then printf '%s' "$__dsh_pid"; return 0; fi
  [ "$__dsh_seen" -eq 0 ] && return 1
  return 2
}
__dsh_pid=$(__dsh_find_shell); __dsh_status=$?
__dsh_encoded=''
if [ "$__dsh_status" -eq 0 ]; then
  if ! cd -- ${quote(procRoot)}/"$__dsh_pid"/cwd 2>/dev/null || ! pwd -P >/dev/null 2>&1; then
    printf '${EXEC_CWD_MARKER}\\n'
    printf '%s\\n' '${EXEC_CWD_ERROR_PREFIX} interactive directory is unavailable; command was not executed' >&2
    exit 125
  fi
  __dsh_encoded=$(pwd -P | base64 | tr -d '\\r\\n')
elif [ "$__dsh_status" -eq 2 ]; then
  printf '${EXEC_CWD_MARKER}\\n'
  printf '%s\\n' '${EXEC_CWD_ERROR_PREFIX} interactive shell is busy or ambiguous; command was not executed' >&2
  exit 125
fi
printf '${EXEC_CWD_MARKER}%s\\n' "$__dsh_encoded"
`.trim();
}
export function buildCwdAwareCommand(command, options) {
  return `${buildCwdResolverPrefix(options)}\n${command}`;
}

/** Decode the actual post-cd pwd, including spaces and newline-containing names. */
export function extractExecCwd(stdout) {
  const text = String(stdout ?? '');
  if (!text.startsWith(EXEC_CWD_MARKER)) return { cwd: null, stdout: text };
  const newline = text.indexOf('\n');
  if (newline === -1) return { cwd: null, stdout: '' };
  const encoded = text.slice(EXEC_CWD_MARKER.length, newline);
  const decoded = /^[A-Za-z0-9+/]*={0,2}$/.test(encoded) ? Buffer.from(encoded, 'base64').toString('utf8') : '';
  const cwd = decoded.endsWith('\n') ? decoded.slice(0, -1) : '';
  return { cwd: cwd.startsWith('/') && !cwd.includes('\0') ? cwd : null, stdout: text.slice(newline + 1) };
}
export function execEchoWarning(cwd) {
  if (cwd !== null) return null;
  return '\x1b[90m[ssh_exec · 未确认交互目录；请以退出码和错误信息确认是否执行，未探测到终端时使用登录初始目录]\x1b[0m';
}
