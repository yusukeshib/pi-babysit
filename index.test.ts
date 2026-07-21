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

async function run(command: string) {
	return tools.get("babysit_run").execute(
		"test",
		{ name: `log-test-${Date.now()}-${sequence++}`, command, pty: false },
		undefined,
		undefined,
		ctx,
	) as Promise<{
		content: Array<{ text: string }>;
		details: { id: string; logPath: string };
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
