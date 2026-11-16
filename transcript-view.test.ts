import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPiRuntime } from "./pi-runtime.mjs";
import { createRpcLogCompactor } from "./rpc-stream-format.mjs";
import { loadPiEnvironment } from "./pi-environment.mjs";
import { applyAssistantDelta, createTranscriptView, defaultRenderContext } from "./transcript-view.mjs";
import { createLogReader, createViewerInputListener, parseArgs, resolveLogPath } from "./view.mjs";

const runtime = await loadPiRuntime();
runtime.agent.initTheme(undefined, false);
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

function render(events: Record<string, unknown>[], setup?: (view: any) => void, context?: any) {
	const view = createTranscriptView({ runtime, tui: { requestRender() {} }, cwd: "/repo", render: context });
	setup?.(view);
	const compactor = createRpcLogCompactor();
	const lines = events.flatMap((event) => compactor.push(JSON.stringify(event)));
	lines.push(...compactor.end());
	const reader = createLogReader((event: Record<string, unknown>) => view.apply(event));
	reader.push(`${lines.join("\r\n")}\r\n`);
	reader.end();
	return { view, text: () => stripAnsi(view.container.render(100).join("\n")) };
}

const toolCall = { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo hi" } };
const assistantCall = { role: "assistant", content: [toolCall], stopReason: "toolUse", timestamp: 2 };
const result = { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "hi-output" }], isError: false, timestamp: 3 };
const final = { role: "assistant", content: [{ type: "text", text: "All **done**." }], stopReason: "stop", timestamp: 4 };

function run() {
	return [
		{ type: "agent_start" },
		{ type: "turn_start" },
		{ type: "message_start", message: { role: "user", content: "Say hi", timestamp: 1 } },
		{ type: "message_end", message: { role: "user", content: "Say hi", timestamp: 1 } },
		{ type: "message_start", message: { ...assistantCall, content: [] } },
		{ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "bash" } },
		{ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall } },
		{ type: "message_end", message: assistantCall },
		{ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: toolCall.arguments },
		{ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: { content: result.content }, isError: false },
		{ type: "message_start", message: result },
		{ type: "message_end", message: result },
		{ type: "turn_end", message: assistantCall, toolResults: [result] },
		{ type: "turn_start" },
		{ type: "message_start", message: { ...final, content: [] } },
		{ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "All **do" } },
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ne**." } },
		{ type: "message_end", message: final },
		{ type: "agent_end", messages: [] },
		{ type: "agent_settled" },
	];
}

test("a compact subagent log renders with Pi's components", () => {
	const { text } = render(run());
	const out = text();
	expect(out).toContain("Say hi");
	expect(out).toContain("echo hi");
	expect(out).toContain("hi-output");
	expect(out).toContain("All done.");
	expect(out).not.toContain("**");
	expect(out.indexOf("Say hi")).toBeLessThan(out.indexOf("echo hi"));
	expect(out.indexOf("hi-output")).toBeLessThan(out.indexOf("All done."));
});

test.each([
	["tools", "\x1b[111;5:1u", "\x1b[111;5:2u", "\x1b[111;5:3u", "\x0f"],
	["thinking", "\x1b[116;1:1u", "\x1b[116;1:2u", "\x1b[116;1:3u", "t"],
])("viewer %s toggles persist after release and ignore key repeats", (_name, press, repeat, release, legacy) => {
	const output = Array.from({ length: 40 }, (_, i) => `tool-output-${i}`).join("\n");
	const { view, text } = render([
		...run(),
		{ type: "message_end", message: { ...final, content: [{ type: "thinking", thinking: "private reasoning" }] } },
		{ type: "tool_execution_start", toolCallId: "long", toolName: "bash", args: { command: "long-output" } },
		{ type: "tool_execution_end", toolCallId: "long", result: { content: [{ type: "text", text: output }] }, isError: false },
	]);
	let changes = 0;
	const listener = createViewerInputListener({
		tui: runtime.tui,
		getView: () => view,
		quit() { throw new Error("unexpected quit"); },
		onChange() { changes++; },
	});
	const before = text();
	expect(listener(press)).toEqual({ consume: true });
	const toggled = text();
	expect(toggled).not.toBe(before);
	for (const data of [repeat, repeat, release]) {
		expect(listener(data)).toEqual({ consume: true });
		expect(text()).toBe(toggled);
	}
	expect(changes).toBe(1);
	listener(press);
	listener(release);
	expect(text()).toBe(before);
	expect(changes).toBe(2);
	listener(legacy);
	expect(text()).toBe(toggled);
	listener(legacy);
	expect(text()).toBe(before);
});

test("viewer ignores quit releases, repeats, and unrelated input", () => {
	let quits = 0;
	let changes = 0;
	const listener = createViewerInputListener({
		tui: runtime.tui,
		getView() { throw new Error("unexpected view access"); },
		quit() { quits++; },
		onChange() { changes++; },
	});
	for (const data of ["\x1b[113;1:3u", "\x1b[99;5:3u", "\x1b[113;1:2u", "x"]) listener(data);
	expect(quits).toBe(0);
	expect(changes).toBe(0);
	for (const data of ["\x1b[113;1:1u", "\x1b[99;5:1u", "q", "\x03"]) listener(data);
	expect(quits).toBe(4);
	expect(changes).toBe(4);
});

test("streaming deltas are visible before message_end", () => {
	const events = run();
	const cut = events.findIndex((event: any) => event.assistantMessageEvent?.delta === "ne**.");
	const { text } = render(events.slice(0, cut + 1));
	expect(text()).toContain("All done.");
});

test("an aborted run marks its pending tool as failed", () => {
	const aborted = { ...assistantCall, stopReason: "aborted", errorMessage: "Operation aborted" };
	const { text } = render([
		{ type: "agent_start" },
		{ type: "message_start", message: { ...aborted, content: [] } },
		{ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "bash" } },
		{ type: "message_end", message: aborted },
		{ type: "agent_end", messages: [] },
	]);
	expect(text()).toContain("Operation aborted");
});

test("delta reconstruction follows Pi's content-block contract", () => {
	const message: any = { role: "assistant", content: [] };
	applyAssistantDelta(message, { type: "thinking_start", contentIndex: 0 });
	applyAssistantDelta(message, { type: "thinking_delta", contentIndex: 0, delta: "hm" });
	applyAssistantDelta(message, { type: "text_delta", contentIndex: 1, delta: "a" });
	applyAssistantDelta(message, { type: "text_end", contentIndex: 1, content: "ab" });
	applyAssistantDelta(message, { type: "toolcall_start", contentIndex: 2, id: "x", toolName: "read" });
	expect(message.content).toEqual([
		{ type: "thinking", thinking: "hm" },
		{ type: "text", text: "ab" },
		{ type: "toolCall", id: "x", name: "read", arguments: {} },
	]);
});

test("viewer resolves session ids to the newest log and parses options", () => {
	const base = mkdtempSync(path.join(os.tmpdir(), "pi-babysit-view-"));
	try {
		for (const [root, mtime] of [["old", 1_000], ["new", 2_000]] as const) {
			const dir = path.join(base, root, "sessions", "worker");
			mkdirSync(dir, { recursive: true });
			const log = path.join(dir, "output.log");
			writeFileSync(log, "");
			require("node:fs").utimesSync(log, mtime, mtime);
		}
		expect(resolveLogPath("worker", base)).toBe(path.join(base, "new", "sessions", "worker", "output.log"));
		expect(resolveLogPath(path.join(base, "old", "sessions", "worker"), base)).toBe(
			path.join(base, "old", "sessions", "worker", "output.log"),
		);
		expect(() => resolveLogPath("missing", base)).toThrow("No babysit session log");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
	expect(parseArgs(["w", "--print", "--cwd", "/x"])).toEqual({ target: "w", print: true, cwd: "/x" });
});

test("extension tool and message renderers from the render context are used", () => {
	const { Text } = runtime.tui;
	const base = defaultRenderContext(runtime);
	const context = {
		...base,
		getToolDefinition: (name: string) =>
			name === "demo_tool"
				? { name, renderCall: () => new Text("DEMO-CALL", 0, 0), renderResult: () => new Text("DEMO-RESULT", 0, 0) }
				: base.getToolDefinition(name),
		getMessageRenderer: (type: string) => (type === "demo-note" ? () => new Text("DEMO-NOTE", 0, 0) : undefined),
	};
	const call = { type: "toolCall", id: "call-9", name: "demo_tool", arguments: { secret: "raw-arg" } };
	const assistant = { role: "assistant", content: [call], stopReason: "toolUse", timestamp: 2 };
	const note = { role: "custom", customType: "demo-note", content: "raw-note", display: true, timestamp: 5 };
	const { text } = render(
		[
			{ type: "agent_start" },
			{ type: "message_start", message: assistant },
			{ type: "message_end", message: assistant },
			{ type: "tool_execution_start", toolCallId: "call-9", toolName: "demo_tool", args: call.arguments },
			{
				type: "tool_execution_end",
				toolCallId: "call-9",
				toolName: "demo_tool",
				result: { content: [{ type: "text", text: "raw-result" }] },
				isError: false,
			},
			{ type: "message_start", message: note },
			{ type: "message_end", message: note },
			{ type: "agent_end", messages: [] },
		],
		undefined,
		context,
	);
	const out = text();
	expect(out).toContain("DEMO-CALL");
	expect(out).toContain("DEMO-RESULT");
	expect(out).toContain("DEMO-NOTE");
	expect(out).not.toContain("raw-arg");
	expect(out).not.toContain("raw-note");
});

test("the Pi environment registers settings themes and extension tools without installing packages", async () => {
	const base = mkdtempSync(path.join(os.tmpdir(), "pi-babysit-env-"));
	try {
		const agentDir = path.join(base, "agent");
		const cwd = path.join(base, "work");
		mkdirSync(path.join(agentDir, "theme-resources"), { recursive: true });
		mkdirSync(cwd, { recursive: true });
		const darkTheme = JSON.parse(
			require("node:fs").readFileSync(
				path.join(runtime.packageDir, "dist", "modes", "interactive", "theme", "dark.json"),
				"utf8",
			),
		);
		writeFileSync(
			path.join(agentDir, "theme-resources", "fixture.json"),
			JSON.stringify({ ...darkTheme, name: "fixture-theme" }),
		);
		writeFileSync(
			path.join(agentDir, "ext.ts"),
			`export default function (pi) {
				pi.registerTool({
					name: "fixture_tool",
					label: "Fixture",
					description: "fixture",
					parameters: { type: "object", properties: {} },
					async execute() { return { content: [] }; },
					renderCall() { return undefined; },
				});
			}\n`,
		);
		writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify({
				theme: "fixture-theme",
				themes: ["theme-resources/fixture.json"],
				extensions: ["ext.ts"],
				packages: ["npm:@pi-babysit-fixture/not-installed@0.0.0"],
				outputPad: 0,
			}),
		);
		const environment = await loadPiEnvironment(runtime, { cwd, agentDir });
		expect(environment.themes.map((theme: any) => theme.name)).toContain("fixture-theme");
		expect(typeof environment.render.getToolDefinition("fixture_tool")?.renderCall).toBe("function");
		expect(typeof environment.render.getToolDefinition("bash")?.renderCall).toBe("function");
		expect(environment.render.outputPad).toBe(0);
		expect(require("node:fs").existsSync(path.join(agentDir, "npm", "node_modules", "@pi-babysit-fixture"))).toBe(false);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});
