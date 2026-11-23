import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Runs the extension's background poller for `waitMs` against a fake babysit
// CLI where `beta` is unreachable, `alpha` lists one exited worker, and every
// other host lists nothing. `metas` seeds the session's metadata directory and
// `assertions` runs after shutdown with `lines`, `lists`, `messages`,
// `widgetText`, and `readMeta(id)` in scope.
function runPollScenario(metas: Record<string, object>, waitMs: number, assertions: string): void {
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
else if (host === 'beta') { console.error('ssh: connect to host beta: Connection refused'); process.exit(255); }
else if (args[0] === 'list') console.log(JSON.stringify(host === 'alpha' ? [{ id: 'remote-done', state: 'exited', exit_code: 0, alive: false }] : []));
else { console.error('error: session not found'); process.exit(1); }
`,
		{ mode: 0o755 },
	);
	const root = path.join(dir, "root");
	const meta = path.join(root, "fake", "meta");
	mkdirSync(meta, { recursive: true });
	for (const [id, value] of Object.entries(metas)) writeFileSync(path.join(meta, `${id}.json`), JSON.stringify(value));
	const script = path.join(dir, "scenario.ts");
	writeFileSync(
		script,
		`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import extension from ${JSON.stringify(path.join(import.meta.dir, "index.ts"))};
const hooks = new Map(); const messages = [];
extension({registerTool(){},on:(n,h)=>hooks.set(n,h),registerCommand(){},registerMessageRenderer(){},getActiveTools:()=>[],setActiveTools(){},getThinkingLevel:()=>'low',sendMessage:m=>messages.push(m)});
let widget;
const ctx={hasUI:true,mode:'tui',ui:{notify(){},setWidget(_name,factory){widget=typeof factory==='function'?factory({requestRender(){}}):undefined;},theme:{fg:(_,s)=>s,bg:(_,s)=>s,bold:s=>s}},cwd:'/tmp',isIdle:()=>true,sessionManager:{getSessionId:()=>'fake',getSessionFile:()=>'/tmp/s.jsonl'},model:{provider:'t',id:'t'}};
await hooks.get('session_start')({}, ctx);
await new Promise(r => setTimeout(r, ${waitMs}));
const widgetText = widget ? widget.render(200).join('\\n') : '';
await hooks.get('session_shutdown')({ reason: 'reload' });
const lines = fs.readFileSync(${JSON.stringify(calls)}, 'utf8').trim().split('\\n');
const lists = host => lines.filter(l => l === host + ' list --json').length;
const readMeta = id => JSON.parse(fs.readFileSync(${JSON.stringify(meta)} + '/' + id + '.json', 'utf8'));
${assertions}
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
}

// The background poller must not SSH to hosts whose tracked sessions are all
// settled, and must back off hosts that cannot be reached. A terminal state
// persisted before the outage stays final instead of reverting to "unknown".
test("poller skips settled remote hosts and backs off unreachable ones", () => {
	runPollScenario(
		{
			done: { kind: "process", host: "alpha", remoteId: "remote-done", remoteTerminalState: "exited", notified: true },
			lost: { kind: "process", host: "beta", remoteId: "remote-lost" },
			"finished-offline": {
				kind: "process",
				host: "beta",
				remoteId: "remote-finished",
				remoteTerminalState: "exited",
				remoteExitCode: 3,
				notified: true,
			},
		},
		16_000,
		`
// The settled alpha session is observed at most once, then never again.
assert(lists('alpha') <= 1, 'alpha queried ' + lists('alpha') + ' times');
// Remote hosts are queried at most once per 2.5s even though local ticks are
// faster. Without backoff beta would be queried 7 times in 16s; with it the
// third failure defers the next query by 5s and the fourth by 10s.
assert(lists('beta') >= 3 && lists('beta') <= 4, 'beta queried ' + lists('beta') + ' times');
// Local status is read from disk, never through the CLI.
assert.equal(lists('local'), 0);
assert.equal(messages.length, 0, JSON.stringify(messages));
// The unreachable session stays unknown; the finished one never reappears as running.
assert(widgetText.includes('lost') && widgetText.includes('status unknown'), widgetText);
assert(!widgetText.includes('finished-offline'), widgetText);
`,
	);
}, 40_000);

// A reachable host that does not list a tracked worker (an unverified launch
// that never started, or a record removed on the host) resolves it as dead
// once, instead of showing "running · status unknown" forever.
test("poller resolves a remote worker missing from a reachable host", () => {
	runPollScenario(
		{
			missing: { kind: "process", host: "gamma", remoteId: "remote-missing", notified: false, startedAt: Date.now() - 60_000 },
			// Still inside the registration grace window: not yet evidence of absence.
			fresh: { kind: "process", host: "gamma", remoteId: "remote-fresh", notified: false, startedAt: Date.now() + 60_000 },
		},
		3_000,
		`
assert.equal(messages.length, 1, JSON.stringify(messages));
assert(messages[0].content.includes('"missing"'), JSON.stringify(messages));
assert(messages[0].content.includes("not in gamma's babysit registry"), JSON.stringify(messages));
assert.equal(readMeta('missing').remoteTerminalState, 'dead');
assert.equal(readMeta('missing').notified, true);
assert.equal(readMeta('fresh').remoteTerminalState, undefined);
assert(!widgetText.includes('missing'), widgetText);
assert(widgetText.includes('fresh') && !widgetText.includes('status unknown'), widgetText);
`,
	);
}, 40_000);
