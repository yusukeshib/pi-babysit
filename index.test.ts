import { expect, test } from "bun:test";
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

async function run(command: string, report?: Record<string, string>) {
	const result = await tools.get("babysit_run").execute(
		"test",
		{
			name: `report-test-${Date.now()}-${sequence++}`,
			command,
			pty: false,
			report,
		},
		undefined,
		undefined,
		ctx,
	);
	return result as { content: Array<{ text: string }>; details: { id: string }; isError?: boolean };
}

test("completion report replaces the raw log in a process result", async () => {
	const result = await run("printf '\\162\\141\\167\\055\\163\\145\\143\\162\\145\\164\\055\\154\\151\\156\\145\\012'; exit 7", {
		language: "javascript",
		code: "console.log(`failures: ${INPUT.includes('raw-secret-line') ? 1 : 0}`)",
	});

	expect(result.isError).toBe(true);
	expect(result.content[0]?.text).toContain("Report:\nfailures: 1");
	expect(result.content[0]?.text).not.toContain("raw-secret-line");

	const checked = await tools.get("babysit_check").execute("test", { id: result.details.id });
	expect(checked.content[0]?.text).toContain("raw-secret-line");
});

test("manual analysis reports analyzer failures and timeouts without crashing pi", async () => {
	const result = await run("printf 'alpha\\n'");

	const failed = await tools.get("babysit_analyze").execute(
		"test",
		{ id: result.details.id, language: "javascript", code: "throw new Error('expected analyzer failure')" },
	);
	expect(failed.isError).toBe(true);
	expect(failed.content[0]?.text).toContain("expected analyzer failure");

	const timedOut = await tools.get("babysit_analyze").execute(
		"test",
		{ id: result.details.id, language: "shell", code: "sleep 1", timeout: "10ms" },
	);
	expect(timedOut.isError).toBe(true);
	expect(timedOut.content[0]?.text).toContain("Report timed out");
});

test("an empty report remains a concise successful result", async () => {
	const result = await run("printf 'input\\n'", {
		language: "javascript",
		code: "// Deliberately no stdout.",
	});

	expect(result.isError).toBe(false);
	expect(result.content[0]?.text).toContain("(report produced no output)");
});

test("report output is bounded before it reaches the model", async () => {
	const result = await run("printf 'input\\n'", {
		language: "python",
		code: "print('x' * 20000)",
	});

	const text = result.content[0]?.text ?? "";
	expect(text).toContain("[report output truncated]");
	expect(Buffer.byteLength(text)).toBeLessThan(13_000);
});
