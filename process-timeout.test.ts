import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// A recording wrapper keeps the real supervisor and PTY behavior while proving
// the default deadline is forwarded, without making a regression test wait 60s.
test("process deadlines reach the supervisor and a stuck PTY returns an error", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "babysit-process-timeout-"));
	const wrapper = path.join(dir, "babysit");
	const scenario = path.join(dir, "scenario.ts");
	const realCli = Bun.which(process.env.PI_BABYSIT_CLI ?? "babysit");
	expect(realCli).not.toBeNull();
	writeFileSync(wrapper, `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
appendFileSync(process.env.TIMEOUT_CALLS, JSON.stringify(args) + '\\n');
const result = spawnSync(process.env.REAL_BABYSIT, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`, { mode: 0o755 });
	writeFileSync(scenario, `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import extension from ${JSON.stringify(path.join(import.meta.dir, "index.ts"))};
const tools = new Map();
const hooks = new Map();
extension({ registerTool: t => tools.set(t.name, t), on: (n, h) => hooks.set(n, h),
  registerCommand() {}, registerMessageRenderer() {}, sendMessage() {},
  getActiveTools: () => [], getThinkingLevel: () => 'low' });
const ctx = { hasUI: true, cwd: process.cwd(), sessionManager: { getSessionId: () => 'timeout-test', getSessionFile: () => undefined },
  ui: { setWidget() {}, theme: { fg: (_, s) => s, bg: (_, s) => s, bold: s => s } } };
const calls = () => readFileSync(process.env.TIMEOUT_CALLS, 'utf8').trim().split('\\n').filter(Boolean).map(s => JSON.parse(s));
const launches = () => calls().filter(args => args[0] === 'run');
let sequence = 0;
const run = (extras, context = ctx) => tools.get('babysit_run').execute('timeout-test', {
  description: 'Check execution deadline', name: 'deadline-' + sequence++, command: 'printf deadline-ok',
  pty: false, ...extras }, undefined, undefined, context);
try {
  for (const [extras, context, expected] of [
    [{ foreground: true }, ctx, '60s'],
    [{}, { ...ctx, hasUI: false }, '60s'],
    [{ continueAfterStart: true }, ctx, '60s'],
    [{ foreground: true, timeout: '10m' }, ctx, '10m'],
    [{ continueAfterStart: true, timeout: 'none' }, ctx, undefined],
  ]) {
    const result = await run(extras, context);
    assert(!result.isError, JSON.stringify(result));
    const args = launches().at(-1);
    const index = args.indexOf('--timeout');
    if (expected === undefined) assert.equal(index, -1);
    else { assert(index >= 0); assert.equal(args[index + 1], expected); }
  }
  for (const timeout of ['none', '', '0', '0s', 'off', 'never']) {
    const before = calls().length;
    await assert.rejects(() => run({ foreground: true, timeout }), /timeout/i);
    assert.equal(calls().length, before, 'invalid timeout must not invoke the CLI');
  }
  const startedAt = Date.now();
  const stuck = await run({ command: 'grep deadline-pattern', pty: true, foreground: true, timeout: '100ms' });
  assert(stuck.isError, JSON.stringify(stuck));
  assert.notEqual(stuck.details.status, 'running');
  assert(Date.now() - startedAt < 5000, 'a stuck PTY did not return promptly');
  assert(stuck.content[0].text.includes('Log: '), JSON.stringify(stuck));
  console.log('process timeout scenarios passed');
} finally {
  await hooks.get('session_shutdown')({ reason: 'quit' });
}
`);
	try {
		const result = spawnSync(process.execPath, [scenario], {
			cwd: import.meta.dir,
			env: {
				...process.env,
				PI_BABYSIT_CLI: wrapper,
				PI_BABYSIT_DIR: path.join(dir, "root"),
				REAL_BABYSIT: realCli!,
				TIMEOUT_CALLS: path.join(dir, "calls.jsonl"),
			},
			encoding: "utf8",
			timeout: 20_000,
		});
		expect(result.status, result.stdout + result.stderr).toBe(0);
		expect(result.stdout).toContain("process timeout scenarios passed");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 25_000);
