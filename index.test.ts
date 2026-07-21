import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import extension from "./index.ts";

const tools = new Map<string, any>();

extension({
	registerTool(tool: { name: string }) {
		tools.set(tool.name, tool);
	},
	on() {},
	registerMessageRenderer() {},
	registerCommand() {},
	sendMessage() {},
} as any);

const ctx = { hasUI: false, cwd: process.cwd() };
let sequence = 0;

async function run(command: string, extras: Record<string, unknown> = {}) {
	return tools.get("babysit_run").execute(
		"test",
		{ name: `log-test-${Date.now()}-${sequence++}`, command, pty: false, ...extras },
		undefined,
		undefined,
		ctx,
	) as Promise<{
		content: Array<{ text: string }>;
		details: { id: string; logPath: string; retried?: boolean };
		isError?: boolean;
	}>;
}

test("small process output is returned with metadata and a log path", async () => {
	const result = await run("printf '\\160\\162\\151\\166\\141\\164\\145\\055\\157\\165\\164\\160\\165\\164\\055\\154\\151\\156\\145\\012'");
	const text = result.content[0]?.text ?? "";

	expect(result.isError).toBe(false);
	expect(text).toContain("completed successfully");
	expect(text).toContain(`Log: ${result.details.logPath}`);
	expect(text).toContain("private-output-line");
	expect(readFileSync(result.details.logPath, "utf8")).toContain("private-output-line");
});

test("failed commands return small stderr, exit status, and a usable log path", async () => {
	const result = await run("printf '\\146\\141\\151\\154\\055\\144\\145\\164\\141\\151\\154\\012' >&2; exit 7");
	const text = result.content[0]?.text ?? "";

	expect(result.isError).toBe(true);
	expect(text).toContain("exited with code 7");
	expect(text).toContain("fail-detail");
	expect(readFileSync(result.details.logPath, "utf8")).toContain("fail-detail");
});

test("external worker death is diagnosed without replaying by default", async () => {
	const marker = `/tmp/pi-babysit-no-retry-${process.pid}-${Date.now()}`;
	const result = await run(`printf x >> ${marker}; kill -9 $PPID; sleep 1`);
	const text = result.content[0]?.text ?? "";

	expect(result.isError).toBe(true);
	expect(result.details.retried).toBe(false);
	expect(text).toContain("worker-dead");
	expect(text).toContain("external kill");
	expect(readFileSync(marker, "utf8")).toBe("x");
});

test("opt-in retry recovers once from startup worker death", async () => {
	const marker = `/tmp/pi-babysit-retry-${process.pid}-${Date.now()}`;
	const command = `if test ! -e ${marker}; then touch ${marker}; kill -9 $PPID; sleep 1; else printf 'retry-recovered\\n'; fi`;
	const result = await run(command, { retryOnWorkerDeath: true });
	const text = result.content[0]?.text ?? "";

	expect(result.isError).toBe(false);
	expect(result.details.retried).toBe(true);
	expect(text).toContain("Retried once");
	expect(text).toContain("retry-recovered");
});

test("opt-in retry is limited to one failed retry", async () => {
	const result = await run("kill -9 $PPID; sleep 1", { retryOnWorkerDeath: true });
	const text = result.content[0]?.text ?? "";

	expect(result.isError).toBe(true);
	expect(result.details.retried).toBe(true);
	expect(text).toContain("Retried once");
	expect(text).toContain("worker-dead");
});

test("large output stays out of the run result and remains available through bounded check", async () => {
	const result = await run("python3 -c \"print(chr(120) * 20000); print(''.join(map(chr,[76,65,83,84,45,77,65,82,75,69,82])))\"");
	const text = result.content[0]?.text ?? "";

	expect(Buffer.byteLength(text)).toBeLessThan(1000);
	expect(text).not.toContain("LAST-MARKER");

	const checked = await tools.get("babysit_check").execute("test", { id: result.details.id, lines: 2 });
	const checkedText = checked.content[0]?.text ?? "";
	expect(checkedText).toContain("LAST-MARKER");
	expect(checkedText).toContain("bytes elided");
	expect(Buffer.byteLength(checkedText)).toBeLessThan(10_000);
});
