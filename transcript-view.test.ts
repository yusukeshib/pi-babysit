import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPiRuntime } from "./pi-runtime.mjs";
import { createRpcLogCompactor } from "./rpc-stream-format.mjs";
import { applyAssistantDelta, createTranscriptView } from "./transcript-view.mjs";
import { createLogReader, parseArgs, resolveLogPath } from "./view.mjs";

const runtime = await loadPiRuntime();
runtime.agent.initTheme(undefined, false);
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

function render(events: Record<string, unknown>[], setup?: (view: any) => void) {
	const view = createTranscriptView({ runtime, tui: { requestRender() {} }, cwd: "/repo" });
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
