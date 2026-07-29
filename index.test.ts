import { expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { compactRpcLine } from "./rpc-stream-proxy.mjs";
import { isParked as selfReaperIsParked } from "./self-reap.ts";
import { discoverAgents } from "./agents.ts";
import extension, {
	activeToolsWithoutDirectBash,
	automaticNotificationGroup,
	buildProcessCompletionMessage,
	buildSubagentDoneResult,
	buildSubagentExitDiagnostic,
	canRestoreNotificationAfterWait,
	claimFileOnce,
	clip,
	clipMultiWaitResult,
	deliverProcessCompletionMessage,
	gcBabysitRoots,
	isAllowedDirectBash,
	isConfirmedTerminalState,
	isNotificationGroupReady,
	isSupportedBabysitVersion,
	parseEvents,
	parseRpcResponseBytes,
	planSubagentSpawn,
	pruneTerminalSessionCache,
	readLogBytesFrom,
	resolveSubagentSendMode,
	rpcResponsePattern,
	type ProcessCompletionNotice,
	shouldDeferCompletionNotification,
	shouldDeliverProcessCompletion,
	shouldDeliverSubagentCompletion,
	shouldInlineCompleteOutput,
	shouldKeepPolling,
	shouldKeepPollingAfterList,
	subagentBudgetAction,
	subagentBudgetSoftViolation,
	subagentBudgetViolation,
	subagentGuidance,
	summarizeNotificationCommand,
	transitionWaitReservation,
	usageFromProgress,
	validateKillResponse,
} from "./index.ts";

const tools = new Map<string, any>();
const hooks = new Map<string, any>();
const renderers = new Map<string, any>();
let activeToolNames = ["read", "bash", "babysit_run", "write"];

extension({
	registerTool(tool: { name: string }) {
		tools.set(tool.name, tool);
	},
	on(name: string, handler: unknown) {
		hooks.set(name, handler);
	},
	registerMessageRenderer(name: string, renderer: unknown) {
		renderers.set(name, renderer);
	},
	registerCommand() {},
	sendMessage() {},
	getActiveTools() {
		return [...activeToolNames];
	},
	setActiveTools(names: string[]) {
		activeToolNames = [...names];
	},
} as any);

const ctx = { hasUI: false, cwd: process.cwd() };
const interactiveCtx = {
	hasUI: true,
	cwd: process.cwd(),
	ui: { setWidget() {} },
};
let sequence = 0;

async function run(command: string, extras: Record<string, unknown> = {}) {
	const name = `log-test-${Date.now()}-${sequence++}`;
	return tools.get("babysit_run").execute(
		name,
		{ name, command, pty: false, ...extras },
		undefined,
		undefined,
		ctx,
	) as Promise<{
		content: Array<{ text: string }>;
		details: { id: string; logPath: string; retried?: boolean };
		isError?: boolean;
	}>;
}

test("process completion messages render semantic colored labels", () => {
	const renderer = renderers.get("pi-babysit-process-end");
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		bg: (color: string, text: string) => `<bg-${color}>${text}</bg-${color}>`,
		bold: (text: string) => text,
	};
	const renderLines = (details: Record<string, unknown>) =>
		renderer({ content: "process details", details }, {}, theme).render(100) as string[];
	const render = (details: Record<string, unknown>) => renderLines(details).join("\n");

	expect(render({ status: "success", command: "npm test" })).toContain(
		"<warning>babysit_run COMMAND  npm test</warning>",
	);
	expect(render({ status: "success" })).toContain("<success>SUCCESS</success>");
	expect(render({ status: "success" })).toContain("<bg-toolSuccessBg>");
	expect(render({ status: "success" })).toContain(
		"<toolOutput>process details</toolOutput>",
	);
	expect(render({ status: "failed" })).toContain("<error>FAILED</error>");
	expect(render({ status: "terminated" })).toContain("<error>TERMINATED</error>");
	expect(render({ status: "success", count: 3 })).toContain(
		"<warning>babysit_run COMMAND  ×3</warning>",
	);
	const lines = renderLines({ status: "success" });
	expect(lines[0]).not.toContain("babysit_run");
	expect(lines.at(-1)).not.toContain("process details");
});

test("babysit_run renders a status label for quick and background results", () => {
	const tool = tools.get("babysit_run");
	const renderResult = tool.renderResult;
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		bold: (text: string) => text,
	};
	const render = (status: string, isError = false, content = "result details") =>
		renderResult(
			{ content: [{ type: "text", text: content }], details: { status } },
			{ isPartial: false },
			theme,
			{ isError },
		).render(100).join("\n");

	const commandCall = tool.renderCall(
		{ command: "bun test" },
		theme,
	).render(100).join("\n");
	const agentCall = tool.renderCall(
		{ profile: "subagent", agent: "reviewer", task: "Review the diff" },
		theme,
	).render(100).join("\n");
	const incompleteCall = tool.renderCall({}, theme).render(100).join("\n");
	const unsafeCall = tool.renderCall(
		{ command: `printf 'first\n\x1b[31msecond'${"x".repeat(300)}` },
		theme,
	).render(500).join("\n");
	expect(commandCall).toContain("<warning>babysit_run COMMAND  bun test</warning>");
	expect(agentCall).toContain(
		"<warning>babysit_run AGENT [reviewer]  Review the diff</warning>",
	);
	expect(incompleteCall).toContain("<warning>babysit_run COMMAND</warning>");
	expect(unsafeCall).toContain("first\\n\\x1B[31msecond");
	expect(unsafeCall).not.toContain("\x1b");
	expect(unsafeCall).toContain("…");
	expect(render("success")).toContain("<success>SUCCESS</success>");
	expect(render("success")).not.toContain("babysit_run SUCCESS");
	expect(render("started")).toContain("<accent>STARTED</accent>");
	expect(render("failed", true)).toContain("<error>FAILED</error>");
	expect(
		render(
			"success",
			false,
			"worker-dead: the babysit supervisor disappeared without an exit status",
		),
	).toContain("<error>TERMINATED</error>");
});

test("babysit version policy requires 0.13.0 or newer", () => {
	expect(isSupportedBabysitVersion("babysit 0.12.9")).toBe(false);
	expect(isSupportedBabysitVersion("babysit 0.13.0-beta.1")).toBe(false);
	expect(isSupportedBabysitVersion("babysit 0.13.0")).toBe(true);
	expect(isSupportedBabysitVersion("babysit 0.14.0-beta.1")).toBe(true);
	expect(isSupportedBabysitVersion("babysit 1.0.0")).toBe(true);
	expect(isSupportedBabysitVersion("unknown")).toBe(false);
});

test("compact RPC logging is the default while standard remains an opt-out", () => {
	const turnEnd = JSON.stringify({
		type: "turn_end",
		message: { role: "assistant", content: [{ type: "text", text: "large" }] },
		toolResults: [{ content: "large" }],
	});
	expect(JSON.parse(compactRpcLine(turnEnd))).toEqual({ type: "turn_end" });
	expect(compactRpcLine(turnEnd, "standard")).toBe(turnEnd);
});

test("RPC stream compaction removes only cumulative message_update snapshots", () => {
	const update = {
		type: "message_update",
		message: { role: "assistant", content: [{ type: "text", text: "growing answer" }] },
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 0,
			delta: "answer",
			partial: { type: "text", text: "growing answer" },
		},
		futureField: "preserved",
	};
	const compact = JSON.parse(compactRpcLine(JSON.stringify(update)));
	expect(compact).toEqual({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "answer" },
		futureField: "preserved",
	});

	const finalLine = '{"type":"message_end","message":{"role":"assistant"}}';
	expect(compactRpcLine(finalLine)).toBe(finalLine);
	expect(compactRpcLine("non-json diagnostic")).toBe("non-json diagnostic");
});

test("RPC response offsets exclude lifecycle events from the preceding run", () => {
	const previousEnd = `${JSON.stringify({ type: "agent_end", messages: [] })}\r\n`;
	const response = `${JSON.stringify({ type: "response", command: "prompt", success: true })}\r\n`;
	const nextRun = `${JSON.stringify({ type: "agent_start" })}\r\n`;
	const bytes = Buffer.from(previousEnd + response + nextRun);
	const since = 100;
	const parsed = parseRpcResponseBytes(bytes, since, "prompt");

	expect(parsed.ok).toBe(true);
	if (!parsed.ok) throw new Error(parsed.error);
	expect(parsed.offset).toBe(since + Buffer.byteLength(previousEnd + response));
	expect(parseEvents(nextRun)).toMatchObject({ agentStarts: 1, agentEnds: 0 });
});

test("RPC response waits for a complete top-level response record", () => {
	const pattern = new RegExp(rpcResponsePattern("steer").replace(/^\(\?m\)/, ""), "m");
	const assistantText = `${JSON.stringify({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: '\\"command\\":\\"steer\\"' }] },
	})}\n`;
	const nestedResponse = `${JSON.stringify({
		type: "event",
		details: { type: "response", command: "steer", success: true },
	})}\n`;
	const partial = JSON.stringify({ id: "rpc-123", type: "response", command: "steer", success: true });
	const complete = `${partial}\n`;
	const withoutId = `${JSON.stringify({ type: "response", command: "steer", success: true })}\n`;

	expect(pattern.test(assistantText)).toBe(false);
	expect(pattern.test(nestedResponse)).toBe(false);
	expect(pattern.test(partial)).toBe(false);
	expect(pattern.test(complete)).toBe(true);
	expect(pattern.test(withoutId)).toBe(true);
});

test("RPC response-window reads exclude historical log bytes", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-babysit-rpc-window-"));
	try {
		const file = path.join(dir, "output.log");
		const prefix = "x".repeat(1_000_000);
		const response = `${JSON.stringify({ type: "response", command: "prompt", success: false, error: "bad model" })}\n`;
		writeFileSync(file, prefix + response);

		const bytes = readLogBytesFrom(file, Buffer.byteLength(prefix));
		expect(bytes.toString("utf8")).toBe(response);
		expect(bytes.byteLength).toBe(Buffer.byteLength(response));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("terminal subagent progress cache entries are pruned while running entries remain", () => {
	const cache = new Map([
		["working", { progress: 1 }],
		["done", { progress: 2 }],
		["missing", { progress: 3 }],
	]);
	const removed = pruneTerminalSessionCache(cache, [
		{ id: "working", state: "running" },
		{ id: "done", state: "exited" },
	]);

	expect(removed).toBe(2);
	expect([...cache.keys()]).toEqual(["working"]);
});

test("RPC stream compaction preserves parseEvents final state", () => {
	const assistant = {
		role: "assistant",
		content: [{ type: "text", text: "final answer" }],
		usage: { totalTokens: 1234, cost: { total: 0.25 } },
	};
	const events = [
		{ type: "agent_start" },
		{ type: "turn_start" },
		{ type: "message_start", message: { role: "assistant", content: [] } },
		{
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "final " }] },
			assistantMessageEvent: { type: "text_delta", delta: "final ", partial: { text: "final " } },
		},
		{
			type: "message_update",
			message: assistant,
			assistantMessageEvent: { type: "text_delta", delta: "answer", partial: assistant },
		},
		{ type: "tool_execution_start", toolName: "read", args: { path: "README.md" } },
		{ type: "tool_execution_end", toolName: "read", isError: false, result: { content: [] } },
		{ type: "message_end", message: assistant },
		{ type: "agent_end", messages: [assistant] },
		{ type: "agent_settled" },
	];
	const raw = events.map((event) => JSON.stringify(event)).join("\n");
	const compact = raw.split("\n").map((line) => compactRpcLine(line, "compact")).join("\n");
	expect(parseEvents(compact)).toEqual(parseEvents(raw));
	expect(parseEvents(compact)).toMatchObject({
		done: true,
		finalText: "final answer",
		turns: 1,
		tokens: 1234,
		cost: 0.25,
	});
});

test("subagent progress accumulates usage and captures extension errors", () => {
	const events = [
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "first" }],
				usage: {
					input: 100,
					output: 20,
					cacheRead: 300,
					cacheWrite: 4,
					reasoning: 5,
					totalTokens: 420,
					cost: { input: 0.03, output: 0.06, cacheRead: 0.02, cacheWrite: 0.01, total: 0.12 },
				},
			},
		},
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "final" }],
				usage: {
					input: 50,
					output: 10,
					cacheRead: 400,
					totalTokens: 460,
					cost: { input: 0.02, output: 0.04, cacheRead: 0.02, total: 0.08 },
				},
			},
		},
		{
			type: "extension_error",
			extensionPath: "/tmp/broken-extension.ts",
			error: "stale context",
		},
	];
	const progress = parseEvents(events.map((event) => JSON.stringify(event)).join("\n"));
	expect(progress).toMatchObject({
		finalText: "final",
		tokens: 460,
		modelCalls: 2,
		usageTokens: 880,
		inputTokens: 150,
		outputTokens: 30,
		cacheReadTokens: 700,
		cacheWriteTokens: 4,
		reasoningTokens: 5,
		cost: 0.2,
		inputCost: 0.05,
		outputCost: 0.1,
		cacheReadCost: 0.04,
		cacheWriteCost: 0.01,
		errorMsg: "/tmp/broken-extension.ts: stale context",
	});
	expect(usageFromProgress(progress)).toEqual({
		input: 150,
		output: 30,
		cacheRead: 700,
		cacheWrite: 4,
		totalTokens: 880,
		cost: { input: 0.05, output: 0.1, cacheRead: 0.04, cacheWrite: 0.01, total: 0.2 },
	});
});

test("nested usage remains valid when a provider omits price components", () => {
	const progress = parseEvents(
		JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [],
				usage: { input: 10, output: 2, totalTokens: 12 },
			},
		}),
	);
	expect(usageFromProgress(progress)).toEqual({
		input: 10,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 12,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});
});

test("subagent progress bounds rendered tool history while preserving the exact count", () => {
	const progress = parseEvents(
		Array.from({ length: 250 }, (_, index) => ({
			type: "tool_execution_start",
			toolName: "read",
			args: { path: `file-${index}` },
		}))
			.map((event) => JSON.stringify(event))
			.join("\n"),
	);
	expect(progress.toolCallCount).toBe(250);
	expect(progress.toolCalls).toHaveLength(200);
	expect(progress.toolCalls[0]?.summary).toContain("file-50");
});

test("subagent budgets report the first reached limit", () => {
	const progress = parseEvents(
		[
			{ type: "turn_start" },
			{ type: "tool_execution_start", toolName: "read", args: { path: "a" } },
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [],
					usage: { totalTokens: 500, cost: { total: 0.25 } },
				},
			},
		]
			.map((event) => JSON.stringify(event))
			.join("\n"),
	);
	expect(subagentBudgetViolation(progress, { maxCost: 0.2 })).toContain("maxCost");
	expect(subagentBudgetViolation(progress, { maxTurns: 1 })).toContain("maxTurns");
	expect(subagentBudgetViolation(progress, { maxToolCalls: 1 })).toContain("maxToolCalls");
	expect(subagentBudgetViolation(progress, { maxUsageTokens: 500 })).toContain("maxUsageTokens");
	expect(subagentBudgetViolation(progress, { maxCost: 1 })).toBeNull();
	expect(subagentBudgetSoftViolation(progress, { maxCost: 0.3 })).toContain("80%");
	expect(subagentBudgetSoftViolation(progress, { maxTurns: 2 })).toBeNull();
	expect(subagentBudgetAction(progress, { maxCost: 0.2 }, undefined, 1_000, 30_000)).toMatchObject({
		action: "steer",
	});
	expect(subagentBudgetAction(progress, { maxCost: 0.2 }, 1_000, 30_999, 30_000)).toMatchObject({
		action: "none",
	});
	expect(subagentBudgetAction(progress, { maxCost: 0.2 }, 1_000, 31_000, 30_000)).toMatchObject({
		action: "kill",
	});
});

test("a completed subagent task charges nested usage to the parent exactly once", async () => {
	const events = [
		{ type: "agent_start" },
		{ type: "turn_start" },
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "accounted answer" }],
				usage: {
					input: 100,
					output: 20,
					cacheRead: 300,
					cacheWrite: 4,
					totalTokens: 424,
					cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.01, total: 0.34 },
				},
			},
		},
		{ type: "agent_end", piBabysitParked: false },
		{ type: "agent_settled" },
	].map((event) => JSON.stringify(event)).join("\n") + "\n";
	const encoded = Buffer.from(events).toString("base64");
	const processResult = await run(`printf %s '${encoded}' | base64 -d`);
	const root = path.dirname(path.dirname(path.dirname(processResult.details.logPath)));
	writeFileSync(
		path.join(root, "meta", `${processResult.details.id}.json`),
		JSON.stringify({ kind: "subagent", task: "accounting test", promptOffset: 0 }),
	);

	const [first, second] = await Promise.all([
		tools.get("babysit_wait").execute("usage-first", { id: processResult.details.id }),
		tools.get("babysit_wait").execute("usage-second", { id: processResult.details.id }),
	]);
	const charged = [first.usage, second.usage].filter(Boolean);
	expect(charged).toEqual([{
		input: 100,
		output: 20,
		cacheRead: 300,
		cacheWrite: 4,
		totalTokens: 424,
		cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.01, total: 0.34 },
	}]);
	const repeated = await tools.get("babysit_wait").execute("usage-repeated", {
		id: processResult.details.id,
	});
	expect(repeated.usage).toBeUndefined();
});

test("multi-wait output defaults to an 8 KB context cap", () => {
	const clipped = clipMultiWaitResult("界".repeat(10_000));
	expect(Buffer.byteLength(clipped, "utf8")).toBeLessThanOrEqual(8_000);
	expect(clipped).toContain("bytes elided");
	expect(Buffer.byteLength(clipMultiWaitResult("x".repeat(30_000), 24_000), "utf8")).toBeLessThanOrEqual(24_000);
});

test("completed subagents surface extension errors alongside final text", () => {
	const progress = parseEvents(
		[
			{
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "useful final" }] },
			},
			{ type: "extension_error", extensionPath: "broken.ts", error: "hook failed" },
		]
			.map((event) => JSON.stringify(event))
			.join("\n"),
	);
	const completed = buildSubagentDoneResult(progress);
	expect(completed.ok).toBe(false);
	expect(completed.body).toContain("broken.ts: hook failed");
	expect(completed.body).toContain("useful final");
});

test("subagent progress captures provider failures reported after prompt acceptance", () => {
	const progress = parseEvents(
		JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage: "No API key found for provider",
			},
		}),
	);
	expect(progress.errorMsg).toContain("No API key");
	expect(progress.modelCalls).toBe(0);
});

test("subagent exit diagnostics never include raw RPC tails", () => {
	const progress = parseEvents(
		JSON.stringify({
			type: "extension_error",
			extensionPath: "broken.ts",
			error: "provider hook failed",
		}),
	);
	const diagnostic = buildSubagentExitDiagnostic(progress, "/tmp/subagent/output.log");
	expect(diagnostic).toContain("broken.ts: provider hook failed");
	expect(diagnostic).toContain("Full log: /tmp/subagent/output.log");
	expect(diagnostic).not.toContain('"type":"message_update"');
});

test("killed subagents preserve their partially streamed final answer", () => {
	const progress = parseEvents(
		[
			{
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "Earlier status note" }] },
			},
			{ type: "turn_start" },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "## Findings\n" } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Useful partial review" } },
		]
			.map((event) => JSON.stringify(event))
			.join("\n"),
	);
	const diagnostic = buildSubagentExitDiagnostic(progress, "/tmp/subagent/output.log");
	expect(diagnostic).toContain("## Findings\nUseful partial review");
	expect(diagnostic).not.toContain("Earlier status note");
	expect(diagnostic).not.toContain("no structured error");
});

test("compact RPC mode removes redundant lifecycle and successful tool payloads", () => {
	const messages = [{ role: "assistant", content: [{ type: "text", text: "x".repeat(10_000) }] }];
	const cases = [
		{
			event: { type: "message_start", message: messages[0] },
			assert: (value: any) => expect(value.message).toEqual({ role: "assistant" }),
		},
		{
			event: { type: "turn_end", message: messages[0], toolResults: messages },
			assert: (value: any) => expect(value).toEqual({ type: "turn_end" }),
		},
		{
			event: { type: "agent_end", messages },
			assert: (value: any) => expect(value).toEqual({ type: "agent_end", piBabysitParked: false }),
		},
		{
			event: { type: "tool_execution_end", toolName: "read", isError: false, result: messages[0] },
			assert: (value: any) =>
				expect(value).toEqual({ type: "tool_execution_end", toolName: "read", isError: false }),
		},
	];
	for (const { event, assert } of cases) {
		const line = JSON.stringify(event);
		assert(JSON.parse(compactRpcLine(line, "compact")));
		expect(compactRpcLine(line, "standard")).toBe(line);
	}
	const failedTool = JSON.stringify({
		type: "tool_execution_end",
		isError: true,
		result: { content: "diagnostic" },
	});
	expect(compactRpcLine(failedTool, "compact")).toBe(failedTool);
	const parked = JSON.parse(
		compactRpcLine(
			JSON.stringify({
				type: "agent_end",
				messages: [
					{
						role: "toolResult",
						toolName: "babysit_run",
						content: "Process started (id: build). [notify-on-exit]\nLog: /tmp/output.log",
						details: { kind: "process", status: "started" },
					},
					{ role: "toolResult", toolName: "babysit_run", content: "quick command" },
				],
			}),
			"compact",
		),
	);
	expect(parked.piBabysitParked).toBe(true);
	const spoofed = JSON.parse(
		compactRpcLine(
			JSON.stringify({
				type: "agent_end",
				messages: [
					{ role: "toolResult", toolName: "babysit_run", content: "command printed [notify-on-exit]" },
				],
			}),
			"compact",
		),
	);
	expect(spoofed.piBabysitParked).toBe(false);
});

test("self-reaper parked detection cannot be spoofed by command output", () => {
	expect(
		selfReaperIsParked([
			{
				role: "toolResult",
				toolName: "babysit_run",
				content: "Process started (id: build). [notify-on-exit]\nLog: /tmp/output.log",
				details: { kind: "process", status: "started" },
			},
		]),
	).toBe(true);
	expect(
		selfReaperIsParked([
			{ role: "toolResult", toolName: "babysit_run", content: "command printed [notify-on-exit]" },
		]),
	).toBe(false);
});

test("RPC stream compaction preserves parked, resumed, and failed RPC state", () => {
	const parkedEnd = {
		type: "agent_end",
		messages: [
			{
				role: "toolResult",
				toolName: "babysit_run",
				content: [
					{
						type: "text",
						text: "Process started (id: build). [notify-on-exit]\nLog: /tmp/output.log",
					},
				],
				details: { kind: "process", status: "started" },
			},
		],
	};
	const parkedEvents = [
		{ type: "agent_start" },
		{
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "waiting" }] },
			assistantMessageEvent: { type: "text_delta", delta: "waiting", partial: { text: "waiting" } },
		},
		parkedEnd,
		{ type: "agent_settled" },
	];
	const compare = (events: unknown[]) => {
		const raw = events.map((event) => JSON.stringify(event)).join("\n");
		const compact = raw.split("\n").map((line) => compactRpcLine(line, "compact")).join("\n");
		expect(parseEvents(compact)).toEqual(parseEvents(raw));
		return parseEvents(compact);
	};

	expect(compare(parkedEvents)).toMatchObject({ done: false, waitingOnProcess: true });
	expect(
		compare([
			...parkedEvents,
			{ type: "agent_start" },
			{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "finished" }] } },
			{ type: "agent_end", messages: [{ role: "assistant" }] },
			{ type: "agent_settled" },
		]),
	).toMatchObject({ done: true, waitingOnProcess: false, finalText: "finished", agentStarts: 2, agentEnds: 2 });
	expect(compare([{ type: "response", command: "prompt", success: false, error: "rejected" }])).toMatchObject({
		done: false,
		errorMsg: "rejected",
	});

	// agent_end is only a low-level run boundary; retries and continuations may follow.
	expect(compare([{ type: "agent_start" }, { type: "agent_end", messages: [] }])).toMatchObject({
		done: false,
		agentSettled: 0,
	});

	// A model note after the process-start result must not defeat parked detection.
	expect(
		compare([
			{ type: "agent_start" },
			{
				type: "agent_end",
				messages: [
					...parkedEnd.messages,
					{ role: "assistant", content: [{ type: "text", text: "Started; awaiting completion." }] },
				],
			},
			{ type: "agent_settled" },
		]),
	).toMatchObject({ done: false, waitingOnProcess: true });
});

test("RPC stream compaction makes cumulative updates approximately linear", () => {
	const lines = Array.from({ length: 200 }, (_, index) =>
		JSON.stringify({
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "x".repeat((index + 1) * 100) }] },
			assistantMessageEvent: {
				type: "text_delta",
				delta: "x".repeat(100),
				partial: { type: "text", text: "x".repeat((index + 1) * 100) },
			},
		}),
	);
	const rawBytes = Buffer.byteLength(lines.join("\n"));
	const compactBytes = Buffer.byteLength(lines.map(compactRpcLine).join("\n"));
	expect(compactBytes).toBeLessThan(rawBytes / 20);
});

test("RPC stream proxy forwards multiple and unterminated records", () => {
	const update = JSON.stringify({
		type: "message_update",
		message: { role: "assistant", content: [{ type: "text", text: "héllo" }] },
		assistantMessageEvent: { type: "text_delta", delta: "héllo", partial: { text: "héllo" } },
	});
	const final = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [] } });
	const result = spawnSync(
		process.execPath,
		[path.join(process.cwd(), "rpc-stream-proxy.mjs"), "--", process.execPath, "-e", "process.stdin.pipe(process.stdout)"],
		{ input: `${update}\n${final}`, encoding: "utf8" },
	);
	expect(result.status).toBe(0);
	const lines = result.stdout.trim().split("\n");
	expect(JSON.parse(lines[0]!)).toEqual({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "héllo" },
	});
	expect(lines[1]).toBe(final);
});

test("RPC stream proxy compact mode preserves parser state end-to-end", () => {
	const assistant = {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		usage: { input: 10, output: 2, cacheRead: 30, totalTokens: 42, cost: { total: 0.01 } },
	};
	const events = [
		{ type: "agent_start" },
		{ type: "turn_start" },
		{ type: "message_start", message: assistant },
		{ type: "tool_execution_end", toolName: "read", isError: false, result: { content: "large".repeat(100) } },
		{ type: "message_end", message: assistant },
		{ type: "turn_end", message: assistant, toolResults: [{ content: "large".repeat(100) }] },
		{ type: "agent_end", messages: [assistant] },
		{ type: "agent_settled" },
	];
	const input = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
	const result = spawnSync(
		process.execPath,
		[path.join(process.cwd(), "rpc-stream-proxy.mjs"), "--", process.execPath, "-e", "process.stdin.pipe(process.stdout)"],
		{
			input,
			encoding: "utf8",
			env: { ...process.env, PI_BABYSIT_RPC_LOG_MODE: "compact" },
		},
	);
	expect(result.status).toBe(0);
	expect(Buffer.byteLength(result.stdout)).toBeLessThan(Buffer.byteLength(input));
	expect(parseEvents(result.stdout)).toEqual(parseEvents(input));
});

test("RPC stream proxy preserves an early child's exit status during EPIPE", () => {
	const result = spawnSync(
		process.execPath,
		[path.join(process.cwd(), "rpc-stream-proxy.mjs"), "--", process.execPath, "-e", "process.exit(7)"],
		{ input: "x".repeat(2_000_000), encoding: "utf8" },
	);
	expect(result.status).toBe(7);
	expect(result.stderr).not.toContain("EPIPE");
});

test("RPC stream proxy flushes final output before mirroring a child signal", () => {
	const payload = JSON.stringify({ type: "message_end", data: "x".repeat(200_000) });
	const childScript = [
		`const payload = ${JSON.stringify(payload)};`,
		"process.stdout.write(payload, () => process.kill(process.pid, 'SIGTERM'));",
	].join("\n");
	const result = spawnSync(
		process.execPath,
		[path.join(process.cwd(), "rpc-stream-proxy.mjs"), "--", process.execPath, "-e", childScript],
		{ encoding: "utf8", maxBuffer: 1_000_000 },
	);
	expect(result.signal).toBe("SIGTERM");
	expect(result.stdout).toBe(payload);
});

test("compact RPC deltas remain visible without duplicate final text", () => {
	const events = [
		{ type: "turn_start" },
		{ type: "message_start", message: { role: "assistant", content: [] } },
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello " } },
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world" } },
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "hello world" }],
				usage: { totalTokens: 42, cost: { total: 0.01 } },
			},
		},
	];
	const result = spawnSync(process.execPath, [path.join(process.cwd(), "format-stream.mjs")], {
		input: `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
		encoding: "utf8",
	});
	const plain = result.stdout.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "");
	expect(result.status).toBe(0);
	expect(plain.match(/hello world/g)).toHaveLength(1);
	expect(plain).toContain("[usage] 42 tok · $0.0100");
});

test("agent discovery accepts YAML tool arrays and skips invalid definitions", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-babysit-agents-"));
	const dir = path.join(root, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	try {
		writeFileSync(
			path.join(dir, "array.md"),
			"---\nname: array-agent\ndescription: array tools\ntools: [read, grep]\nmodel: test-model\n---\nArray prompt\n",
		);
		writeFileSync(
			path.join(dir, "csv.md"),
			"---\nname: csv-agent\ndescription: csv tools\ntools: read, write\n---\nCSV prompt\n",
		);
		writeFileSync(
			path.join(dir, "invalid.md"),
			"---\nname: [not, a, string]\ndescription: ignored\n---\nInvalid\n",
		);

		const { agents } = discoverAgents(root, "project");
		expect(agents.map((agent) => agent.name).sort()).toEqual(["array-agent", "csv-agent"]);
		expect(agents.find((agent) => agent.name === "array-agent")?.tools).toEqual(["read", "grep"]);
		expect(agents.find((agent) => agent.name === "csv-agent")?.tools).toEqual(["read", "write"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("subagent guidance reflects shell availability and inherited depth", () => {
	const bounded = subagentGuidance(1, 1, false);
	expect(bounded).toContain("Direct bash is unavailable");
	expect(bounded).toContain("depth limit (1/1)");
	expect(bounded).toContain("do not attempt to spawn another subagent");

	const nested = subagentGuidance(1, 2, true);
	expect(nested).toContain("Direct bash is available");
	expect(nested).toContain("depth is 1/2");
	expect(nested).toContain("maxDepth 2");

	const noShell = subagentGuidance(1, 1, false, false);
	expect(noShell).toContain("No shell execution tool is available");
});

test("subagent nesting defaults to one level and requires top-level opt-in", () => {
	expect(planSubagentSpawn(0, {}).allowed).toBe(false);
	expect(
		planSubagentSpawn(undefined, {
			PI_BABYSIT_INTERNAL_SUBAGENT_DEPTH: "invalid",
		}).allowed,
	).toBe(false);
	expect(planSubagentSpawn(undefined, {})).toEqual({
		allowed: true,
		childDepth: 1,
		maxDepth: 1,
	});

	const denied = planSubagentSpawn(undefined, {
		PI_BABYSIT_INTERNAL_SUBAGENT_DEPTH: "1",
		PI_BABYSIT_INTERNAL_SUBAGENT_MAX_DEPTH: "1",
	});
	expect(denied.allowed).toBe(false);
	if (!denied.allowed) expect(denied.error).toContain("disabled at depth 1");

	const optedIn = planSubagentSpawn(2, {});
	expect(optedIn).toEqual({ allowed: true, childDepth: 1, maxDepth: 2 });
	const inherited = planSubagentSpawn(undefined, {
		PI_BABYSIT_INTERNAL_SUBAGENT_DEPTH: "1",
		PI_BABYSIT_INTERNAL_SUBAGENT_MAX_DEPTH: "2",
	});
	expect(inherited).toEqual({ allowed: true, childDepth: 2, maxDepth: 2 });
	const inheritedCeiling = planSubagentSpawn(undefined, {
		PI_BABYSIT_INTERNAL_SUBAGENT_DEPTH: "2",
		PI_BABYSIT_INTERNAL_SUBAGENT_MAX_DEPTH: "2",
	});
	expect(inheritedCeiling.allowed).toBe(false);
	if (!inheritedCeiling.allowed) {
		expect(inheritedCeiling.error).toContain("disabled at depth 2");
	}

	const selfGranted = planSubagentSpawn(3, {
		PI_BABYSIT_INTERNAL_SUBAGENT_DEPTH: "1",
		PI_BABYSIT_INTERNAL_SUBAGENT_MAX_DEPTH: "2",
	});
	expect(selfGranted.allowed).toBe(false);
	if (!selfGranted.allowed) expect(selfGranted.error).toContain("cannot override");
});

test("subagent depth limit blocks profile mode but leaves process mode available", async () => {
	const depthKey = "PI_BABYSIT_INTERNAL_SUBAGENT_DEPTH";
	const maxDepthKey = "PI_BABYSIT_INTERNAL_SUBAGENT_MAX_DEPTH";
	const previousDepth = process.env[depthKey];
	const previousMaxDepth = process.env[maxDepthKey];
	process.env[depthKey] = "1";
	process.env[maxDepthKey] = "1";
	try {
		const denied = await tools.get("babysit_run").execute(
			"test",
			{ profile: "subagent", task: "must not start" },
			undefined,
			undefined,
			ctx,
		);
		expect(denied.isError).toBe(true);
		expect(denied.content[0]?.text).toContain("disabled at depth 1");

		const processResult = await run("printf 'process-at-depth-limit\\n'");
		expect(processResult.isError).toBe(false);
		expect(processResult.content[0]?.text).toContain("process-at-depth-limit");
	} finally {
		if (previousDepth === undefined) delete process.env[depthKey];
		else process.env[depthKey] = previousDepth;
		if (previousMaxDepth === undefined) delete process.env[maxDepthKey];
		else process.env[maxDepthKey] = previousMaxDepth;
	}
});

test("new subagent tasks require a confirmed settled worker", () => {
	expect(resolveSubagentSendMode("auto", true, false)).toEqual({ mode: "steer" });
	expect(resolveSubagentSendMode("auto", undefined, undefined)).toEqual({ mode: "steer" });
	expect(resolveSubagentSendMode("auto", false, false)).toEqual({ mode: "steer" });
	expect(resolveSubagentSendMode("auto", false, true)).toEqual({ mode: "task" });
	expect(resolveSubagentSendMode("steer", undefined, undefined)).toEqual({ mode: "steer" });
	expect(resolveSubagentSendMode("task", true, false)).toEqual({ error: "busy" });
	expect(resolveSubagentSendMode("task", undefined, undefined)).toEqual({ error: "unknown" });
	expect(resolveSubagentSendMode("task", false, false)).toEqual({ error: "unsettled" });
	expect(resolveSubagentSendMode("task", false, true)).toEqual({ mode: "task" });
});

test("exclusive claim files elect exactly one caller across processes", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-babysit-claim-"));
	const marker = path.join(dir, "usage.claimed");
	try {
		const modulePath = path.join(process.cwd(), "index.ts");
		const script =
			`import { claimFileOnce } from ${JSON.stringify(modulePath)};` +
			`process.exit(claimFileOnce(${JSON.stringify(marker)}, String(process.pid)) ? 0 : 1);`;
		const children = Array.from({ length: 8 }, () =>
			Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "pipe" }),
		);
		const statuses = await Promise.all(children.map((child) => child.exited));
		expect(statuses.filter((status) => status === 0)).toHaveLength(1);
		expect(claimFileOnce(marker, "late")).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("mode-specific notification and budget parameters reject misuse", async () => {
	const processBudget = await tools.get("babysit_run").execute(
		"process-budget",
		{ command: "true", maxCost: 1 },
		undefined,
		undefined,
		ctx,
	);
	expect(processBudget.isError).toBe(true);
	expect(processBudget.content[0]?.text).toContain("require profile 'subagent'");

	const subagentGroup = await tools.get("babysit_run").execute(
		"subagent-group",
		{ profile: "subagent", task: "do nothing", notificationGroup: "checks" },
		undefined,
		undefined,
		ctx,
	);
	expect(subagentGroup.isError).toBe(true);
	expect(subagentGroup.content[0]?.text).toContain("process mode");

	const subagentContinueAfter = await tools.get("babysit_run").execute(
		"subagent-continue-after",
		{ profile: "subagent", task: "do nothing", continueAfterStart: true },
		undefined,
		undefined,
		ctx,
	);
	expect(subagentContinueAfter.isError).toBe(true);
	expect(subagentContinueAfter.content[0]?.text).toContain("process mode");

	const conflictingProcessModes = await tools.get("babysit_run").execute(
		"foreground-continue",
		{ command: "true", foreground: true, continueAfterStart: true },
		undefined,
		undefined,
		ctx,
	);
	expect(conflictingProcessModes.isError).toBe(true);
	expect(conflictingProcessModes.content[0]?.text).toContain("mutually exclusive");
});

test("long subagent messages fail before spawn when the read tool is unavailable", async () => {
	const depthKey = "PI_BABYSIT_INTERNAL_SUBAGENT_DEPTH";
	const maxDepthKey = "PI_BABYSIT_INTERNAL_SUBAGENT_MAX_DEPTH";
	const previousDepth = process.env[depthKey];
	const previousMaxDepth = process.env[maxDepthKey];
	delete process.env[depthKey];
	delete process.env[maxDepthKey];
	try {
		const result = await tools.get("babysit_run").execute(
			"long-task-no-read",
			{ profile: "subagent", task: "x".repeat(601), tools: ["grep"] },
			undefined,
			undefined,
			ctx,
		);
		const text = result.content[0]?.text ?? "";
		expect(result.isError).toBe(true);
		expect(text).toContain("allowlist excludes `read`");
	} finally {
		if (previousDepth === undefined) delete process.env[depthKey];
		else process.env[depthKey] = previousDepth;
		if (previousMaxDepth === undefined) delete process.env[maxDepthKey];
		else process.env[maxDepthKey] = previousMaxDepth;
	}
});

test("multi-wait rejects duplicates and excessive fan-out before spawning waits", async () => {
	const duplicate = await tools.get("babysit_wait").execute(
		"duplicate-wait",
		{ ids: ["same", "same"] },
		undefined,
		undefined,
		ctx,
	);
	expect(duplicate.isError).toBe(true);
	expect(duplicate.content[0]?.text).toContain("unique");

	const excessive = await tools.get("babysit_wait").execute(
		"excessive-wait",
		{ ids: Array.from({ length: 33 }, (_, index) => `job-${index}`) },
		undefined,
		undefined,
		ctx,
	);
	expect(excessive.isError).toBe(true);
	expect(excessive.content[0]?.text).toContain("at most 32");
});

test("invalid wait durations fail instead of becoming infinite waits", async () => {
	await expect(
		tools.get("babysit_wait").execute(
			"invalid-wait-timeout",
			{ id: "does-not-matter", timeout: "5minutes" },
			undefined,
			undefined,
			ctx,
		),
	).rejects.toThrow("Invalid timeout");
});

test("kill confirmation validates both backend acknowledgement and terminal state", () => {
	expect(validateKillResponse('{"killed":true}')).toBeNull();
	expect(validateKillResponse('{"killed":true,"confirmed":true}')).toBeNull();
	expect(validateKillResponse('{"killed":false}')).toContain("not confirmed");
	expect(validateKillResponse('{"killed":true,"confirmed":false}')).toContain("not confirmed");
	expect(validateKillResponse("not-json")).toContain("Invalid kill response");
	expect(isConfirmedTerminalState("killed")).toBe(true);
	expect(isConfirmedTerminalState("exited")).toBe(true);
	expect(isConfirmedTerminalState("running")).toBe(false);
	expect(isConfirmedTerminalState("dead")).toBe(false);
});

test("clip enforces the complete byte limit at zero, exact, and overflow boundaries", () => {
	expect(clip("abc", 0)).toBe("");
	expect(clip("abc", 3)).toBe("abc");
	expect(Buffer.byteLength(clip("abcd", 3))).toBeLessThanOrEqual(3);
	expect(clip("x".repeat(8_000), 8_000)).toHaveLength(8_000);
	const overflow = clip(`始${"x".repeat(8_000)}終`, 8_000);
	expect(Buffer.byteLength(overflow)).toBeLessThanOrEqual(8_000);
	expect(overflow).toContain("bytes elided");
	expect(overflow).not.toContain("�");
});

test("completion notification payload policies are UTF-8 safe and bounded", () => {
	expect(summarizeNotificationCommand("printf 'a  b'\n\t&& printf 'c'")).toBe(
		"printf 'a  b'\\n\\t&& printf 'c'",
	);
	expect(summarizeNotificationCommand("before\x1b[31m\x00after")).toBe(
		"before\\x1B[31m\\x00after",
	);
	for (const command of ["x".repeat(2_000), `a${"界".repeat(2_000)}`]) {
		const preview = summarizeNotificationCommand(command);
		expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(240);
		expect(preview).toEndWith("…");
		expect(preview).not.toContain("�");
	}
	expect(shouldInlineCompleteOutput(0, 0)).toBe(false);
	expect(shouldInlineCompleteOutput(1_999, 2_000)).toBe(true);
	expect(shouldInlineCompleteOutput(2_000, 2_000)).toBe(true);
	expect(shouldInlineCompleteOutput(2_001, 2_000)).toBe(false);
	expect(canRestoreNotificationAfterWait({ notified: true })).toBe(true);
	expect(
		canRestoreNotificationAfterWait({
			notified: true,
			killNotificationSuppressed: true,
		}),
	).toBe(false);
});

test("concurrent waits keep automatic notification reserved until every owner exits", () => {
	let state = transitionWaitReservation({}, "reserve");
	state = transitionWaitReservation(state, "reserve");
	expect(state).toMatchObject({ notified: true, waitReservations: 2 });

	state = transitionWaitReservation(state, "abandon");
	expect(state).toMatchObject({ notified: true, waitReservations: 1 });
	state = transitionWaitReservation(state, "claim");
	expect(state).toMatchObject({
		notified: true,
		waitReservations: 0,
		waitCompletionClaimed: true,
	});

	let timedOut = transitionWaitReservation({}, "reserve");
	timedOut = transitionWaitReservation(timedOut, "reserve");
	timedOut = transitionWaitReservation(timedOut, "abandon");
	timedOut = transitionWaitReservation(timedOut, "abandon");
	expect(timedOut).toMatchObject({ notified: false, waitReservations: 0 });
});

const completionNotice = (
	id: string,
	overrides: Partial<ProcessCompletionNotice> = {},
): ProcessCompletionNotice => ({
	id,
	exitCode: 0,
	success: true,
	status: "success",
	runtime: "3s",
	summary: `Process "${id}" completed successfully after 3s.`,
	command: `echo ${id}`,
	logPath: `/tmp/${id}/output.log`,
	output: `\n\nOutput:\n${id}-output`,
	...overrides,
});

test("completion notifications wait until the agent is idle", () => {
	expect(shouldDeferCompletionNotification(false)).toBe(true);
	expect(shouldDeferCompletionNotification(true)).toBe(false);
});

test("idle polling stops unless a worker or completion still needs attention", () => {
	const metadata = new Map([
		["pending", { kind: "process" as const, notified: false }],
		["done", { kind: "process" as const, notified: true }],
		["subagent-ready", { kind: "subagent" as const, promptOffset: 42 }],
		[
			"subagent-collected",
			{ kind: "subagent" as const, promptOffset: 42, subagentCollectedOffset: 42 },
		],
	]);
	const metaFor = (id: string) => metadata.get(id) ?? null;

	expect(shouldKeepPolling([], metaFor)).toBe(false);
	expect(shouldKeepPolling([{ id: "worker", state: "running" }], metaFor)).toBe(true);
	expect(shouldKeepPolling([{ id: "pending", state: "exited" }], metaFor)).toBe(true);
	expect(shouldKeepPolling([{ id: "done", state: "exited" }], metaFor)).toBe(false);
	expect(shouldKeepPolling([{ id: "subagent-ready", state: "killed" }], metaFor)).toBe(true);
	expect(shouldKeepPolling([{ id: "subagent-collected", state: "killed" }], metaFor)).toBe(false);
	expect(shouldKeepPollingAfterList({ sessions: [], error: "temporary failure" }, metaFor)).toBe(
		true,
	);
});

test("parallel background runs inherit one automatic notification group", () => {
	const entry = {
		type: "message",
		id: "abcd1234",
		message: {
			role: "assistant",
			content: [
				{ type: "toolCall", name: "babysit_run", arguments: { command: "npm test" } },
				{ type: "toolCall", name: "babysit_run", arguments: { command: "npm run lint" } },
				{ type: "toolCall", name: "read", arguments: { path: "README.md" } },
			],
		},
	};
	expect(automaticNotificationGroup(entry)).toBe("turn-abcd1234");
	(entry.message.content[0] as any).arguments.notificationGroup = "turn-abcd1234";
	expect(automaticNotificationGroup(entry)).toBe("turn-abcd1234");
	(entry.message.content[1] as any).arguments.foreground = true;
	expect(automaticNotificationGroup(entry)).toBeUndefined();
	(entry.message.content[1] as any).arguments.foreground = false;
	(entry.message.content[1] as any).arguments.notificationGroup = "explicit";
	expect(automaticNotificationGroup(entry)).toBeUndefined();
});

test("notification groups wait for every running member", () => {
	const metadata = new Map([
		["build", { kind: "process" as const, notificationGroup: "checks" }],
		["test", { kind: "process" as const, notificationGroup: "checks" }],
		["other", { kind: "process" as const, notificationGroup: "other" }],
	]);
	const metaFor = (id: string) => metadata.get(id) ?? null;
	const sessions = [
		{ id: "build", state: "exited" },
		{ id: "test", state: "running" },
		{ id: "other", state: "running" },
	] as any[];
	expect(isNotificationGroupReady(metadata.get("build")!, sessions, metaFor)).toBe(false);
	sessions[1]!.state = "exited";
	expect(isNotificationGroupReady(metadata.get("build")!, sessions, metaFor)).toBe(true);
	expect(isNotificationGroupReady({ kind: "process" } as any, sessions, metaFor)).toBe(true);
});

test("completion notification eligibility separates process exits and uncollected subagent tasks", () => {
	expect(shouldDeliverProcessCompletion({ kind: "process" })).toBe(true);
	expect(shouldDeliverProcessCompletion({ kind: "process", notified: true })).toBe(false);
	expect(shouldDeliverProcessCompletion({ kind: "process", notificationPaused: true })).toBe(
		false,
	);
	expect(shouldDeliverProcessCompletion({ kind: "subagent" })).toBe(false);
	expect(shouldDeliverProcessCompletion(null)).toBe(false);

	expect(shouldDeliverSubagentCompletion({ kind: "subagent", promptOffset: 7 })).toBe(true);
	expect(
		shouldDeliverSubagentCompletion({
			kind: "subagent",
			promptOffset: 7,
			subagentCollectedOffset: 7,
		}),
	).toBe(false);
	expect(
		shouldDeliverSubagentCompletion({
			kind: "subagent",
			promptOffset: 7,
			subagentNotifiedOffset: 7,
		}),
	).toBe(false);
	// Metadata written by pre-reminder releases already proves an explicit wait
	// returned both the answer and nested usage; do not notify those old tasks.
	expect(
		shouldDeliverSubagentCompletion({
			kind: "subagent",
			promptOffset: 7,
			usageReportedOffset: 7,
		}),
	).toBe(false);
	expect(shouldDeliverSubagentCompletion({ kind: "process" })).toBe(false);
});

test("GC removes only old roots without live supervisors", () => {
	const rootBase = mkdtempSync(path.join(os.tmpdir(), "pi-babysit-gc-"));
	const currentRoot = path.join(rootBase, "current");
	mkdirSync(currentRoot, { recursive: true });
	const now = Date.now();
	const createRoot = (
		name: string,
		state: string,
		supervisorPid: number,
		ageDays: number,
		childPid?: number,
	) => {
		const root = path.join(rootBase, name);
		const session = path.join(root, "sessions", "job");
		mkdirSync(session, { recursive: true });
		writeFileSync(path.join(session, "status.json"), JSON.stringify({ state, child_pid: childPid }));
		writeFileSync(path.join(session, "meta.json"), JSON.stringify({ babysit_pid: supervisorPid }));
		writeFileSync(path.join(session, "output.log"), "payload");
		const at = new Date(now - ageDays * 86_400_000);
		for (const target of [
			path.join(session, "status.json"),
			path.join(session, "meta.json"),
			path.join(session, "output.log"),
			session,
			path.dirname(session),
			root,
		]) {
			utimesSync(target, at, at);
		}
		return root;
	};
	const old = createRoot("old", "exited", 0, 30);
	createRoot("stale-running", "running", 99_999_999, 30);
	const locked = createRoot("locked", "exited", 0, 30);
	writeFileSync(path.join(locked, ".pi-babysit-gc.lock"), "busy");
	createRoot("live", "running", process.pid, 30);
	createRoot("child-live", "running", 99_999_999, 30, process.pid);
	const leased = createRoot("leased", "exited", 0, 30);
	writeFileSync(
		path.join(leased, `.pi-babysit-active-${process.pid}-test.json`),
		JSON.stringify({ pid: process.pid }),
	);
	createRoot("fresh", "exited", 0, 1);
	createRoot("unknown-state", "mystery", 0, 30);
	try {
		const preview = gcBabysitRoots({
			rootBase,
			currentRoot,
			olderThanMs: 14 * 86_400_000,
			dryRun: true,
			now,
		});
		expect(preview.candidates.sort()).toEqual(["locked", "old", "stale-running"]);
		expect(preview.skippedLive.sort()).toEqual([
			"child-live",
			"leased",
			"live",
			"unknown-state",
		]);
		expect(readFileSync(path.join(old, "sessions", "job", "output.log"), "utf8")).toBe("payload");
		const removed = gcBabysitRoots({
			rootBase,
			currentRoot,
			olderThanMs: 14 * 86_400_000,
			dryRun: false,
			now,
		});
		expect(removed.deleted.sort()).toEqual(["old", "stale-running"]);
		expect(readFileSync(path.join(locked, "sessions", "job", "output.log"), "utf8")).toBe("payload");
		expect(() => readFileSync(path.join(old, "sessions", "job", "output.log"), "utf8")).toThrow();
		expect(readFileSync(path.join(rootBase, "live", "sessions", "job", "output.log"), "utf8")).toBe("payload");
		expect(readdirSync(rootBase).some((name) => name.startsWith(".pi-babysit-gc-"))).toBe(false);
	} finally {
		rmSync(rootBase, { recursive: true, force: true });
	}
});

test("a single completion preserves the existing notification shape", () => {
	const message = buildProcessCompletionMessage([completionNotice("build")]);

	expect(message.content).not.toContain("processes completed:");
	expect(message.content).toContain("build-output");
	expect(message.details.id).toBe("build");
	expect(message.details.runtime).toBe("3s");
	expect(message.details.logPath).toBe("/tmp/build/output.log");
});

test("completion notifications aggregate all exits from one poll", () => {
	const message = buildProcessCompletionMessage([
		completionNotice("build"),
		completionNotice("test"),
	]);

	expect(message.content).toContain("2 processes completed:");
	expect(message.content).toContain('Process "build" completed successfully');
	expect(message.content).toContain('Process "test" completed successfully');
	expect(message.details.count).toBe(2);
	expect(message.details.processes.map(({ id }) => id)).toEqual(["build", "test"]);
	expect(message.details.status).toBe("success");
	expect(message.details.success).toBe(true);
});

test("completion batches report mixed outcomes and keep every log path when output is omitted", () => {
	const notices = [
		completionNotice("build", { output: `\n\nOutput:\n${"界".repeat(500)}` }),
		completionNotice("test", {
			exitCode: 1,
			success: false,
			status: "failed",
			summary: 'Process "test" exited with code 1 after 3s.',
			output: `\n\nOutput:\n${"x".repeat(500)}`,
		}),
	];
	const message = buildProcessCompletionMessage(notices, 700);

	expect(Buffer.byteLength(message.content)).toBeLessThanOrEqual(700);
	expect(message.content).not.toContain("�");
	expect(message.content).toContain("/tmp/build/output.log");
	expect(message.content).toContain("/tmp/test/output.log");
	expect(message.content).toContain("Output omitted from aggregate notification");
	expect(message.details.status).toBe("failed");
	expect(message.details.success).toBe(false);
});

test("oversized batches defer and leave later completions unacknowledged", () => {
	const notices = Array.from({ length: 100 }, (_, i) =>
		completionNotice(`process-${String(i).padStart(3, "0")}`),
	);
	const message = buildProcessCompletionMessage(notices);

	expect(Buffer.byteLength(message.content)).toBeLessThanOrEqual(8_000);
	expect(message.details.count).toBeGreaterThan(0);
	expect(message.details.count).toBeLessThan(notices.length);
	expect(message.details.totalCount).toBe(notices.length);
	expect(message.details.remainingCount).toBe(notices.length - message.details.count);
	expect(message.content).toContain("deferred to the next poll");

	const acknowledged: string[] = [];
	const sent = deliverProcessCompletionMessage(
		notices,
		() => {},
		(notice) => acknowledged.push(notice.id),
	);
	expect(sent).toBe(true);
	expect(acknowledged).toEqual(message.details.processes.map(({ id }) => id));
});

test("completion batch acknowledgement happens only after one successful send", () => {
	const notices = [completionNotice("build"), completionNotice("test")];
	const acknowledged: string[] = [];
	let sends = 0;
	const failed = deliverProcessCompletionMessage(
		notices,
		() => {
			sends++;
			throw new Error("pi is temporarily unavailable");
		},
		(notice) => acknowledged.push(notice.id),
	);
	expect(failed).toBe(false);
	expect(sends).toBe(1);
	expect(acknowledged).toEqual([]);

	const retried = deliverProcessCompletionMessage(
		notices,
		(message, options) => {
			sends++;
			expect(message.details.count).toBe(2);
			expect(options).toEqual({ triggerTurn: true, deliverAs: "steer" });
		},
		(notice) => acknowledged.push(notice.id),
	);
	expect(retried).toBe(true);
	expect(sends).toBe(2);
	expect(acknowledged).toEqual(["build", "test"]);
});

test("babysit_kill returns success only after terminal state is persisted", async () => {
	const binary = process.env.PI_BABYSIT_CLI ?? "babysit";
	const root = process.env.PI_BABYSIT_DIR ?? path.join(os.homedir(), ".pi-babysit");
	const started = spawnSync(
		binary,
		["run", "-d", "--json", "--no-tty", "--", "sh", "-c", "sleep 60"],
		{ encoding: "utf8", env: { ...process.env, BABYSIT_DIR: root } },
	);
	expect(started.status).toBe(0);
	const id = JSON.parse(started.stdout).id as string;
	try {
		const result = await tools.get("babysit_kill").execute(
			"test",
			{ id },
			undefined,
			undefined,
			ctx,
		);
		expect(result.isError).not.toBe(true);
		expect(result.content[0]?.text).toContain("confirmed");
		expect(["killed", "exited"]).toContain(result.details.status);

		const checked = spawnSync(binary, ["status", "-s", id, "--json"], {
			encoding: "utf8",
			env: { ...process.env, BABYSIT_DIR: root },
		});
		expect(checked.status).toBe(0);
		const status = JSON.parse(checked.stdout).status;
		expect(["killed", "exited"]).toContain(status.state);
		expect(status.child_pid).toBeNull();
	} finally {
		spawnSync(binary, ["kill", "-s", id, "--json"], {
			stdio: "ignore",
			env: { ...process.env, BABYSIT_DIR: root },
		});
		rmSync(path.join(root, "sessions", id), { recursive: true, force: true });
		rmSync(path.join(root, "meta", `${id}.json`), { force: true });
	}
});

test("direct bash policy only supports the explicit escape hatch", () => {
	for (const command of [
		"pwd",
		"git status --short",
		"tail -n 50 /tmp/build.log",
		"rg -n 'error' /tmp/build.log | head -n 80",
		"wc -l /tmp/build.log",
	]) {
		expect(isAllowedDirectBash(command)).toBe(false);
	}
	const previous = process.env.PI_BABYSIT_ALLOW_BASH;
	process.env.PI_BABYSIT_ALLOW_BASH = "1";
	expect(isAllowedDirectBash("anything")).toBe(true);
	if (previous === undefined) delete process.env.PI_BABYSIT_ALLOW_BASH;
	else process.env.PI_BABYSIT_ALLOW_BASH = previous;
});

test("built-in bash is removed from the active tool set unless explicitly allowed", async () => {
	const active = ["read", "bash", "babysit_run", "write"];
	expect(activeToolsWithoutDirectBash(active, false)).toEqual([
		"read",
		"babysit_run",
		"write",
	]);
	expect(activeToolsWithoutDirectBash(active, true)).toEqual(active);

	activeToolNames = [...active];
	await hooks.get("session_start")(
		{},
		{
			hasUI: false,
			cwd: process.cwd(),
			isIdle: () => true,
			sessionManager: { getSessionId: () => "active-tools-test" },
		},
	);
	expect(activeToolNames).toEqual(["read", "babysit_run", "write"]);
	await hooks.get("session_shutdown")();
});

test("tool hook applies automatic groups to sibling background runs", async () => {
	const hook = hooks.get("tool_call");
	const calls: Array<{
		type: string;
		name: string;
		arguments: { command: string; notificationGroup?: string };
	}> = [
		{ type: "toolCall", name: "babysit_run", arguments: { command: "npm test" } },
		{ type: "toolCall", name: "babysit_run", arguments: { command: "npm run lint" } },
	];
	const entry = {
		type: "message",
		id: "facefeed",
		message: { role: "assistant", content: calls },
	};
	await hook(
		{ toolName: "babysit_run", input: calls[0]!.arguments },
		{ sessionManager: { getLeafEntry: () => entry } },
	);
	await hook(
		{ toolName: "babysit_run", input: calls[1]!.arguments },
		{ sessionManager: { getLeafEntry: () => entry } },
	);
	expect(calls[0]!.arguments.notificationGroup).toBe("turn-facefeed");
	expect(calls[1]!.arguments.notificationGroup).toBe("turn-facefeed");
});

test("tool hook redirects every shell command to babysit_run if bash is re-enabled", async () => {
	const hook = hooks.get("tool_call");
	for (const command of ["ls -la", "git diff", "pwd", "tail -n 40 /tmp/build.log"]) {
		const blocked = await hook({ toolName: "bash", input: { command } });
		expect(blocked.block).toBe(true);
		expect(blocked.reason).toContain("babysit_run");
		expect(blocked.reason).toContain(command);
	}
});

test("small process output is returned with metadata and a log path", async () => {
	const result = await run("printf '\\160\\162\\151\\166\\141\\164\\145\\055\\157\\165\\164\\160\\165\\164\\055\\154\\151\\156\\145\\012'");
	const text = result.content[0]?.text ?? "";

	expect(result.isError).toBe(false);
	expect(text).toContain("completed successfully");
	expect(text).toContain(`Log: ${result.details.logPath}`);
	expect(text).toContain("private-output-line");
	expect(readFileSync(result.details.logPath, "utf8")).toContain("private-output-line");
});

test("foreground process mode returns a long command result in one tool call", async () => {
	const name = `foreground-test-${Date.now()}-${sequence++}`;
	const started = Date.now();
	const result = await tools.get("babysit_run").execute(
		name,
		{
			name,
			command: "sleep 2.2; printf 'foreground-done\\n'",
			pty: false,
			foreground: true,
			timeout: "10s",
		},
		undefined,
		undefined,
		interactiveCtx,
	);
	const text = result.content[0]?.text ?? "";
	expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
	expect(result.isError).not.toBe(true);
	expect(result.details.status).toBe("success");
	expect(text).toContain("completed successfully");
	expect(text).toContain("foreground-done");
	expect(text).not.toContain("[notify-on-exit]");
});

test("parallel foreground processes never report a running child as terminated", async () => {
	const prefix = `parallel-foreground-${Date.now()}-${sequence++}`;
	const results = await Promise.all(
		Array.from({ length: 4 }, (_, index) =>
			tools.get("babysit_run").execute(
				`${prefix}-${index}`,
				{
					name: `${prefix}-${index}`,
					command: `sleep 0.${index + 2}; printf 'parallel-${index}-done\\n'`,
					pty: false,
					foreground: true,
					timeout: "10s",
				},
				undefined,
				undefined,
				interactiveCtx,
			),
		),
	);

	for (const [index, result] of results.entries()) {
		const text = result.content[0]?.text ?? "";
		expect(result.isError).not.toBe(true);
		expect(result.details.status).toBe("success");
		expect(text).toContain(`parallel-${index}-done`);
		expect(text).not.toContain("exited with code ?");
	}
});

test("foreground mode filters noisy output without a second check turn", async () => {
	const name = `foreground-filter-${Date.now()}-${sequence++}`;
	const result = await tools.get("babysit_run").execute(
		name,
		{
			name,
			command: "python3 -c \"print('noise\\n' * 5000); print('IMPORTANT final')\"",
			pty: false,
			foreground: true,
			returnPattern: "IMPORTANT",
			returnLines: 5,
			maxBytes: 1_500,
		},
		undefined,
		undefined,
		interactiveCtx,
	);
	const text = result.content[0]?.text ?? "";
	expect(result.isError).not.toBe(true);
	expect(text).toContain("IMPORTANT final");
	expect(text.split("Selected output").at(-1)).not.toContain("noise");
	expect(Buffer.byteLength(text)).toBeLessThan(2_000);

	const invalid = await tools.get("babysit_run").execute(
		"invalid-filter",
		{ name: "invalid-filter", command: "printf never", foreground: true, returnPattern: "[" },
		undefined,
		undefined,
		interactiveCtx,
	);
	expect(invalid.isError).toBe(true);
	expect(invalid.content[0]?.text).toContain("Invalid returnPattern");
});

test("foreground mode lets the supervisor own the absolute timeout boundary", async () => {
	const name = `foreground-timeout-${Date.now()}-${sequence++}`;
	const result = await tools.get("babysit_run").execute(
		name,
		{
			name,
			command: "sleep 10",
			pty: false,
			foreground: true,
			timeout: "1s",
		},
		undefined,
		undefined,
		interactiveCtx,
	);
	const text = result.content[0]?.text ?? "";
	expect(result.isError).toBe(true);
	expect(result.details.status).not.toBe("running");
	expect(text).not.toContain("wait timed out");
	expect(text).toContain(`Log: ${result.details.logPath}`);
});

test("parallel sessions requesting one name receive unique stable ids", async () => {
	const name = `parallel-name-${Date.now()}-${sequence++}`;
	const [first, second] = await Promise.all([
		run("sleep 0.1", { name }),
		run("sleep 0.1", { name }),
	]);
	expect(new Set([first.details.id, second.details.id]).size).toBe(2);
	expect([first.details.id, second.details.id].sort()).toEqual([name, `${name}-2`].sort());
});

test("babysit_check searches a session log with bounded latest matches", async () => {
	const result = await run(
		"python3 -c \"print('\\\\n'.join(f'ERROR {i}' for i in range(205))); print('INFO ignored')\"",
	);
	const before = await tools.get("babysit_check").execute("test", {});
	const checked = await tools.get("babysit_check").execute("test", {
		id: result.details.id,
		pattern: "ERROR",
		lines: 500,
		maxBytes: 24_000,
	});
	const after = await tools.get("babysit_check").execute("test", {});
	const allSessions = await tools.get("babysit_check").execute("test", { state: "all" });
	const noSubagents = await tools.get("babysit_check").execute("test", {
		state: "all",
		kind: "subagent",
	});
	const text = checked.content[0]?.text ?? "";
	const matches = text.split("\n").filter((line: string) => /^\d+:ERROR /.test(line));

	expect(checked.isError).not.toBe(true);
	expect(after.details.sessions.map((session: { id: string }) => session.id)).toEqual(
		before.details.sessions.map((session: { id: string }) => session.id),
	);
	expect(after.details.sessions.some((session: { id: string }) => session.id === result.details.id)).toBe(false);
	expect(allSessions.details.sessions.some((session: { id: string }) => session.id === result.details.id)).toBe(true);
	expect(allSessions.content[0]?.text).toContain(result.details.id);
	expect(noSubagents.content[0]?.text).toContain('kind: "all"');
	expect(noSubagents.content[0]?.text).not.toContain('state: "all" to widen');
	expect(matches).toHaveLength(200);
	expect(matches[0]).toEndWith("ERROR 5");
	expect(matches.at(-1)).toEndWith("ERROR 204");
	expect(text).not.toContain("INFO ignored");

	const invalid = await tools.get("babysit_check").execute("test", {
		id: result.details.id,
		pattern: "[",
	});
	expect(invalid.isError).toBe(true);
	expect(invalid.content[0]?.text).toContain("Invalid pattern");

	const missing = await tools.get("babysit_check").execute("test", {
		id: "definitely-not-a-session",
		pattern: "ERROR",
	});
	expect(missing.isError).toBe(true);
	expect(missing.content[0]?.text).toContain("No such session");

	unlinkSync(result.details.logPath);
	const missingLog = await tools.get("babysit_check").execute("test", {
		id: result.details.id,
		pattern: "ERROR",
	});
	expect(missingLog.isError).toBe(true);
	expect(missingLog.content[0]?.text).toContain("Log file is missing");
});


test("failed commands persist their error bit through Pi's tool_result hook", async () => {
	const result = await run("printf '\\146\\141\\151\\154\\055\\144\\145\\164\\141\\151\\154\\012' >&2; exit 7");
	const text = result.content[0]?.text ?? "";
	const patch = await hooks.get("tool_result")({
		toolCallId: result.details.id,
		toolName: "babysit_run",
		content: result.content,
		details: result.details,
		isError: false,
	});

	expect(result.isError).toBe(true);
	expect(patch).toEqual({ isError: true });
	expect(text).toContain("exited with code 7");
	expect(text).toContain("fail-detail");
	expect(readFileSync(result.details.logPath, "utf8")).toContain("fail-detail");
});

test("unexpected worker loss is diagnosed without replaying by default", async () => {
	const marker = `/tmp/pi-babysit-no-retry-${process.pid}-${Date.now()}`;
	const result = await run(`printf x >> ${marker}; kill -9 $PPID; sleep 1`);
	const text = result.content[0]?.text ?? "";

	expect(result.isError).toBe(true);
	expect(result.details.retried).toBe(false);
	expect(text).toContain("worker-dead");
	expect(text).toContain("supervisor disappeared without recording an exit");
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
	expect(Buffer.byteLength(checkedText)).toBeLessThanOrEqual(4_000);
	const tighter = await tools.get("babysit_check").execute("test", {
		id: result.details.id,
		lines: 2,
		maxBytes: 1_500,
	});
	expect(Buffer.byteLength(tighter.content[0]?.text ?? "")).toBeLessThanOrEqual(1_500);
});

test("process checks bound huge command metadata without crowding out recent output", async () => {
	const result = await run(`printf '${"x".repeat(20_000)}' >/dev/null; printf 'CHECK-TAIL-MARKER\\n'`);
	const checked = await tools.get("babysit_check").execute("test", {
		id: result.details.id,
		lines: 2,
	});
	const text = checked.content[0]?.text ?? "";

	expect(checked.isError).not.toBe(true);
	expect(text).toContain("CHECK-TAIL-MARKER");
	expect(text).toContain("command:");
	expect(Buffer.byteLength(text)).toBeLessThan(1_000);
});
