import { expect, test } from "bun:test";
import { readFileSync, rmSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import extension, {
	buildProcessCompletionMessage,
	canRestoreNotificationAfterWait,
	deliverProcessCompletionMessage,
	isAllowedDirectBash,
	isConfirmedTerminalState,
	isSupportedBabysitVersion,
	type ProcessCompletionNotice,
	shouldDeliverProcessCompletion,
	shouldInlineCompleteOutput,
	summarizeNotificationCommand,
	validateKillResponse,
} from "./index.ts";

const tools = new Map<string, any>();
const hooks = new Map<string, any>();
const renderers = new Map<string, any>();

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

	expect(render({ status: "success" })).toContain(
		"<success>babysit_run SUCCESS</success>",
	);
	expect(render({ status: "success" })).toContain("<bg-toolSuccessBg>");
	expect(render({ status: "success" })).toContain(
		"<toolOutput>process details</toolOutput>",
	);
	expect(render({ status: "failed" })).toContain("<error>babysit_run FAILED</error>");
	expect(render({ status: "terminated" })).toContain(
		"<error>babysit_run TERMINATED</error>",
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

	expect(tool.renderCall().render(100)).toEqual([]);
	expect(render("success")).toContain("<success>babysit_run SUCCESS</success>");
	expect(render("started")).toContain("<accent>babysit_run STARTED</accent>");
	expect(render("failed", true)).toContain("<error>babysit_run FAILED</error>");
	expect(
		render(
			"success",
			false,
			"worker-dead: the babysit supervisor disappeared without an exit status",
		),
	).toContain("<error>babysit_run TERMINATED</error>");
});

test("babysit version policy requires 0.13.0 or newer", () => {
	expect(isSupportedBabysitVersion("babysit 0.12.9")).toBe(false);
	expect(isSupportedBabysitVersion("babysit 0.13.0-beta.1")).toBe(false);
	expect(isSupportedBabysitVersion("babysit 0.13.0")).toBe(true);
	expect(isSupportedBabysitVersion("babysit 0.14.0-beta.1")).toBe(true);
	expect(isSupportedBabysitVersion("babysit 1.0.0")).toBe(true);
	expect(isSupportedBabysitVersion("unknown")).toBe(false);
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

test("completion notification payload policies are UTF-8 safe and bounded", () => {
	expect(summarizeNotificationCommand("printf 'a  b'\n\t&& printf 'c'")).toBe(
		"printf 'a  b'\\n\\t&& printf 'c'",
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

test("tool hook redirects every shell command to babysit_run", async () => {
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


test("failed commands return small stderr, exit status, and a usable log path", async () => {
	const result = await run("printf '\\146\\141\\151\\154\\055\\144\\145\\164\\141\\151\\154\\012' >&2; exit 7");
	const text = result.content[0]?.text ?? "";

	expect(result.isError).toBe(true);
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
	expect(Buffer.byteLength(checkedText)).toBeLessThan(10_000);
});
