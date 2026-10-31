import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The background poller must not SSH to hosts whose tracked sessions are all
// settled, and must back off hosts where a tracked session cannot be found.
test("poller skips settled remote hosts and backs off lost remote sessions", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-remote-poll-"));
	const calls = path.join(dir, "calls.log");
	const fake = path.join(dir, "babysit");
	writeFileSync(
		fake,
		`#!/usr/bin/env bun
import fs from 'node:fs';
const args = process.argv.slice(2);
let host = 'local'; if (args[0] === '--host') { host = args[1]; args.splice(0, 2); }
fs.appendFileSync(${JSON.stringify(calls)}, host + ' ' + args.join(' ') + '\\n');
if (args[0] === '--version') console.log('babysit 0.14.7');
else if (args[0] === 'list') console.log(JSON.stringify(host === 'alpha' ? [{ id: 'remote-done', state: 'exited', exit_code: 0, alive: false }] : []));
else { console.error('unexpected ' + args.join(' ')); process.exit(1); }
`,
		{ mode: 0o755 },
	);
	const root = path.join(dir, "root");
	const meta = path.join(root, "fake", "meta");
	mkdirSync(meta, { recursive: true });
	writeFileSync(
		path.join(meta, "done.json"),
		JSON.stringify({ kind: "process", host: "alpha", remoteId: "remote-done", remoteTerminalState: "exited", notified: true }),
	);
	writeFileSync(path.join(meta, "lost.json"), JSON.stringify({ kind: "process", host: "beta", remoteId: "remote-lost" }));
	const script = path.join(dir, "scenario.ts");
	writeFileSync(
		script,
		`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import extension from ${JSON.stringify(path.join(import.meta.dir, "index.ts"))};
const hooks = new Map(); const messages = [];
extension({registerTool(){},on:(n,h)=>hooks.set(n,h),registerCommand(){},registerMessageRenderer(){},getActiveTools:()=>[],setActiveTools(){},getThinkingLevel:()=>'low',sendMessage:m=>messages.push(m)});
const ctx={hasUI:true,mode:'tui',ui:{notify(){},setWidget(){},theme:{fg:(_,s)=>s,bg:(_,s)=>s,bold:s=>s}},cwd:'/tmp',isIdle:()=>true,sessionManager:{getSessionId:()=>'fake',getSessionFile:()=>'/tmp/s.jsonl'},model:{provider:'t',id:'t'}};
await hooks.get('session_start')({}, ctx);
await new Promise(r => setTimeout(r, 11_000));
await hooks.get('session_shutdown')({ reason: 'reload' });
const lines = fs.readFileSync(${JSON.stringify(calls)}, 'utf8').trim().split('\\n');
const lists = host => lines.filter(l => l === host + ' list --json').length;
// The settled alpha session is observed at most once, then never again.
assert(lists('alpha') <= 1, 'alpha queried ' + lists('alpha') + ' times');
// Without backoff beta would be queried on all 4 ticks (2.5s..10s).
assert(lists('beta') >= 2 && lists('beta') <= 3, 'beta queried ' + lists('beta') + ' times');
assert.equal(messages.length, 0, JSON.stringify(messages));
console.log('remote poll scenario passed');
`,
	);
	try {
		const result = spawnSync(process.execPath, [script], {
			cwd: import.meta.dir,
			env: { ...process.env, PI_BABYSIT_CLI: fake, PI_BABYSIT_DIR: root, PI_BABYSIT_RETENTION_DAYS: "0" },
			encoding: "utf8",
			timeout: 60_000,
		});
		expect(result.status, result.stdout + result.stderr).toBe(0);
		expect(result.stdout).toContain("remote poll scenario passed");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);
