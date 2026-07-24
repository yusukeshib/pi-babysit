import { expect, test } from "bun:test";
import { readFileSync, rmSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { compactRpcLine } from "./rpc-stream-proxy.mjs";
import extension, {
	activeToolsWithoutDirectBash,
	buildProcessCompletionMessage,
	canRestoreNotificationAfterWait,
	clip,
	deliverProcessCompletionMessage,
	isAllowedDirectBash,
	isConfirmedTerminalState,
	isSupportedBabysitVersion,
	parseEvents,
	planSubagentSpawn,
	type ProcessCompletionNotice,
	shouldDeferCompletionNotification,
	shouldDeliverProcessCompletion,
	shouldInlineCompleteOutput,
	summarizeNotificationCommand,
	transitionWaitReservation,
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
	];
	const raw = events.map((event) => JSON.stringify(event)).join("\n");
	const compact = raw.split("\n").map(compactRpcLine).join("\n");
	expect(parseEvents(compact)).toEqual(parseEvents(raw));
	expect(parseEvents(compact)).toMatchObject({
		done: true,
		finalText: "final answer",
		turns: 1,
		tokens: 1234,
		cost: 0.25,
	});
});

test("RPC stream compaction preserves parked, resumed, and failed RPC state", () => {
	const parkedEnd = {
		type: "agent_end",
		messages: [
			{
				role: "toolResult",
				toolName: "babysit_run",
				content: [{ type: "text", text: `Process started ${"[notify-on-exit]"}` }],
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
	];
	const compare = (events: unknown[]) => {
		const raw = events.map((event) => JSON.stringify(event)).join("\n");
		const compact = raw.split("\n").map(compactRpcLine).join("\n");
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
		]),
	).toMatchObject({ done: true, waitingOnProcess: false, finalText: "finished", agentStarts: 2, agentEnds: 2 });
	expect(compare([{ type: "response", command: "prompt", success: false, error: "rejected" }])).toMatchObject({
		done: false,
		errorMsg: "rejected",
	});
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

test("completion notification eligibility excludes wait, kill, and subagent sessions", () => {
	expect(shouldDeliverProcessCompletion({ kind: "process" })).toBe(true);
	expect(shouldDeliverProcessCompletion({ kind: "process", notified: true })).toBe(false);
	expect(shouldDeliverProcessCompletion({ kind: "process", notificationPaused: true })).toBe(
		false,
	);
	expect(shouldDeliverProcessCompletion({ kind: "subagent" })).toBe(false);
	expect(shouldDeliverProcessCompletion(null)).toBe(false);
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

test("babysit_check searches a session log with bounded latest matches", async () => {
	const result = await run(
		"python3 -c \"print('\\\\n'.join(f'ERROR {i}' for i in range(205))); print('INFO ignored')\"",
	);
	const before = await tools.get("babysit_check").execute("test", {});
	const checked = await tools.get("babysit_check").execute("test", {
		id: result.details.id,
		pattern: "ERROR",
		lines: 500,
	});
	const after = await tools.get("babysit_check").execute("test", {});
	const text = checked.content[0]?.text ?? "";
	const matches = text.split("\n").filter((line: string) => /^\d+:ERROR /.test(line));

	expect(checked.isError).not.toBe(true);
	expect(after.details.sessions.map((session: { id: string }) => session.id)).toEqual(
		before.details.sessions.map((session: { id: string }) => session.id),
	);
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
	expect(Buffer.byteLength(checkedText)).toBeLessThanOrEqual(8_000);
});
