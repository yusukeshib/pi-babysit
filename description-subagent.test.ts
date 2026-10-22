import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("fake subagent persists a trimmed description without changing its task", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "babysit-description-agent-"));
	const fake = path.join(dir, "fake-pi.mjs");
	const root = path.join(dir, "root");
	const capture = path.join(dir, "received.jsonl");
	const name = "description-fake-agent";
	writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const emit = event => console.log(JSON.stringify(event));
fs.appendFileSync(process.env.FAKE_PI_CAPTURE, JSON.stringify({argv:process.argv.slice(2)})+'\\n');
emit({type:'session_start'});
readline.createInterface({input:process.stdin}).on('line', line => {
 let request; try {request=JSON.parse(line);} catch {return;}
 fs.appendFileSync(process.env.FAKE_PI_CAPTURE, JSON.stringify(request)+'\\n');
 if(request.type==='prompt') {
  emit({type:'response',command:'prompt',id:request.id,success:true});
  emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Fake task complete'}],stopReason:'stop',usage:{input:1,output:1,totalTokens:2,cost:{total:0}}}});
  emit({type:'agent_settled'});
 } else if(request.type==='get_state') {
  emit({type:'response',command:'get_state',id:request.id,success:true,data:{model:{id:'fake-model'}}});
 }
});
`, { mode: 0o755 });
	const scenario = path.join(dir, "scenario.ts");
	writeFileSync(scenario, `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import extension from ${JSON.stringify(path.join(import.meta.dir, "index.ts"))};
const tools = new Map();
extension({registerTool:t=>tools.set(t.name,t),on(){},registerCommand(){},registerMessageRenderer(){},getActiveTools:()=>[],getThinkingLevel:()=> 'low',sendMessage(){}});
const ctx={hasUI:true,ui:{setWidget(){},theme:{fg:(_,s)=>s,bg:(_,s)=>s,bold:s=>s}},cwd:${JSON.stringify(import.meta.dir)},sessionManager:{getSessionId:()=> 'description-test',getSessionFile:()=>undefined},model:{provider:'fake',id:'fake-model'}};
let id=${JSON.stringify(name)};
try {
 const result=await tools.get('babysit_run').execute('description-test',{name:id,profile:'subagent',task:'Execute ONLY the actual fake task.',description:'  Inspect description persistence  ',timeout:'15s',reapAfter:'none'},undefined,undefined,ctx);
 assert(!result.isError,JSON.stringify(result));
 id=result.details.id;
 assert.equal(result.details.description,'Inspect description persistence');
 const meta=JSON.parse(fs.readFileSync(process.env.PI_BABYSIT_DIR+'/meta/'+id+'.json','utf8'));
 assert.equal(meta.description,'Inspect description persistence');
 assert.equal(meta.task,'Execute ONLY the actual fake task.');
 const call=async(name,args)=>{const result=await tools.get('babysit_'+name).execute('operation-test',args,undefined,undefined,ctx);assert(!result.isError,JSON.stringify(result));return result;};
 const unchanged=()=>{const current=JSON.parse(fs.readFileSync(process.env.PI_BABYSIT_DIR+'/meta/'+id+'.json','utf8')); for(const key of ['name','description','launchCommand','reapAfter','startedAt']) assert.deepEqual(current[key],meta[key],key+' changed during an operation');};
 await call('wait',{id,timeout:'5s',description:'Wait for initial fake task'}); unchanged();
 await call('check',{id,description:'Inspect fake worker status'}); unchanged();
 await call('send',{id,text:'Follow up ONLY with this exact text.',mode:'task',description:'Dispatch followup without leaking purpose'}); unchanged();
 await call('wait',{id,timeout:'5s',description:'Wait for followup fake task'}); unchanged();
 await call('kill',{id,description:'Stop fake worker'}); unchanged();
 const requests=fs.readFileSync(process.env.FAKE_PI_CAPTURE,'utf8').trim().split('\\n').map(line=>JSON.parse(line));
 const argv=requests.find(request=>request.argv).argv;
 assert.deepEqual(argv.slice(0,2),['--mode','rpc']);
 assert(!argv.includes('--no-session'),'Subagents must retain Pi session persistence');
 const prompt=requests.find(request=>request.type==='prompt');
 assert.equal(prompt.message,'Task: Execute ONLY the actual fake task.');
 assert.equal(requests.filter(request=>request.type==='prompt').at(-1).message,'Follow up ONLY with this exact text.');
 for(const description of ['Inspect description persistence','Wait for initial fake task','Inspect fake worker status','Dispatch followup without leaking purpose','Wait for followup fake task','Stop fake worker']) assert(!JSON.stringify(requests).includes(description));
 console.log('fake description persistence passed');
} finally {
 await tools.get('babysit_kill').execute('cleanup',{id,description:'Clean up fake subagent'},undefined,undefined,ctx);
}
`);
	try {
		const result = spawnSync(process.execPath, [scenario], {
			cwd: import.meta.dir,
			env: { ...process.env, PI_BABYSIT_DIR: root, PI_BABYSIT_BIN: fake, FAKE_PI_CAPTURE: capture, PI_BABYSIT_INTERNAL_SUBAGENT_DEPTH: "0", PI_BABYSIT_INTERNAL_SUBAGENT_MAX_DEPTH: "1" },
			encoding: "utf8",
			timeout: 25_000,
		});
		expect(result.status, result.stdout + result.stderr).toBe(0);
		expect(result.stdout).toContain("fake description persistence passed");
	} finally {
		// Also clean up if the bounded scenario was terminated before its finally.
		spawnSync(process.env.PI_BABYSIT_CLI ?? "babysit", ["kill", "-s", name], {
			env: { ...process.env, BABYSIT_DIR: root }, encoding: "utf8", timeout: 5_000,
		});
		rmSync(dir, { recursive: true, force: true });
	}
}, 35_000);
