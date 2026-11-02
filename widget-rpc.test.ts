import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("RPC polling stays UI-silent while still delivering process completion once", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-widget-rpc-"));
	const root = path.join(dir, "root");
	const meta = path.join(root, "rpc-test", "meta");
	const state = path.join(dir, "state.json");
	const cli = path.join(dir, "babysit");
	mkdirSync(meta, { recursive: true });
	writeFileSync(path.join(meta, "job.json"), JSON.stringify({
		kind: "process", command: "fixture", description: "Background fixture",
		startedAt: Date.now(), completionObservedAt: Date.now() - 10_000,
	}));
	writeFileSync(state, JSON.stringify({ running: true, lists: 0 }));
	writeFileSync(cli, `#!/usr/bin/env bun
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('babysit 0.14.7');
else if (args[0] === 'list') {
 const state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
 state.lists++;
 fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(state));
 console.log(JSON.stringify([{ id: 'job', state: state.running ? 'running' : 'exited', exit_code: state.running ? null : 0, output_bytes: 0 }]));
} else if (args[0] === 'log') console.log('fixture output');
else { console.error('unexpected command: ' + args.join(' ')); process.exit(1); }
`, { mode: 0o755 });
	const script = path.join(dir, "scenario.ts");
	writeFileSync(script, `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import extension from ${JSON.stringify(path.join(import.meta.dir, "index.ts"))};
const hooks = new Map(), messages = [], uiRequests = [];
let complete;
const completion = new Promise(resolve => { complete = resolve; });
extension({registerTool(){}, on:(name, handler)=>hooks.set(name, handler), registerCommand(){}, registerMessageRenderer(){}, getActiveTools:()=>[], getThinkingLevel:()=>'low', sendMessage:message=>{messages.push(message);complete();}});
const ctx = {
 hasUI:true, mode:'rpc', cwd:${JSON.stringify(import.meta.dir)}, isIdle:()=>true,
 ui:{setWidget:(...args)=>uiRequests.push(['setWidget', ...args]), notify:(...args)=>uiRequests.push(['notify', ...args]), theme:{fg:(_,s)=>s,bg:(_,s)=>s,bold:s=>s}},
 sessionManager:{getSessionId:()=>'rpc-test',getSessionFile:()=>undefined},
};
try {
 await hooks.get('session_start')({}, ctx);
 await new Promise(resolve => setTimeout(resolve, 5600));
 const state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
 assert(state.lists >= 2, 'must exercise repeated running-session polls');
 assert.deepEqual(uiRequests, [], 'running-session polling must not emit UI requests');
 fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify({...state, running:false}));
 let timeout;
 try {
  await Promise.race([completion, new Promise((_, reject)=>{timeout=setTimeout(()=>reject(new Error('missing completion notification')), 10_000);})]);
 } finally { clearTimeout(timeout); }
 await new Promise(resolve => setTimeout(resolve, 2800));
 assert.equal(messages.length, 1, 'completion must not be repeated');
 assert(messages[0].content.includes('fixture output'));
 assert(messages[0].content.includes('Background fixture'));
 assert.deepEqual(uiRequests, [], 'terminal-session polling must not emit UI requests');
} finally {
 await hooks.get('session_shutdown')({reason:'reload'});
}
`);
	try {
		const result = spawnSync(process.execPath, [script], {
			cwd: import.meta.dir,
			env: { ...process.env, PI_BABYSIT_CLI: cli, PI_BABYSIT_DIR: root, PI_BABYSIT_RETENTION_DAYS: "0" },
			encoding: "utf8", timeout: 25_000,
		});
		expect(result.status, result.stdout + result.stderr).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);
