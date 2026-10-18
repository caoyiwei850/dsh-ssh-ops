import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXEC_CWD_MARKER, buildCwdAwareCommand, extractExecCwd, posixLoginShell } from '../src/exec-cwd.js';

// The whole feature inspects Linux /proc (fd/cwd symlinks, comm, environ) and
// drives POSIX shells — there is nothing to exercise on Windows, and the
// fixture's /dev/pts symlinks cannot exist there.
if (process.platform === 'win32') {
  console.log('exec-cwd: skipped on Windows (POSIX /proc + /bin/sh are the subject under test)');
  process.exit(0);
}
const root = mkdtempSync(join(tmpdir(), 'dsh-cwd-test-'));
const procRoot = join(root, 'proc'); mkdirSync(procRoot);
const cwd = join(root, "working dir 'quoted' "); mkdirSync(cwd);
function shell(pid, { directory = cwd, foreground = true, args = ['-bash'] } = {}) {
  const dir = join(procRoot, String(pid)); mkdirSync(join(dir, 'fd'), {recursive:true});
  symlinkSync('/dev/pts/1', join(dir, 'fd/0'));
  symlinkSync(directory, join(dir, 'cwd'));
  writeFileSync(join(dir, 'comm'), 'bash\n');
  writeFileSync(join(dir, 'environ'), 'SSH_CONNECTION=test-transport\0');
  writeFileSync(join(dir, 'cmdline'), args.join('\0') + '\0');
  writeFileSync(join(dir, 'stat'), `${pid} (bash) S 1 ${pid} 100 34816 ${foreground ? pid : 101} 0\n`);
}
function run(command = 'pwd -P', shellPath = '/bin/sh') {
  return spawnSync(shellPath, ['-c', buildCwdAwareCommand(command, {procRoot})], {cwd:root,env:{...process.env,SSH_CONNECTION:'test-transport'},encoding:'utf8'});
}
const drop = (pid) => rmSync(join(procRoot, String(pid)), {recursive:true, force:true});
try {
  assert.equal(posixLoginShell('bash'),true); assert.equal(posixLoginShell('fish'),false);

  // No candidate at all: never blocks, cwd simply unknown.
  let result = run('echo fallback');
  assert.equal(result.status,0); assert.equal(extractExecCwd(result.stdout).cwd,null);

  // A normal login shell: follow its cwd, preserving awkward characters.
  shell(101);
  shell(202,{foreground:false,directory:root,args:['bash','-c','sleep 60']});
  result = run();
  assert.equal(result.status,0,result.stderr);
  let parsed=extractExecCwd(result.stdout);
  assert.ok(parsed.cwd.endsWith("working dir 'quoted' "), 'preserve whitespace and quotes');
  assert.equal(parsed.stdout,parsed.cwd+'\n','actual directory matches metadata');

  // Vendor login-shell launchers. UGREEN NAS runs `exec "$SHELL" -` from
  // sshd ForceCommand, so argv is `bash -`; stock shells may use `--` or `-s`.
  // All of these are interactive prompts and must resolve normally.
  for (const args of [['bash','-'],['bash','--'],['bash','-s'],['bash','-i','-l']]) {
    drop(101);
    shell(101,{args});
    result=run();
    assert.equal(result.status,0,`${args.join(' ')} must resolve as an interactive shell: ${result.stderr}`);
    parsed=extractExecCwd(result.stdout);
    assert.ok(parsed.cwd.endsWith("working dir 'quoted' "), `cwd follows ${args.join(' ')}`);
  }

  // Only a background/busy candidate: degrade to the login directory, run anyway.
  drop(101);
  result=run('echo BUSY_DEGRADED');
  assert.equal(result.status,0,'a busy terminal no longer blocks the command');
  assert.ok(result.stdout.includes('BUSY_DEGRADED'));
  assert.equal(extractExecCwd(result.stdout).cwd,null);
  assert.match(result.stderr,/busy or non-interactive/,'busy is its own status, not "ambiguous"');
  assert.match(result.stderr,/bash\(202 pgrp=202 tpgid=101\)/,'busy candidate carries comm/pid/pgrp/tpgid detail');
  assert.match(result.stderr,/continuing from the login directory/,'degradation is announced');

  // A selected shell whose cwd cannot be read still fails closed.
  shell(101,{directory:join(root,'deleted')});
  result=run('echo MUST_NOT_RUN');
  assert.equal(result.status,125,'inaccessible directory fails closed');
  assert.equal(extractExecCwd(result.stdout).cwd,null);
  assert.ok(!result.stdout.includes('MUST_NOT_RUN'));

  // Multiple foreground shells: degrade instead of refusing to work at all.
  drop(101);
  shell(101); shell(303);
  result=run('echo MULTI_DEGRADED');
  assert.equal(result.status,0,'an ambiguous match degrades instead of blocking');
  assert.ok(result.stdout.includes('MULTI_DEGRADED'));
  assert.equal(extractExecCwd(result.stdout).cwd,null);
  assert.match(result.stderr,/multiple interactive shells/,'ambiguity is its own status, not "busy"');
  assert.match(result.stderr,/continuing from the login directory/);

  // A foreground `bash -c` is not an interactive prompt: still degrade, not block.
  drop(101); drop(303);
  shell(101,{args:['bash','-c','echo script']});
  result=run('echo SCRIPT_DEGRADED');
  assert.equal(result.status,0,'foreground bash -c degrades instead of blocking');
  assert.ok(result.stdout.includes('SCRIPT_DEGRADED'));
  assert.equal(extractExecCwd(result.stdout).cwd,null);
  assert.match(result.stderr,/bash\(101 non-interactive\)/,'argv-rejected candidate is reported as non-interactive');

  assert.deepEqual(extractExecCwd('plain output'),{cwd:null,stdout:'plain output'});
  assert.equal(extractExecCwd(EXEC_CWD_MARKER+'\n').cwd,null);
  // zsh keeps SH_WORD_SPLIT off, so `set -- $__dsh_stat` yields a single word
  // there and pgrp/tty/tpgid all read back empty — an idle shell then looks
  // busy, and every ssh_exec against a zsh login fails with exit 125. The
  // login shell runs this resolver, so it must split identically under zsh.
  const hasZsh = spawnSync('zsh', ['-c', 'exit 0'], {encoding:'utf8'}).status === 0;
  if (hasZsh) {
    shell(707);
    const viaZsh = run('pwd -P', 'zsh');
    assert.equal(viaZsh.status, 0, viaZsh.stderr);
    assert.ok(extractExecCwd(viaZsh.stdout).cwd.endsWith("working dir 'quoted' "), 'zsh must resolve the same interactive shell');
    drop(707);
  } else {
    console.log('exec cwd: zsh not installed, skipping the sh-word-split regression');
  }
} finally { rmSync(root,{recursive:true,force:true}); }
console.log('exec cwd: foreground, custom login argv, degraded busy/ambiguous/non-interactive, failed cd, zsh word-split, real pwd metadata: passed');
