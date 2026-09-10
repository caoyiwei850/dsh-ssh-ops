import assert from 'node:assert/strict';
import { createTerminalPool } from '../src/client/terminal-pool.js';
const pool = createTerminalPool({ create: () => ({term: {dispose() {}}, fit: {}}), max: 2 });
const owners = Array.from({length: 10}, () => ({}));
owners.forEach((owner, i) => pool.acquire(String(i), owner));
owners.forEach((owner, i) => pool.release(String(i), owner));
assert.equal(pool.size(), 2, 'released overflow must be evicted');

import SshOpsService from '../src/index.js';
import { createTerminalOutput } from '../src/terminal-output.js';
import { EXEC_CWD_MARKER } from '../src/exec-cwd.js';
import { readResultSchema, terminalStreamRequestSchema, changeDirectoryRequestSchema } from '../src/schemas.js';
const svc = Object.create(SshOpsService.prototype);
svc.config = {streamHeartbeatMs:10,maxBufferBytes:1024,maxCaptureBytes:1024};
svc.sessions=new Map();svc.connections=new Map();svc.pendingConfirmations=new Map();
const session={id:'s',connectionId:'c',buffer:'',captureBuffer:'',waiters:[],streamListeners:new Set(),exited:null,inputKnown:true,inputLine:''};
const writes=[];session.stream={write(text){writes.push(text);}};
const conn={sessions:new Set(['s']),client:{},loginShell:'bash'};
svc.sessions.set('s',session);svc.connections.set('c',conn);
const a=new AbortController(),b=new AbortController();
const ga=svc.terminalStream({sessionId:'s'},a.signal),gb=svc.terminalStream({sessionId:'s'},b.signal);
await ga.next();await gb.next();svc.appendSessionOutput(session,'one-event\r\n');
a.abort();b.abort();await ga.next();await gb.next();
assert.equal(svc.terminalOutput(session).read().data,'one-event\r\n','concurrent abort never duplicates');
const gc=svc.terminalStream({sessionId:'s'});const first=await gc.next();
readResultSchema.parse(first.value);
const offset=first.value.value.offset;
await gc.return();svc.appendSessionOutput(session,'one-event\r\n');
const gd=svc.terminalStream({sessionId:'s',after:offset});const second=await gd.next();
assert.equal(Buffer.from(second.value.value.data,'base64').toString(),'one-event\r\n','new identical event resumes exactly once');
await gd.return();
// Two new consumers have independent histories, not destructive buffer ownership.
const ge=svc.terminalStream({sessionId:'s'}),gf=svc.terminalStream({sessionId:'s'});
assert.deepEqual((await ge.next()).value,(await gf.next()).value);
await ge.return();await gf.return();
const bounded=createTerminalOutput('',5);bounded.append('😀😀A');
assert.deepEqual(bounded.read(0),{data:'😀A',startOffset:2,offset:5});
assert.equal(terminalStreamRequestSchema.parse({sessionId:'s',after:11}).after,11);
assert.equal(changeDirectoryRequestSchema.safeParse({sessionId:'s',path:'/tmp\nfoo'}).success,false);

// Cursor polling uses the same journal as streaming and wakes every reader.
const pollA=svc.read({sessionId:'s',timeoutMs:100,after:svc.terminalOutput(session).read().offset});
const pollB=svc.read({sessionId:'s',timeoutMs:100,after:svc.terminalOutput(session).read().offset});
svc.appendSessionOutput(session,'poll-once\r\n');
const [pollResultA,pollResultB]=await Promise.all([pollA,pollB]);
assert.equal(Buffer.from(pollResultA.value.data,'base64').toString(),'poll-once\r\n');
assert.deepEqual(pollResultA,pollResultB,'cursor poll readers do not compete');

// A cd action must not submit drafts, unknown line state, or a busy shell.
const metadata=EXEC_CWD_MARKER+Buffer.from('/tmp\n').toString('base64')+'\n';
svc.collectExecOutput=async()=>({exitCode:0,stdout:metadata});
session.inputLine='echo ';
assert.equal((await svc.changeDirectory({sessionId:'s',path:'/tmp'})).ok,false);
assert.equal(writes.length,0);
session.inputLine='';session.inputKnown=false;
assert.equal((await svc.changeDirectory({sessionId:'s',path:'/tmp'})).ok,false);
session.inputKnown=true;
svc.collectExecOutput=async()=>({exitCode:125,stdout:EXEC_CWD_MARKER+'\n'});
assert.equal((await svc.changeDirectory({sessionId:'s',path:'/tmp'})).ok,false);
assert.equal(writes.length,0);
svc.collectExecOutput=async()=>{
  svc.updateInputMirror(session,'echo x\r');
  return {exitCode:0,stdout:metadata};
};
assert.equal((await svc.changeDirectory({sessionId:'s',path:'/tmp'})).ok,false,'input changed while probe awaited');
assert.equal(writes.length,0);
svc.collectExecOutput=async()=>({exitCode:0,stdout:metadata});
assert.equal((await svc.changeDirectory({sessionId:'s',path:"/tmp/a'b"})).ok,true);
assert.equal(writes.join(''),"cd -- '/tmp/a'\\''b'\r");

// The normal ssh_exec path turns a resolver refusal into a real tool error.
const execService=Object.create(SshOpsService.prototype);
execService.config={maxBufferBytes:1024,maxCaptureBytes:1024};
execService.connections=new Map([['c',{client:{},sessions:new Set(),loginShell:'bash'}]]);
execService.sessions=new Map();
execService.ensureAlive=async()=>true;
execService.collectExecOutput=async()=>({
  exitCode:125,
  stdout:EXEC_CWD_MARKER+'\n',
  stderr:'ssh_exec: interactive shell is busy or ambiguous; command was not executed\n',
  truncated:false,
  timedOut:false
});
const refused=await execService.execOnConnection('c','touch relative-file');
assert.equal(refused.ok,false);
assert.equal(refused.error.code,'cwd-unavailable');
console.log('review regressions: pool cap, cursor delivery, concurrent abort, safe cd: passed');
