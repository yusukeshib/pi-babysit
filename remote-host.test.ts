import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Isolate the extension's module-level CLI/root state from the real local tests.
test("remote processes route by persisted identity and preserve uncertain work", () => {
 const dir = mkdtempSync(path.join(tmpdir(), "pi-remote-test-"));
 const fake = path.join(dir, "babysit");
 writeFileSync(fake, `#!/usr/bin/env bun
import fs from 'node:fs';
const args = process.argv.slice(2); const file = process.env.FAKE_STATE;
const lock=file+'.lock'; for(;;) {try {fs.mkdirSync(lock);break;} catch {Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}}
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
state.calls.push({args:[...args], cwd:process.cwd(), env:process.env.PI_SESSION_FILE});
const save=()=>{fs.writeFileSync(file+'.tmp',JSON.stringify(state));fs.renameSync(file+'.tmp',file);fs.rmdirSync(lock);};
let host='local'; if(args[0]==='--host') {host=args[1]; args.splice(0,2);}
const command=args[0]; const id=args[args.indexOf('-s')+1];
if(command==='--version') console.log('babysit 0.14.5');
else if(state.offline && host!=='local') {console.error('SSH unavailable'); save(); process.exit(255);}
else if(command==='list') {if(host==='local' && state.localFail) {console.error('local registry unavailable');save();process.exit(1);} console.log(JSON.stringify(host==='local'?[]:Object.values(state.sessions[host]??{})));}
else if(command==='run') {const rid=args[args.indexOf('--id')+1]; if(rid.length>64 || !/^[A-Za-z0-9_.-]+$/.test(rid)) {console.error('session id too long or invalid (max 64)');save();process.exit(1);} (state.sessions[host]??={})[rid]={id:rid,state:'running',alive:true}; if(state.failLaunch) {console.error('lost launch reply'); save(); process.exit(255);} console.log(state.malformed?'not json':JSON.stringify({id:rid}));}
else if(command==='wait') {if(state.hangWait) {save(); const {spawn}=await import('node:child_process'); const transport=spawn('sleep',['30'],{stdio:'inherit'}); fs.writeFileSync(file+'.grandchild',String(transport.pid)); setInterval(()=>{},1000); await new Promise(()=>{});} if(state.finish) Object.assign(state.sessions[host][id],{state:'exited',exit_code:0}); else {save();process.exit(124);}}
else if(command==='kill') {if(!state.unconfirmed) Object.assign(state.sessions[host][id],{state:'killed',alive:false}); console.log(JSON.stringify({killed:true,confirmed:!state.unconfirmed}));}
else if(command==='log') {if(state.logFail) {console.error('log unavailable');save();process.exit(1);} if(args.includes('--json')) {if(args.includes('--timestamps')&&state.noTimestamps) {console.error("error: unexpected argument '--timestamps' found");save();process.exit(2);} const text=state.logText??'remote output'; const since=Number(args[args.indexOf('--since')+1]); const out={text:text.slice(since),offset:text.length,done:state.sessions[host][id].state!=='running'}; if(args.includes('--timestamps')) {let at=0; out.timestamps=text.split(/(?<=\\n)/).flatMap((line,i)=>{const s=at; at+=line.length; const b=Math.max(s,since), e=Math.min(at,text.length); return line&&e>b?[[b,e-b,1000+i]]:[];});} console.log(JSON.stringify(out));} else console.log(args.includes('--grep')?'matching output':(state.logText??'remote output'));}
else if(command==='screenshot') console.log('remote screen');
else if(command==='expect') console.log('matched');
else if(command==='send'||command==='key') console.log('{}');
else {console.error('unexpected '+args.join(' ')); save();process.exit(1);}
save();
`, { mode: 0o755 });
 const state = path.join(dir, "state.json");
 writeFileSync(state, JSON.stringify({ sessions: { alpha: { manual: { id: "manual", state: "running" } } }, calls: [] }));
 const script = path.join(dir, "scenario.ts");
 writeFileSync(script, `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import extension, {gcBabysitRoots,remoteLogMirrorPath,remoteProcessCommand,remoteProcessId,syncRemoteLog,validateProcessHost,widgetTail} from ${JSON.stringify(path.join(import.meta.dir, "index.ts"))};
const tools=new Map(); const hooks=new Map(); const messages=[];
extension({registerTool:t=>tools.set(t.name,t),on:(n,h)=>hooks.set(n,h),registerCommand(){},registerMessageRenderer(){},getActiveTools:()=>[],getThinkingLevel:()=> 'low',sendMessage:m=>messages.push(m)});
const ctx={hasUI:true,ui:{setWidget(){},theme:{fg:(_,s)=>s,bg:(_,s)=>s,bold:s=>s}},cwd:'/local/does-not-exist',isIdle:()=>true, sessionManager:{getSessionId:()=> 'fake',getSessionFile:()=> '/local/pi-session.jsonl'},model:{provider:'test',id:'test'}};
const call=async(name,args,signal)=>{try {return await tools.get('babysit_'+name).execute('call',args,signal,undefined,ctx);} catch(e){return {isError:true,content:[{text:e.message}],details:{}};}};
const read=()=>JSON.parse(fs.readFileSync(process.env.FAKE_STATE,'utf8'));
const set=(values)=>fs.writeFileSync(process.env.FAKE_STATE,JSON.stringify({...read(),...values}));
const meta=id=>JSON.parse(fs.readFileSync(process.env.PI_BABYSIT_DIR+'/meta/'+id+'.json','utf8'));
let a=await call('run',{host:'alpha',name:'same',command:'pwd',cwd:"/remote/a'b",pty:false,continueAfterStart:true});
assert(!a.isError,JSON.stringify(a)); const id=a.details.id; const m=meta(id); assert.equal(m.host,'alpha'); assert(m.remoteId.startsWith('pi-')); assert.notEqual(m.remoteId,id);
let s=read(); let launch=s.calls.find(c=>c.args.includes('run')); assert(launch.args.includes('--host')); assert(launch.args.includes('--no-tty')); assert.equal(launch.cwd,${JSON.stringify(import.meta.dir)}); const cmd=launch.args.at(-1); assert(cmd.includes("cd '/remote/a")); assert(!cmd.includes('PI_SESSION_FILE')); assert(!cmd.includes('/local/'));
const longNamespace='12345678-1234-1234-1234-123456789abc/'+ 'long-session-'.repeat(100);
const bounded=remoteProcessId(longNamespace); assert.equal(bounded.length,52); assert(/^[A-Za-z0-9_.-]+$/.test(bounded)); assert.equal(bounded.slice(0,16),remoteProcessId(longNamespace).slice(0,16)); assert.notEqual(bounded,remoteProcessId(longNamespace)); assert.notEqual(bounded.slice(0,16),remoteProcessId(longNamespace+'different').slice(0,16));
let b=await call('run',{host:'beta',name:'very-long-process-name-'.repeat(6),command:'echo second',continueAfterStart:true}); assert(!b.isError,JSON.stringify(b)); assert.equal(meta(b.details.id).remoteId.length,52); assert.notEqual(b.details.id,id); assert.notEqual(meta(b.details.id).remoteId,m.remoteId); assert(!read().calls.filter(c=>c.args.includes('run')).at(-1).args.at(-1).includes('cd '));
let check=await call('check',{id,screen:true}); assert(check.content[0].text.includes('remote screen')); assert(check.content[0].text.includes('host=alpha'));
const sent=await call('send',{id,text:'hello'}); assert(!sent.isError,JSON.stringify(sent)); const keyed=await call('send',{id,keys:['Enter']}); assert(!keyed.isError,JSON.stringify(keyed));
check=await call('check',{id,pattern:'output'}); assert(check.content[0].text.includes('matching output')); assert(read().calls.some(c=>c.args.includes('--grep')));
const list=await call('check',{state:'all'}); assert(!list.content[0].text.includes('manual')); assert(list.content[0].text.includes(id));
set({offline:true}); const unknown=await call('check',{id}); assert(unknown.isError); assert(unknown.content[0].text.includes('alpha'));
const wait=await call('wait',{id,timeout:'1s'}); assert(wait.isError); assert(!meta(id).waitCompletionClaimed); assert(!meta(id).notified);
const kill=await call('kill',{id}); assert(kill.isError); assert(!meta(id).killNotificationSuppressed);
let localList=await call('check',{state:'all'}); assert(!localList.isError); assert(localList.content[0].text.includes('SSH unavailable')); assert.equal(messages.length,0);
set({offline:false,unconfirmed:true}); assert((await call('kill',{id})).isError); assert(!meta(id).killNotificationSuppressed);
set({unconfirmed:false,logFail:true}); assert((await call('check',{id})).isError);
set({logFail:false,finish:true}); const done=await call('wait',{id,timeout:'1s',expect:'ready'}); assert(!done.isError);
const exited=await call('wait',{id,timeout:'1s'}); assert(!exited.isError,JSON.stringify(exited)); assert(exited.content[0].text.includes('remote output')); assert.equal(meta(id).remoteTerminalState,'exited');
assert(!(await call('kill',{id:b.details.id})).isError);
set({failLaunch:true,finish:false}); const failed=await call('run',{host:'alpha',name:'uncertain',command:'sleep 10',continueAfterStart:true}); assert(failed.isError); assert(failed.content[0].text.includes('Tracked id: uncertain')); assert(meta('uncertain').remoteId); assert(!(await call('check',{id:'uncertain'})).isError);
set({failLaunch:false}); const cancelled=await call('run',{host:'alpha',name:'cancel',command:'sleep 10',foreground:true},AbortSignal.abort()); assert(cancelled.isError); assert.equal(meta('cancel').remoteTerminalState,'killed');
// Cancelling a live remote wait must not block on the SSH transport process
// that inherited the CLI's pipes, and must not leave that transport behind.
set({hangWait:true}); const controller=new AbortController(); const hangStarted=Date.now(); setTimeout(()=>controller.abort(),500); const hung=await call('run',{host:'alpha',name:'hung',command:'sleep 10',foreground:true},controller.signal); const hangElapsed=Date.now()-hangStarted; set({hangWait:false}); assert(hung.isError); assert(hangElapsed<5000,'remote cancellation blocked for '+hangElapsed+'ms'); assert(hung.content[0].text.includes('cleanup confirmed'),JSON.stringify(hung)); assert.equal(meta('hung').remoteTerminalState,'killed'); const transportPid=Number(fs.readFileSync(process.env.FAKE_STATE+'.grandchild','utf8')); let transportAlive=true; for(let i=0;i<20&&transportAlive;i++){try{process.kill(transportPid,0);await new Promise(r=>setTimeout(r,50));}catch{transportAlive=false;}} assert(!transportAlive,'remote transport survived cancellation');
const detached=await call('run',{host:'alpha',name:'detached',command:'sleep 10',foreground:true,lifecycle:'detached'},AbortSignal.abort()); assert(detached.isError); assert(!meta('detached').remoteTerminalState); assert(!(await call('kill',{id:'detached'})).isError);
set({unconfirmed:true}); const unverified=await call('run',{host:'alpha',name:'unverified',command:'sleep 10',foreground:true},AbortSignal.abort()); assert(unverified.isError); assert(unverified.content[0].text.includes('could not be verified')); assert(!meta('unverified').killNotificationSuppressed); set({unconfirmed:false}); assert(!(await call('kill',{id:'unverified'})).isError);
set({malformed:true}); const malformed=await call('run',{host:'alpha',name:'malformed',command:'true',continueAfterStart:true}); assert(malformed.isError); assert(meta('malformed').remoteId); set({malformed:false}); assert(!(await call('kill',{id:'malformed'})).isError);
// A running preview must be replaced by a final tail; failed terminal reads
// must retry until a successful terminal read becomes reusable.
set({logText:'running preview'}); const tailProc=await call('run',{host:'alpha',name:'tail-cache',command:'sleep 10',continueAfterStart:true}); assert(!tailProc.isError); assert(widgetTail('tail-cache',false).join('').includes('running preview'));
set({logText:'final tail',logFail:true}); assert(!(await call('kill',{id:'tail-cache'})).isError); assert(widgetTail('tail-cache',false).join('').includes('unavailable'));
set({logFail:false}); assert(!(await call('kill',{id:'tail-cache'})).isError); assert(widgetTail('tail-cache',false).join('').includes('final tail'));
const finalRemoteId=meta('tail-cache').remoteId; const finalReads=()=>read().calls.filter(c=>c.args.includes('log') && c.args.includes(finalRemoteId)).length; const cachedReads=finalReads(); assert(!(await call('kill',{id:'tail-cache'})).isError); assert.equal(finalReads(),cachedReads);
const restarted=read(); Object.assign(restarted.sessions.alpha[finalRemoteId],{state:'running',alive:true,exit_code:null}); fs.writeFileSync(process.env.FAKE_STATE,JSON.stringify(restarted)); assert(!(await call('check',{id:'tail-cache'})).isError); assert.equal(meta('tail-cache').remoteTerminalState,undefined); assert(!(await call('kill',{id:'tail-cache'})).isError); set({logText:undefined});
// The widget viewer reads a local mirror of the full remote log, synced incrementally.
set({logText:'first\\n'}); const mirrored=await call('run',{host:'alpha',name:'mirror',command:'sleep 10',continueAfterStart:true}); assert(!mirrored.isError,JSON.stringify(mirrored));
const mirrorText=()=>fs.readFileSync(remoteLogMirrorPath('mirror'),'utf8'); const mirrorReads=()=>read().calls.filter(c=>c.args.includes('log')&&c.args.includes('--json'));
const mirrorDates=()=>fs.readFileSync(remoteLogMirrorPath('mirror').replace(/output\.log$/,'output.timestamps.jsonl'),'utf8');
assert(await syncRemoteLog('mirror')); assert.equal(mirrorText(),'first\\n'); assert.equal(mirrorDates(),'[0,6,1000]\\n'); assert.equal(mirrorReads().at(-1).args[mirrorReads().at(-1).args.indexOf('--since')+1],'0'); assert(mirrorReads().at(-1).args.includes(meta('mirror').remoteId));
set({logText:'first\\nsecond\\n'}); assert(await syncRemoteLog('mirror')); assert.equal(mirrorText(),'first\\nsecond\\n'); assert.equal(mirrorDates(),'[0,6,1000]\\n[6,7,1001]\\n'); assert.equal(mirrorReads().at(-1).args[mirrorReads().at(-1).args.indexOf('--since')+1],'6');
assert(!(await syncRemoteLog('mirror'))); assert.equal(mirrorText(),'first\\nsecond\\n');
set({logText:'restarted\\n'}); assert(await syncRemoteLog('mirror')); assert(await syncRemoteLog('mirror')); assert.equal(mirrorText(),'restarted\\n'); assert.equal(mirrorDates(),'[0,10,1000]\\n');
// An older remote babysit without --timestamps still mirrors text, undated.
set({logText:'restarted\\nold host\\n',noTimestamps:true}); assert(await syncRemoteLog('mirror')); assert.equal(mirrorText(),'restarted\\nold host\\n'); assert.equal(mirrorDates(),'[0,10,1000]\\n'); const plainReads=mirrorReads().length; set({logText:'restarted\\nold host\\nmore\\n'}); assert(await syncRemoteLog('mirror')); assert.equal(mirrorReads().length,plainReads+1); assert(!mirrorReads().at(-1).args.includes('--timestamps')); set({noTimestamps:false}); set({logText:'restarted\\nold host\\nmore\\n'});
assert(!(await call('kill',{id:'mirror'})).isError); assert(await syncRemoteLog('mirror')); const completedReads=mirrorReads().length; assert(!(await syncRemoteLog('mirror'))); assert.equal(mirrorReads().length,completedReads); assert.equal(mirrorText(),'restarted\\nold host\\nmore\\n'); set({logText:undefined});
const bad=await call('run',{host:'--help',command:'true'}); assert(bad.isError); const sub=await call('run',{host:'alpha',profile:'subagent',task:'x'}); assert(sub.isError);
const gc=gcBabysitRoots({rootBase:${JSON.stringify(dir)},currentRoot:'none',olderThanMs:0,dryRun:false,now:Date.now()+100000}); assert(fs.existsSync(process.env.PI_BABYSIT_DIR)); assert(gc.skippedLive.includes('root'));
const terminalRoot=${JSON.stringify(dir)}+'/terminal'; fs.mkdirSync(terminalRoot+'/meta',{recursive:true}); fs.writeFileSync(terminalRoot+'/meta/x.json',JSON.stringify({kind:'process',host:'alpha',remoteId:'owned',remoteTerminalState:'exited'})); assert(gcBabysitRoots({rootBase:${JSON.stringify(dir)},currentRoot:'none',olderThanMs:0,dryRun:false,now:Date.now()+100000}).deleted.includes('terminal'));
assert.throws(()=>validateProcessHost('host name')); validateProcessHost('user@host'); assert(remoteProcessCommand('echo ok',undefined,{PI_SESSION_FILE:'bad',PI_MODEL:'safe'}).includes("PI_MODEL='safe'"));
assert(!read().calls.some(c=>c.args.includes('-s')&&c.args[c.args.indexOf('-s')+1]==='manual'));
// Reconnect through session_start with persisted metadata, then prove an SSH
// outage cannot notify and a recovered terminal observation can notify once.
const root=process.env.PI_BABYSIT_DIR; fs.mkdirSync(root+'/fake',{recursive:true}); fs.renameSync(root+'/meta',root+'/fake/meta');
ctx.ui.notify=()=>{}; set({offline:true}); await hooks.get('session_start')({},ctx);
await new Promise(r=>setTimeout(r,5500)); assert.equal(messages.length,0);
const recovered=read(); recovered.offline=false; Object.assign(recovered.sessions.alpha[JSON.parse(fs.readFileSync(root+'/fake/meta/uncertain.json','utf8')).remoteId],{state:'exited',exit_code:0}); fs.writeFileSync(process.env.FAKE_STATE,JSON.stringify(recovered));
await new Promise(r=>setTimeout(r,8200)); assert.equal(messages.length,1,JSON.stringify(messages)); assert(JSON.stringify(messages).includes('uncertain')); assert(JSON.stringify(messages).includes('alpha'));
await hooks.get('session_shutdown')({reason:'reload'});
// A failed local list must not skip reachable tracked remote cleanup.
set({finish:false}); const shutdown=await call('run',{host:'beta',name:'shutdown-remote',command:'sleep 10',continueAfterStart:true}); assert(!shutdown.isError,JSON.stringify(shutdown)); const shutdownMeta=JSON.parse(fs.readFileSync(root+'/fake/meta/shutdown-remote.json','utf8')); set({localFail:true}); const cleanupErrors=[]; const originalError=console.error; console.error=(...args)=>cleanupErrors.push(args.join(' ')); try {await hooks.get('session_shutdown')({reason:'quit'});} finally {console.error=originalError;}
assert.equal(read().sessions.beta[shutdownMeta.remoteId].state,'killed'); assert(cleanupErrors.some(text=>text.includes('Local babysit shutdown cleanup unknown')&&text.includes('local registry unavailable'))); assert(!read().calls.some(c=>c.args.includes('-s')&&c.args[c.args.indexOf('-s')+1]==='manual')); console.log('remote scenarios passed');
`);
 try {
  const result = spawnSync(process.execPath, [script], { cwd: import.meta.dir, env: { ...process.env, PI_BABYSIT_CLI: fake, PI_BABYSIT_DIR: path.join(dir, "root"), FAKE_STATE: state }, encoding: "utf8", timeout: 60_000 });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("remote scenarios passed");
 } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
