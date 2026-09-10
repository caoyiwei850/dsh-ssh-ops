import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXEC_CWD_MARKER, buildCwdAwareCommand, extractExecCwd, posixLoginShell } from '../src/exec-cwd.js';
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
function run(command = 'pwd -P') {
  return spawnSync('/bin/sh', ['-c', buildCwdAwareCommand(command, {procRoot})], {cwd:root,env:{...process.env,SSH_CONNECTION:'test-transport'},encoding:'utf8'});
}
try {
  assert.equal(posixLoginShell('bash'),true); assert.equal(posixLoginShell('fish'),false);
  let result = run('echo fallback');
  assert.equal(result.status,0); assert.equal(extractExecCwd(result.stdout).cwd,null);
  shell(101);
  shell(202,{foreground:false,directory:root,args:['bash','-c','sleep 60']});
  result = run();
  assert.equal(result.status,0,result.stderr);
  const parsed=extractExecCwd(result.stdout);
  assert.ok(parsed.cwd.endsWith("working dir 'quoted' "), 'preserve whitespace and quotes');
  assert.equal(parsed.stdout,parsed.cwd+'\n','actual directory matches metadata');
  rmSync(join(procRoot,'101'),{recursive:true});
  result=run('echo MUST_NOT_RUN');
  assert.equal(result.status,125,'background shell cannot become the selected directory');
  assert.ok(!result.stdout.includes('MUST_NOT_RUN'));
  shell(101,{directory:join(root,'deleted')});
  result=run('echo MUST_NOT_RUN');
  assert.equal(result.status,125,'inaccessible directory fails closed');
  assert.equal(extractExecCwd(result.stdout).cwd,null);
  assert.ok(!result.stdout.includes('MUST_NOT_RUN'));
  rmSync(join(procRoot,'101'),{recursive:true});
  shell(101); shell(303);
  result=run('echo MUST_NOT_RUN'); assert.equal(result.status,125,'multiple foreground shells are ambiguous');
  rmSync(join(procRoot,'101'),{recursive:true}); rmSync(join(procRoot,'303'),{recursive:true});
  shell(101,{args:['bash','-c','echo script']});
  result=run('echo MUST_NOT_RUN'); assert.equal(result.status,125,'foreground bash -c is not an interactive prompt');
  assert.deepEqual(extractExecCwd('plain output'),{cwd:null,stdout:'plain output'});
  assert.equal(extractExecCwd(EXEC_CWD_MARKER+'\n').cwd,null);
} finally { rmSync(root,{recursive:true,force:true}); }
console.log('exec cwd: foreground, background, ambiguous, failed cd, real pwd metadata: passed');
