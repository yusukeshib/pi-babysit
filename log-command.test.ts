import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("/babysit-log fills the buffer with runnable local/remote log commands without executing them", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pi log ' test-"));
	const root = path.join(dir, "session root");
	const cli = path.join(dir, "babysit ' cli");
	const state = path.join(dir, "state.json");
	mkdirSync(path.join(root, "meta"), { recursive: true });
	const localId = "process'quoted";
	const agentId = "finished-agent";
	const remoteId = "remote-process";
	for (const [id, meta] of [
		[localId, { kind: "process", description: "Build locally" }],
		[agentId, { kind: "subagent", task: "Legacy agent task" }],
		[remoteId, { kind: "process", description: "Remote build", host: "user@server", remoteId: "worker'quoted" }],
	] as const) writeFileSync(path.join(root, "meta", `${id}.json`), JSON.stringify(meta));
	writeFileSync(state, JSON.stringify({ empty: false, calls: [] }));
	writeFileSync(cli, `#!/usr/bin/env bun
import fs from 'node:fs';
const file=process.env.FAKE_LOG_STATE;
const state=JSON.parse(fs.readFileSync(file,'utf8'));
const args=process.argv.slice(2);
state.calls.push({args,root:process.env.BABYSIT_DIR});
fs.writeFileSync(file,JSON.stringify(state));
if(args[0]==='--version') console.log('babysit 0.14.5');
else if(args.includes('list')) console.log(JSON.stringify(state.empty?[]:args.includes('--host')?[{id:"worker'quoted",state:'running'}]:[{id:${JSON.stringify(localId)},state:'running'},{id:${JSON.stringify(agentId)},state:'exited',exit_code:0}]));
else if(args.includes('log')) console.log('selected log');
else process.exit(1);
`, { mode: 0o755 });
	const script = path.join(dir, "scenario.ts");
	writeFileSync(script, `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import extension from ${JSON.stringify(path.join(import.meta.dir, "index.ts"))};
const commands=new Map();
extension({registerTool(){},on(){},registerMessageRenderer(){},registerCommand:(n,c)=>commands.set(n,c),getActiveTools:()=>[],sendMessage(){}});
const read=()=>JSON.parse(fs.readFileSync(process.env.FAKE_LOG_STATE,'utf8'));
let selected=${JSON.stringify(localId)}, buffer='original draft', labels=[], edits=0, notices=[];
const ctx={hasUI:true,ui:{select:async(_title,items)=>{labels=items;return selected===undefined?undefined:items.find(item=>item.includes(selected));},setEditorText:text=>{buffer=text;edits++;},notify:(text,kind)=>notices.push({text,kind})}};
const handler=commands.get('babysit-log').handler;
assert(!commands.has('babysit-view'));
for(const [id,expectedArgs,local] of [
 [${JSON.stringify(localId)},['log','-s',${JSON.stringify(localId)}],true],
 [${JSON.stringify(agentId)},['log','-s',${JSON.stringify(agentId)}],true],
 [${JSON.stringify(remoteId)},['--host','user@server','log','-s',"worker'quoted"],false],
]) {
 selected=id;
 const previousLogCalls=read().calls.filter(c=>c.args.includes('log')).length;
 await handler('',ctx);
 assert.equal(read().calls.filter(c=>c.args.includes('log')).length,previousLogCalls,'command must not execute logs');
 assert(buffer.includes(' log -s '),buffer);
 assert(!buffer.startsWith('!'));
 const result=spawnSync('sh',['-c',buffer],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 assert.equal(result.stdout.trim(),'selected log');
 const call=read().calls.at(-1);
 assert.deepEqual(call.args,expectedArgs);
 if(local) assert.equal(call.root,process.env.PI_BABYSIT_DIR);
}
assert(labels.some(s=>s.includes('Build locally')));
assert(labels.some(s=>s.includes('[subagent]')&&s.includes('Legacy agent task')&&s.includes('exited')));
assert(labels.some(s=>s.includes('Remote build')));
const unchanged=buffer, previousEdits=edits;
selected=undefined; await handler('',ctx); assert.equal(buffer,unchanged); assert.equal(edits,previousEdits);
await handler('unexpected',ctx); assert.equal(edits,previousEdits); assert(notices.at(-1).text.includes('Usage'));
await handler('',{...ctx,hasUI:false}); assert.equal(edits,previousEdits);
fs.rmSync(process.env.PI_BABYSIT_DIR+'/meta/'+${JSON.stringify(remoteId)}+'.json');
const state=read(); state.empty=true; fs.writeFileSync(process.env.FAKE_LOG_STATE,JSON.stringify(state));
await handler('',ctx); assert.equal(edits,previousEdits); assert.equal(notices.at(-1).text,'No babysit sessions.');
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
