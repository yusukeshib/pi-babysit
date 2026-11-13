import { expect, test } from "bun:test";
import { createRpcEventRestorer, createRpcLogCompactor } from "./rpc-stream-format.mjs";

type Event = Record<string, any>;

function compactEvents(events: Event[], mode: "compact" | "standard" = "compact"): string[] {
	const compactor = createRpcLogCompactor({ mode });
	const lines = events.flatMap((event) => compactor.push(JSON.stringify(event)));
	lines.push(...compactor.end());
	return lines;
}

function restore(lines: string[]): Event[] {
	const restorer = createRpcEventRestorer();
	const events = lines.flatMap((line) => restorer.push(JSON.parse(line)));
	events.push(...restorer.end());
	return events;
}

const user = { role: "user", content: "Review this", timestamp: 1 };
const output = "file contents\n".repeat(200);
const assistantWithCall = {
	role: "assistant",
	content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } }],
	stopReason: "toolUse",
	usage: { totalTokens: 10 },
	timestamp: 2,
};
const readResult = {
	role: "toolResult",
	toolCallId: "call-1",
	toolName: "read",
	content: [{ type: "text", text: output }],
	details: { lines: 200 },
	isError: false,
	timestamp: 3,
};
const finalAssistant = {
	role: "assistant",
	content: [{ type: "text", text: "Looks good." }],
	stopReason: "stop",
	usage: { totalTokens: 20 },
	timestamp: 4,
};

/** A run shaped like pi-agent-core's agent loop. */
function sequentialRun(): Event[] {
	return [
		{ type: "agent_start" },
		{ type: "turn_start" },
		{ type: "message_start", message: user },
		{ type: "message_end", message: user },
		{ type: "message_start", message: { ...assistantWithCall, content: [] } },
		{ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 } },
		{ type: "message_end", message: assistantWithCall },
		{ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "a.txt" } },
		{
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "read",
			result: { content: readResult.content, details: readResult.details },
			isError: false,
			durationMs: 5,
		},
		{ type: "message_start", message: readResult },
		{ type: "message_end", message: readResult },
		{ type: "turn_end", message: assistantWithCall, toolResults: [readResult] },
		{ type: "turn_start" },
		{ type: "message_start", message: { ...finalAssistant, content: [] } },
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Looks good." } },
		{ type: "message_end", message: finalAssistant },
		{ type: "turn_end", message: finalAssistant, toolResults: [] },
		{ type: "agent_end", messages: [user, assistantWithCall, readResult, finalAssistant] },
		{ type: "agent_settled" },
	];
}

test("compact log starts with a header and records each tool output once", () => {
	const events = sequentialRun();
	const lines = compactEvents(events);
	expect(JSON.parse(lines[0]!)).toEqual({ type: "pi_babysit_stream", version: 1, profile: "compact" });
	const log = lines.join("\n");
	expect(log.split("file contents").length - 1).toBe(200);
	expect(Buffer.byteLength(log)).toBeLessThan(Buffer.byteLength(events.map((e) => JSON.stringify(e)).join("\n")) / 3);
	const parsed = lines.map((line) => JSON.parse(line));
	expect(parsed.find((e) => e.type === "agent_end")).toEqual({ type: "agent_end" });
	expect(parsed.filter((e) => e.type === "turn_end")).toEqual([{ type: "turn_end" }, { type: "turn_end" }]);
	expect(parsed.find((e) => e.type === "tool_execution_end").result).toEqual({});
	expect(parsed.find((e) => e.type === "message_start" && e.message.role === "toolResult").message).toEqual({
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		isError: false,
		timestamp: 3,
	});
	// Fields are omitted, never reshaped: every standard event keeps its type.
	expect(parsed.filter((e) => !String(e.type).startsWith("pi_babysit_")).map((e) => e.type)).toEqual(
		events.map((e) => e.type),
	);
	expect(parsed.at(-3)).toEqual({ type: "pi_babysit_agent_end", parked: false });
});

test("restorer reproduces the original standard events exactly", () => {
	const events = sequentialRun();
	expect(restore(compactEvents(events))).toEqual(events);
});

test("standard profile records Pi's events unchanged", () => {
	const events = sequentialRun();
	const lines = compactEvents(events, "standard");
	expect(JSON.parse(lines[0]!)).toEqual({ type: "pi_babysit_stream", version: 1, profile: "standard" });
	expect(lines.slice(1)).toEqual(events.map((event) => JSON.stringify(event)));
	expect(restore(lines)).toEqual(events);
});

test("parallel tool results are restored with each tool_execution_end before its message", () => {
	const second = { ...readResult, toolCallId: "call-2", content: [{ type: "text", text: "second" }], details: undefined };
	const calls = {
		...assistantWithCall,
		content: [...assistantWithCall.content, { type: "toolCall", id: "call-2", name: "read", arguments: {} }],
	};
	const end = (message: Event) => ({
		type: "tool_execution_end",
		toolCallId: message.toolCallId,
		toolName: "read",
		result: { content: message.content, details: message.details },
		isError: false,
	});
	const events: Event[] = [
		{ type: "agent_start" },
		{ type: "turn_start" },
		{ type: "message_end", message: calls },
		end(readResult),
		end(second),
		{ type: "message_start", message: readResult },
		{ type: "message_end", message: readResult },
		{ type: "message_start", message: second },
		{ type: "message_end", message: second },
		{ type: "turn_end", message: calls, toolResults: [readResult, second] },
		{ type: "agent_end", messages: [calls, readResult, second] },
	];
	const restored = restore(compactEvents(events));
	const roundTrip = JSON.parse(JSON.stringify(events));
	expect(restored).toHaveLength(roundTrip.length);
	expect(restored).toEqual(expect.arrayContaining(roundTrip));
	expect(restored.slice(3, 6).map((e) => e.type)).toEqual(["tool_execution_end", "message_start", "message_end"]);
	expect(restored[3].toolCallId).toBe("call-1");
	expect(restored[6].toolCallId).toBe("call-2");
});

test("tool results that differ from their message are preserved by a correction event", () => {
	const events: Event[] = [
		{ type: "agent_start" },
		{ type: "turn_start" },
		{ type: "message_end", message: assistantWithCall },
		// An untyped tool may omit content; the toolResult message normalizes it to [].
		{ type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: { terminate: true }, isError: false },
		{ type: "message_start", message: { ...readResult, content: [], details: undefined } },
		// An extension rewrote the message at message_end.
		{ type: "message_end", message: { ...readResult, content: [{ type: "text", text: "rewritten" }], details: undefined } },
		{ type: "agent_end", messages: [] },
	];
	const lines = compactEvents(events);
	const parsed = lines.map((line) => JSON.parse(line));
	expect(parsed).toContainEqual({ type: "pi_babysit_tool_execution_result", toolCallId: "call-1", result: {} });
	// The start differs from the end, so it is kept whole.
	expect(parsed.find((e) => e.type === "message_start").message.content).toEqual([]);
	// agent_end.messages differs from the derived run, so it is kept.
	expect(parsed.find((e) => e.type === "agent_end")).toEqual({ type: "agent_end", messages: [] });
	expect(restore(lines)).toEqual(JSON.parse(JSON.stringify(events)));
});

test("tool results without a toolResult message are flushed before agent_end", () => {
	const events: Event[] = [
		{ type: "agent_start" },
		{ type: "tool_execution_end", toolCallId: "lost", toolName: "bash", result: { content: [{ type: "text", text: "x" }] }, isError: false },
		{ type: "agent_end", messages: [] },
	];
	expect(restore(compactEvents(events))).toEqual(events);
});

test("agent_end from a run failure keeps its messages", () => {
	const failure = { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: "boom" };
	const events: Event[] = [
		{ type: "agent_start" },
		{ type: "turn_start" },
		{ type: "message_start", message: user },
		{ type: "message_end", message: user },
		{ type: "message_start", message: failure },
		{ type: "message_end", message: failure },
		{ type: "turn_end", message: failure, toolResults: [] },
		{ type: "agent_end", messages: [failure] },
	];
	const parsed = compactEvents(events).map((line) => JSON.parse(line));
	expect(parsed.find((e) => e.type === "agent_end")).toEqual({ type: "agent_end", messages: [failure] });
	expect(parsed.find((e) => e.type === "turn_end")).toEqual({ type: "turn_end" });
	expect(restore(compactEvents(events))).toEqual(events);
});

test("a held message_start is released whole when another line follows it", () => {
	const lines = (() => {
		const compactor = createRpcLogCompactor();
		return [
			...compactor.push(JSON.stringify({ type: "message_start", message: user })),
			...compactor.push(JSON.stringify({ type: "response", command: "get_state", success: true })),
			...compactor.push(JSON.stringify({ type: "message_end", message: user })),
			...compactor.end(),
		];
	})();
	expect(lines.slice(1).map((line) => JSON.parse(line))).toEqual([
		{ type: "message_start", message: user },
		{ type: "response", command: "get_state", success: true },
		{ type: "message_end", message: user },
	]);
});

test("restorer passes through logs without a compact header", () => {
	const legacy = [{ type: "agent_end", piBabysitParked: false }, { type: "message_start", message: { role: "user" } }];
	expect(restore(legacy.map((event) => JSON.stringify(event)))).toEqual(legacy);
});
