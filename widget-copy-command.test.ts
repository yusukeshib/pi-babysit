import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("widget icons copy runnable local/agent/remote commands without executing logs or touching the editor", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pi copy ' test-"));
	const root = path.join(dir, "session root");
	const cli = path.join(dir, "babysit ' cli");
	const state = path.join(dir, "state.json");
	mkdirSync(path.join(root, "meta"), { recursive: true });
	const localId = "process'quoted";
	const agentId = "local-agent";
	const remoteId = "remote-process";
	for (const [id, meta] of [
		[localId, { kind: "process", description: "Build locally" }],
		[agentId, { kind: "subagent", task: "Legacy agent task" }],
		[remoteId, { kind: "process", description: "Remote build", host: "user@server", remoteId: "worker'quoted" }],
	] as const) writeFileSync(path.join(root, "meta", `${id}.json`), JSON.stringify(meta));
	mkdirSync(path.join(root, "sessions", agentId), { recursive: true });
	writeFileSync(path.join(root, "sessions", agentId, "output.log"), "");
	writeFileSync(state, JSON.stringify({ calls: [] }));
	writeFileSync(cli, `#!/usr/bin/env bun
import fs from 'node:fs';
const file=process.env.FAKE_LOG_STATE;
const state=JSON.parse(fs.readFileSync(file,'utf8'));
const args=process.argv.slice(2);
state.calls.push({args,root:process.env.BABYSIT_DIR});
fs.writeFileSync(file,JSON.stringify(state));
if(args[0]==='--version') console.log('babysit 0.14.5');
else if(args.includes('run')) console.log(JSON.stringify({id:args[args.indexOf('--id')+1]}));
else if(args.includes('list')) console.log(JSON.stringify(args.includes('--host')?[{id:"worker'quoted",state:'running'}]:[{id:${JSON.stringify(localId)},state:'running'},{id:${JSON.stringify(agentId)},state:'running'}]));
else if(args.includes('log')) console.log('selected log');
else if(args.includes('screenshot')) console.log('selected screen');
else process.exit(1);
`, { mode: 0o755 });
	const script = path.join(dir, "scenario.ts");
	writeFileSync(script, `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {mock} from 'bun:test';
const host=await import(${JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"))});
let clipboard=[], rejectCopy=false;
mock.module(${JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"))},()=>({...host,copyToClipboard:async text=>{if(rejectCopy)throw new Error('clipboard denied');clipboard.push(text);}}));
const {default:extension}=await import(${JSON.stringify(path.join(import.meta.dir, "index.ts"))});
const commands=new Map(), tools=new Map(), messages=[];
extension({registerTool:t=>tools.set(t.name,t),on(){},registerMessageRenderer(){},registerCommand:(n,c)=>commands.set(n,c),getActiveTools:()=>[],getThinkingLevel:()=> 'low',sendMessage:m=>messages.push(m)});
const read=()=>JSON.parse(fs.readFileSync(process.env.FAKE_LOG_STATE,'utf8'));
let widget, editorEdits=0, notices=[], selected, renderRequests=0;
const ctx={hasUI:true,mode:'tui',cwd:${JSON.stringify(import.meta.dir)},ui:{setWidget:(_name,value)=>{widget=typeof value==='function'?value({requestRender(){renderRequests++;}}):value;},setEditorText:()=>editorEdits++,notify:(text,kind)=>notices.push({text,kind}),theme:{fg:(_,s)=>s,bg:(_,s)=>s,bold:s=>s},select:async(_title,labels)=>labels.find(label=>label.includes(selected))},sessionManager:{getSessionId:()=> 'copy-test',getSessionFile:()=>undefined}};
const refresh=async()=>{const result=await tools.get('babysit_run').execute('test',{description:'Refresh widget fixture',name:'fixture',command:'true',continueAfterStart:true},undefined,undefined,ctx);assert(!result.isError,JSON.stringify(result));};
assert(!commands.has('babysit-log'));
await refresh();
assert(!read().calls.some(c=>c.args.includes('log')),'refresh must not read logs');
const click=async id=>{
 const lines=widget.render(200), y=lines.findIndex(line=>line.includes(id));
 assert(y>=0,id+' not in widget'); assert(/[⧉✓!]$/.test(lines[y]));
 const event={type:'press',button:'left',x:199,y,width:200,height:lines.length,shift:false,alt:false,ctrl:false};
 assert(widget.handleMouse(event).handled);
 assert(widget.render(200)[y].endsWith('…'),'copy must show immediate pending feedback');
 widget.handleMouse({...event,type:'release'}); widget.handleMouse({...event,type:'click'});
 await new Promise(resolve=>setImmediate(resolve));
};
for(const [id,expectedArgs,local] of [
 [${JSON.stringify(localId)},['log','-s',${JSON.stringify(localId)}],true],
 [${JSON.stringify(agentId)},['log','-s',${JSON.stringify(agentId)}],true],
 [${JSON.stringify(remoteId)},['--host','user@server','log','-s',"worker'quoted"],false],
]) {
 const previousLogCalls=read().calls.filter(c=>c.args.includes('log')).length, previousCopies=clipboard.length;
 await click(id);
 assert.equal(clipboard.length,previousCopies+1);
 assert.equal(read().calls.filter(c=>c.args.includes('log')).length,previousLogCalls,'copy must not execute logs');
 assert(widget.render(200).find(line=>line.includes(id)).endsWith('✓'),'successful copy must show a checkmark');
 const command=clipboard.at(-1);
 const result=spawnSync('sh',['-c',command],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr); assert.equal(result.stdout.trim(),'selected log');
 const call=read().calls.at(-1); assert.deepEqual(call.args,expectedArgs);
 if(local) assert.equal(call.root,process.env.PI_BABYSIT_DIR);
}
assert.equal(editorEdits,0); assert(renderRequests>=6);
const originalWidget=widget; await refresh(); assert.equal(widget,originalWidget,'poll refresh must preserve feedback state'); assert(widget.render(200).find(line=>line.includes(${JSON.stringify(localId)})).endsWith('✓'));
rejectCopy=true; const previousCopies=clipboard.length; await click(${JSON.stringify(localId)});
assert.equal(clipboard.length,previousCopies); assert(widget.render(200).find(line=>line.includes(${JSON.stringify(localId)})).endsWith('!')); assert.equal(editorEdits,0);
// The existing keyboard picker exposes the same command for manual copying.
for(const [id,expected] of [[${JSON.stringify(localId)},clipboard[0]],[${JSON.stringify(agentId)},clipboard[1]],[${JSON.stringify(remoteId)},clipboard[2]]]) {
 selected=id; await commands.get('babysit').handler('',ctx); assert(messages.at(-1).details.body.includes(expected));
}
originalWidget.dispose(); ctx.mode='rpc'; await refresh(); assert(Array.isArray(widget)); assert(!widget.join('').includes('⧉'));
`);
	try {
		const result = spawnSync(process.execPath, [script], {
			cwd: import.meta.dir,
			env: { ...process.env, PI_BABYSIT_CLI: cli, PI_BABYSIT_DIR: root, FAKE_LOG_STATE: state },
			encoding: "utf8", timeout: 15_000,
		});
		expect(result.status, result.stdout + result.stderr).toBe(0);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
