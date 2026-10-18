/**
 * Cross-platform guard for the exec-cwd resolver's *rules*.
 *
 * `test/exec-cwd.mjs` drives the real generated shell script against a fake
 * /proc, so it can only run on Linux (it is skipped on win32). That leaves the
 * Windows CI leg with zero coverage of this module, and the two classes of bug
 * we actually hit are both rule-level, not OS-level:
 *
 *   1. argv whitelist too narrow — UGREEN NAS runs `exec "$SHELL" -` from sshd
 *      ForceCommand, so the login shell's argv is `bash -`; stock shells may
 *      also use `--` or `-s`. Any of those was misread as a non-interactive
 *      `bash -c` job.
 *   2. a "cwd unknown" outcome must never block the command — `execEchoWarning`
 *      already documents the login-directory fallback, so `exit 125` for the
 *      busy / ambiguous / non-interactive cases contradicted the module's own
 *      contract.
 *
 * This file reads the *real* whitelist out of src/exec-cwd.js (no second copy
 * to drift), mirrors `__dsh_find_shell` in plain JS, and asserts the script's
 * degradation branches structurally. Everything here runs on any platform.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildCwdResolverPrefix } from '../src/exec-cwd.js';

// Normalize CRLF: Windows checkouts made with core.autocrlf hand us \r\n, and
// the literal structural matches below must not depend on checkout config.
const SOURCE = readFileSync(new URL('../src/exec-cwd.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// ---- the authoritative argv whitelist, taken from the script under test ----
const whitelistMatch = SOURCE.match(/case \$__dsh_arg in ([^)]*)\) ;; \*\) __dsh_valid=no/);
assert.ok(whitelistMatch, 'the argv whitelist must stay discoverable in src/exec-cwd.js');
// `case` patterns are either a quoted shell word (`''`) or a bare option word
// (`-i`, `--login`); both spellings must stay acceptable.
const WHITELIST = whitelistMatch[1].split('|').map((raw) => {
  const token = raw.trim();
  assert.match(token, /^(?:'(?:[^']*)'|-{1,2}[A-Za-z-]*)$/, `unexpected whitelist token: ${raw}`);
  const single = token.match(/^'(.*)'$/);
  return single === null ? token : single[1];
});

// ---- mirror of __dsh_find_shell (same filters, same order, same statuses) ----
const PTY = /^\/dev\/(?:pts\/|tty\d|ttys\d)/;
const POSIX_SHELLS = new Set(['bash', 'zsh', 'sh', 'dash', 'ash', 'ksh', 'mksh']);

function findShell(candidates) {
  let count = 0, seen = 0, busy = 0, nonint = 0, pid = null, detail = '';
  for (const c of candidates) {
    if (!(PTY.test(c.tty) && POSIX_SHELLS.has(c.comm) && c.sshMatches)) continue;
    seen++;
    if (!(c.pgrp === c.tpgid && c.ttyNr !== 0)) {
      busy++;
      if (busy <= 3) detail += ` ${c.comm}(${c.pid} pgrp=${c.pgrp} tpgid=${c.tpgid})`;
      continue;
    }
    if (!c.argv.every((arg) => WHITELIST.includes(arg))) {
      nonint++;
      if (nonint <= 3) detail += ` ${c.comm}(${c.pid} non-interactive)`;
      continue;
    }
    count++; pid = c.pid;
  }
  if (count === 1) return { status: 0, pid, detail: '' };
  if (count > 1) return { status: 2, pid: null, detail: '' };
  if (seen === 0) return { status: 1, pid: null, detail: '' };
  return { status: 3, pid: null, detail };
}

const candidate = (overrides = {}) => ({
  pid: 101, tty: '/dev/pts/1', comm: 'bash', sshMatches: true,
  pgrp: 101, tpgid: 101, ttyNr: 34816, argv: [], ...overrides,
});

// 1. Every vendor login-shell launcher resolves as an interactive prompt.
for (const argv of [[], ['-'], ['-i'], ['-l'], ['-il'], ['-li'], ['--'], ['-s'], ['-i', '-l'], ['-l', '-i'], ['--login'], ['--noprofile'], ['--norc']]) {
  const result = findShell([candidate({ argv })]);
  assert.equal(result.status, 0, `bash ${argv.join(' ')} must resolve to status 0, got ${result.status}`);
  assert.equal(result.pid, 101);
}

// 2. Command-mode shells are still rejected — the whitelist must not swallow them.
for (const argv of [['-c', 'echo script'], ['--command', 'id'], ['/tmp/script.sh'], ['-x']]) {
  const result = findShell([candidate({ argv })]);
  assert.equal(result.status, 3, `bash ${argv.join(' ')} must stay non-interactive, got ${result.status}`);
}

// 3. Filter order and statuses: unknown transport, background job, ambiguity.
assert.equal(findShell([]).status, 1, 'no shell on this transport is status 1');
assert.equal(findShell([candidate({ sshMatches: false })]).status, 1, 'another SSH_CONNECTION is not our shell');
assert.equal(findShell([candidate({ tty: '/dev/null' })]).status, 1, 'a non-pty stdin is not an interactive shell');
assert.equal(findShell([candidate({ comm: 'python3' })]).status, 1, 'only POSIX shells are candidates');
const busy = findShell([candidate({ pgrp: 202, tpgid: 101 })]);
assert.equal(busy.status, 3);
assert.match(busy.detail, /bash\(101 pgrp=202 tpgid=101\)/, 'busy detail stays field-diagnosable');
assert.equal(findShell([candidate(), candidate({ pid: 303, pgrp: 303, tpgid: 303 })]).status, 2, 'two foreground shells are ambiguous');
assert.equal(findShell([candidate({ ttyNr: 0 })]).status, 3, 'a detached tty cannot be the prompt');

// 4. The selected shell is unique and its pid is the one to cd through.
assert.equal(findShell([candidate({ pid: 7 }), candidate({ pid: 9, sshMatches: false })]).pid, 7);

// 5. Structural contract: status 2 and 3 degrade, they never abort the command.
function statusBlock(status) {
  const marker = `elif [ "$__dsh_status" -eq ${status} ]; then`;
  const start = SOURCE.indexOf(marker);
  assert.notEqual(start, -1, `status ${status} branch must exist`);
  const rest = SOURCE.slice(start + marker.length);
  const end = rest.search(/\n(?:elif|else|fi)\b/);
  assert.notEqual(end, -1, `status ${status} branch must be terminated`);
  return rest.slice(0, end);
}
for (const status of [2, 3]) {
  const block = statusBlock(status);
  assert.doesNotMatch(block, /exit 125/, `status ${status} must not abort the command`);
  assert.match(block, /continuing from the login directory/, `status ${status} must announce the fallback`);
  assert.doesNotMatch(block, /EXEC_CWD_MARKER|__DSH_SSH_OPS_CWD_V2__/, `status ${status} must not emit a second marker`);
}
// The marker is printed exactly once for every status, after the branches: an
// empty payload makes extractExecCwd report cwd null, which is what lets the
// command run from the login directory instead of being aborted.
assert.ok(
  SOURCE.includes("fi\nprintf '${EXEC_CWD_MARKER}%s\\\\n' \"$__dsh_encoded\""),
  'the cwd marker must be printed once, after the degrade branches',
);

// 6. The "selected shell but cwd unreadable" case is a real error and stays fail-closed.
const zeroBlock = SOURCE.slice(SOURCE.indexOf('if [ "$__dsh_status" -eq 0 ]; then'), SOURCE.indexOf('elif [ "$__dsh_status" -eq 2 ]; then'));
assert.match(zeroBlock, /exit 125/, 'an unreadable /proc/<pid>/cwd remains fail-closed');

// 7. The warning path the degradation feeds into still exists (cwd === null => fallback text).
assert.match(SOURCE, /function execEchoWarning/, 'the login-directory fallback message must survive');
assert.match(SOURCE, /未探测到终端时使用登录初始目录/, 'the fallback wording must survive');

// 8. If this platform has a POSIX shell, the generated resolver must parse.
//    End-to-end behaviour still needs Linux (`test/exec-cwd.mjs`), but a shell
//    syntax error after editing the heredoc is caught here on every platform.
//    GitHub's windows-latest images ship Git Bash, so the Windows CI leg covers
//    this too; elsewhere the check simply reports itself as unavailable.
function shellCandidates() {
  if (process.platform !== 'win32') return ['bash', '/bin/sh'];
  // Git for Windows ships bash next to the mingw prefix git itself reports, so
  // derive it from `git --exec-path` instead of hard-coding an install root;
  // PATH entries are appended because some installs only expose it there.
  const list = ['C:/Program Files/Git/bin/bash.exe', 'bash'];
  const where = spawnSync('where', ['bash'], { encoding: 'utf8' });
  if (where.status === 0) {
    for (const line of String(where.stdout).split(/\r?\n/)) {
      if (line.trim() !== '') list.push(line.trim());
    }
  }
  const execPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  if (execPath.status === 0) {
    const root = resolve(String(execPath.stdout).trim(), '../../..');
    list.push(join(root, 'bin/bash.exe'), join(root, 'usr/bin/bash.exe'));
  }
  return list;
}

function findPosixShell() {
  for (const candidate of shellCandidates()) {
    const probe = spawnSync(candidate, ['-c', 'echo dsh-ok'], { encoding: 'utf8' });
    if (probe.status === 0 && String(probe.stdout).trim() === 'dsh-ok') return candidate;
  }
  return null;
}

const shell = findPosixShell();
if (shell === null) {
  console.log('exec cwd rules: no POSIX shell found — generated-script syntax check skipped');
} else {
  const script = join(tmpdir(), `dsh-cwd-resolver-${process.pid}.sh`);
  writeFileSync(script, buildCwdResolverPrefix(), 'utf8');
  try {
    const parsed = spawnSync(shell, ['-n', script], { encoding: 'utf8' });
    assert.equal(parsed.status, 0, `generated resolver must parse under ${shell}: ${parsed.stderr}`);
  } finally {
    rmSync(script, { force: true });
  }
}

console.log(`exec cwd rules: ${WHITELIST.length} whitelist tokens, ${SOURCE.length} source bytes, shell=${shell ?? 'none'}: passed`);
