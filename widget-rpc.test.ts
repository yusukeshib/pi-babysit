import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("RPC polling stays UI-silent, spawns no CLI per tick, and delivers process completion once", () => {
const dir = mkdtempSync(path.join(tmpdir(), "pi-widget-rpc-"));
const root = path.join(dir, "root");
const meta = path.join(root, "rpc-test", "meta");
const session = path.join(root, "rpc-test", "sessions", "job");
const calls = path.join(dir, "calls.log");
const cli = path.join(dir, "babysit");
mkdirSync(meta, { recursive: true });
mkdirSync(session, { recursive: true });
writeFileSync(path.join(meta, "job.json"), JSON.stringify({
kind: "process", command: "fixture", description: "Background fixture", startedAt: Date.now(),
}));
writeFileSync(path.join(session, "output.log"), "\x1b[32mfixture output\x1b[0m\r\n");
writeFileSync(calls, "");
writeFileSync(cli, `#!/usr/bin/env bun
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, args.join(' ') + '\\n');
if (args[0] === '--version') console.log('babysit 0.14.7');
else { console.error('unexpected command: ' + args.join(' ')); process.exit(1); }
`, { mode: 0o755 });
const script = path.join(dir, "scenario.ts");
writeFileSync(script, `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import extension from ${JSON.stringify(path.join(import.meta.dir, "index.ts"))};
const session = ${JSON.stringify(session)};
// Stand-in babysit supervisor: alive while running, gone after the exit.
const supervisor = spawn('sleep', ['30'], {stdio:'ignore'});
fs.writeFileSync(session + '/meta.json', JSON.stringify({id:'job', cmd:['fixture'], babysit_pid: supervisor.pid, started_at: new Date().toISOString()}));
const status = (state, exit_code) => fs.writeFileSync(session + '/status.json', JSON.stringify({state, child_pid: null, exit_code, last_change: new Date().toISOString()}));
status('running', null);
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
 await new Promise(resolve => setTimeout(resolve, 1500));
 assert.deepEqual(uiRequests, [], 'running-session polling must not emit UI requests');
 assert.equal(messages.length, 0, 'a running session must not notify');
 status('exited', 0);
 const exitedAt = Date.now();
 supervisor.kill();
 let timeout;
 try {
  await Promise.race([completion, new Promise((_, reject)=>{timeout=setTimeout(()=>reject(new Error('missing completion notification')), 5_000);})]);
 } finally { clearTimeout(timeout); }
 assert(Date.now() - exitedAt < 1500, 'completion took ' + (Date.now() - exitedAt) + 'ms');
 await new Promise(resolve => setTimeout(resolve, 1000));
 assert.equal(messages.length, 1, 'completion must not be repeated');
 assert(messages[0].content.includes('fixture output'));
 assert(!messages[0].content.includes('\\x1b'), 'output must be stripped of terminal controls');
 assert(messages[0].content.includes('Background fixture'));
 assert.deepEqual(uiRequests, [], 'terminal-session polling must not emit UI requests');
 const spawned = fs.readFileSync(${JSON.stringify(calls)}, 'utf8').trim().split('\\n').filter(Boolean);
 assert.deepEqual(spawned, ['--version'], 'local polling must not spawn the babysit CLI: ' + spawned.join(', '));
} finally {
 supervisor.kill();
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
