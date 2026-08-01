/**
 * pi-babysit: run ANY shell command under babysit — one context-safe supervision
 * substrate for quick commands, background processes, AND pi subagents. Retires both `pi-processes`
 * (the `process` tool) and `pi-subagent`.
 *
 * Every session is a babysit-supervised PTY (state in $PI_BABYSIT_DIR,
 * default ~/.pi-babysit, namespaced per pi session). Two KINDS of session:
 *
 *   kind=process   `babysit_run { command }` — builds, tests, dev servers,
 *                  watchers, interactive TUIs. Completion = process exit.
 *                  On exit a notification message is injected (triggerTurn),
 *                  so the agent can END ITS TURN after starting and be resumed
 *                  automatically — same contract as the old `process` tool.
 *                  Being a PTY, the agent can also TYPE into it (babysit_send
 *                  text/keys) and read the rendered screen (babysit_check
 *                  { screen: true }) — full interactive-program driving.
 *
 *   kind=subagent  `babysit_run { profile: "subagent", task }` — a long-lived
 *                  `pi --mode rpc` worker. Tasks are injected as RPC `prompt`
 *                  commands over stdin, completion is detected from the JSONL
 *                  event stream (`agent_settled`), NOT process exit; the session
 *                  remains reusable during its configured idle grace. Same design as the
 *                  old pi-subagent extension.
 *
 * The "profile" is a tool-parameter, not a separate tool set: one small tool
 * surface (babysit_run/check/send/wait/kill) covers both, and domain knowledge
 * (RPC bookkeeping, byte offsets, parked-turn detection) stays in code.
 *
 * Tools (LLM):  babysit_run, babysit_check, babysit_send, babysit_wait, babysit_kill
 * Commands:     /babysit (arrow-key picker: attach/tail/inspect)
 * Widget:       live counts (processes running · subagents working · idle)
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents";

// Dedicated babysit state root so pi-managed sessions never collide with the
// user's own manual `babysit` sessions. The base is namespaced per pi session
// on session_start (BABYSIT_DIR=<base>/<session-id>), so each pi session only
// sees its own sessions in list/widget/kill.
const ROOT_BASE = process.env.PI_BABYSIT_DIR ?? path.join(os.homedir(), ".pi-babysit");
let ROOT = ROOT_BASE;
const PI_BIN = process.env.PI_BABYSIT_BIN ?? "pi";
const BABYSIT_BIN = process.env.PI_BABYSIT_CLI ?? "babysit";
const SHELL = process.env.SHELL ?? "sh";
const SUBAGENT_DEPTH_ENV = "PI_BABYSIT_INTERNAL_SUBAGENT_DEPTH";
const SUBAGENT_MAX_DEPTH_ENV = "PI_BABYSIT_INTERNAL_SUBAGENT_MAX_DEPTH";
const DEFAULT_SUBAGENT_MAX_DEPTH = 1;

export type SubagentSpawnPlan =
	| { allowed: true; childDepth: number; maxDepth: number }
	| { allowed: false; error: string };

/**
 * Plan a subagent spawn without letting an already-spawned worker raise its
 * inherited recursion allowance. Depth 0 is the user-facing pi process; the
 * first worker is depth 1 and is allowed by default, but that worker cannot
 * create depth 2 unless its top-level parent explicitly opted in.
 */
export function planSubagentSpawn(
	requestedMaxDepth?: number,
	env: Record<string, string | undefined> = process.env,
): SubagentSpawnPlan {
	if (
		requestedMaxDepth !== undefined &&
		(!Number.isInteger(requestedMaxDepth) || requestedMaxDepth < 1)
	) {
		return { allowed: false, error: "`maxDepth` must be a positive integer." };
	}

	const rawDepth = env[SUBAGENT_DEPTH_ENV];
	let currentDepth = 0;
	if (rawDepth !== undefined) {
		currentDepth = Number(rawDepth);
		if (!Number.isInteger(currentDepth) || currentDepth < 0) {
			return {
				allowed: false,
				error: `Invalid inherited subagent depth ${JSON.stringify(rawDepth)}; refusing to spawn recursively.`,
			};
		}
	}

	const nested = currentDepth > 0;
	if (nested && requestedMaxDepth !== undefined) {
		return {
			allowed: false,
			error:
				`Nested subagents cannot override \`maxDepth\` (current depth ${currentDepth}). ` +
				"Only the top-level parent may opt in when it creates the first subagent.",
		};
	}

	let maxDepth = requestedMaxDepth ?? DEFAULT_SUBAGENT_MAX_DEPTH;
	if (nested) {
		const rawMaxDepth = env[SUBAGENT_MAX_DEPTH_ENV];
		// Missing/corrupt inherited state fails closed at the current depth.
		maxDepth = rawMaxDepth === undefined ? currentDepth : Number(rawMaxDepth);
		if (!Number.isInteger(maxDepth) || maxDepth < currentDepth) {
			return {
				allowed: false,
				error: `Invalid inherited max subagent depth ${JSON.stringify(rawMaxDepth)}; refusing to spawn recursively.`,
			};
		}
	}

	const childDepth = currentDepth + 1;
	if (childDepth > maxDepth) {
		return {
			allowed: false,
			error:
				`Nested subagent creation is disabled at depth ${currentDepth}: spawning would reach depth ${childDepth}, ` +
				`but the inherited maxDepth is ${maxDepth}. Have the top-level parent explicitly opt in with ` +
				`babysit_run { profile: "subagent", task, maxDepth: ${childDepth} } when creating the first worker.`,
		};
	}
	return { allowed: true, childDepth, maxDepth };
}

// Marker embedded in babysit_run's tool RESULT text for kind=process runs.
// It is how "the turn parked awaiting a process-exit notification" is told
// apart from any other turn end (see isParkedMessages / self-reap.ts).
export const NOTIFY_MARKER = "[notify-on-exit]";

// Human-readable view for the compact subagent JSONL stream when a human
// attaches. The RPC proxy removes cumulative streaming snapshots before both
// recording and display; authoritative events remain intact for parsers. Set
// PI_BABYSIT_VIEW_CMD="" to disable formatting, or provide a custom command.
const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const VIEW_CMD =
	process.env.PI_BABYSIT_VIEW_CMD ??
	`${shq(process.execPath)} ${shq(path.join(EXT_DIR, "format-stream.mjs"))}`;

// Appended to every subagent's system prompt. The subagent is a long-lived
// headless `pi --mode rpc` worker: turns can end and resume, so babysit_run
// (process kind) works normally inside it. It just cannot talk to a human.
export function subagentGuidance(
	depth: number,
	maxDepth: number,
	directBashAvailable: boolean,
	babysitRunAvailable = true,
): string {
	const shellGuidance = directBashAvailable
		? "Direct bash is available, and babysit_run can supervise longer commands."
		: babysitRunAvailable
			? "Direct bash is unavailable; run shell commands with babysit_run { command }."
			: "No shell execution tool is available in this task's tool allowlist; do not attempt shell commands.";
	const nestingGuidance = depth >= maxDepth
		? `You are at the inherited subagent depth limit (${depth}/${maxDepth}); do not attempt to spawn another subagent.`
		: `Your inherited subagent depth is ${depth}/${maxDepth}; child subagents may not exceed maxDepth ${maxDepth}.`;
	return [
		"You are a headless background worker driven over pi's RPC protocol.",
		"Work autonomously: you cannot ask the user questions, so state assumptions",
		"in your final answer instead.",
		shellGuidance,
		nestingGuidance,
		"When your task is complete, produce a final answer message summarizing the outcome —",
		"your controller reads it from the event stream.",
	].join(" ");
}
const POLL_MS = 2500;
const QUICK_COMMAND_GRACE = process.env.PI_BABYSIT_QUICK_GRACE ?? "2s";
const KILL_CONFIRM_TIMEOUT = "4s";

interface BsSession {
	id: string;
	state: string; // "running" | "exited" | "dead" ...
	alive?: boolean; // whether the PTY worker process is still live
	exit_code?: number | null;
	note?: string | null;
	output_bytes?: number;
	screen_seq?: number | null;
}

// A worker whose PTY process is gone (alive:false) can still report state
// "running" if it crashed BEFORE recording its exit transition (e.g. the child
// died in the first few ms). Treat that as finished so it never shows or counts
// as running. This normalizes at the source so every downstream
// `state === "running"` check is correct.
function normalizeSession(s: BsSession): BsSession {
	if (s.alive === false && s.state === "running") {
		return { ...s, state: s.exit_code != null ? "exited" : "dead" };
	}
	return s;
}

// ---------------------------------------------------------------------------
// babysit CLI helpers
// ---------------------------------------------------------------------------

// Async, NON-BLOCKING spawn. Using spawnSync here would block Node's event
// loop (and thus freeze the whole TUI) for the entire duration of the child —
// which for `babysit wait` can be minutes or forever. A streamed async spawn
// keeps the UI responsive while the child runs. An optional AbortSignal lets a
// long wait be interrupted (Ctrl-C) by killing the child.
function bs(
	args: string[],
	opts: {
		cwd?: string;
		signal?: AbortSignal;
		env?: Record<string, string | undefined>;
	} = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve) => {
		if (opts.signal?.aborted) {
			resolve({ stdout: "", stderr: "aborted", code: 130 });
			return;
		}
		const child = spawn(BABYSIT_BIN, args, {
			cwd: opts.cwd,
			env: { ...process.env, ...opts.env, BABYSIT_DIR: ROOT },
		});
		let stdout = "";
		let stderr = "";
		const onAbort = () => child.kill("SIGTERM");
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout?.on("data", (d) => {
			stdout += d.toString();
		});
		child.stderr?.on("data", (d) => {
			stderr += d.toString();
		});
		child.on("error", (e) => {
			opts.signal?.removeEventListener("abort", onAbort);
			resolve({ stdout, stderr: stderr + String(e), code: 1 });
		});
		child.on("close", (code) => {
			opts.signal?.removeEventListener("abort", onAbort);
			resolve({ stdout, stderr, code: code ?? 1 });
		});
	});
}

// ---------------------------------------------------------------------------
// preflight: the `babysit` binary must be on PATH
// ---------------------------------------------------------------------------

// Every session shells out to `babysit`; without it the extension can do
// nothing. We don't auto-install (that's the user's job) — we fail loudly with
// install instructions the moment a tool or command is used.
const INSTALL_STEPS =
	`Install babysit 0.13.0 or newer, then retry:\n` +
	`  cargo install --git https://github.com/yusukeshib/babysit\n` +
	`or download a prebuilt binary from https://github.com/yusukeshib/babysit/releases and put it on your PATH.\n` +
	`(Override the binary path with $PI_BABYSIT_CLI.)`;
const INSTALL_HINT =
	`The \`babysit\` binary was not found (tried "${BABYSIT_BIN}").\n` + INSTALL_STEPS;
const MIN_BABYSIT_VERSION = [0, 13, 0] as const;

export function isSupportedBabysitVersion(output: string): boolean {
	const match = /\b(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\b/.exec(output);
	if (!match) return false;
	const actual = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
	for (let i = 0; i < MIN_BABYSIT_VERSION.length; i++) {
		if (actual[i] !== MIN_BABYSIT_VERSION[i]) return actual[i] > MIN_BABYSIT_VERSION[i];
	}
	return match[4] === undefined;
}

// Cached preflight — probe `babysit --version` exactly once per process.
// undefined = not probed, null = supported, string = actionable error.
let babysitPreflightError: string | null | undefined;
let babysitPreflightCheckedAt = 0;
async function babysitAvailable(): Promise<boolean> {
	if (babysitPreflightError === null) return true;
	// Briefly negative-cache failures so repeated mistaken calls do not fork a
	// version probe each time, while still recovering quickly after installation.
	if (babysitPreflightError && Date.now() - babysitPreflightCheckedAt < 2_000) return false;
	const r = await bs(["--version"]);
	babysitPreflightCheckedAt = Date.now();
	if (r.code !== 0) {
		babysitPreflightError = INSTALL_HINT;
	} else if (!isSupportedBabysitVersion(r.stdout)) {
		babysitPreflightError =
			`pi-babysit requires babysit 0.13.0 or newer; found ${r.stdout.trim() || "an unknown version"}.\n` +
			INSTALL_STEPS;
	} else {
		babysitPreflightError = null;
	}
	return babysitPreflightError === null;
}

// Throwing form for tool `execute` handlers: a thrown error marks the tool
// result isError and reports the preflight error to the model.
async function requireBabysit(): Promise<void> {
	if (!(await babysitAvailable())) throw new Error(babysitPreflightError ?? INSTALL_HINT);
}

// Error-aware: `babysit list` failing is NOT the same as "no sessions" —
// callers that show state to the agent must surface the error instead of
// silently reporting an empty registry (which reads like lost sessions).
async function listSessions(): Promise<{ sessions: BsSession[]; error?: string }> {
	const r = await bs(["list", "--json"]);
	if (r.code !== 0) {
		return {
			sessions: [],
			error: r.stderr || r.stdout || `babysit list failed (exit ${r.code}, no output)`,
		};
	}
	try {
		const parsed = JSON.parse(r.stdout);
		const raw: BsSession[] = Array.isArray(parsed) ? parsed : (parsed.sessions ?? []);
		return { sessions: raw.map(normalizeSession) };
	} catch {
		return { sessions: [], error: `could not parse babysit list output: ${r.stdout.slice(0, 200)}` };
	}
}

async function lookupStatus(
	id: string,
): Promise<{ session: BsSession | null; error?: string }> {
	// `list --json` already carries every lifecycle field used by the extension,
	// including `alive` and `note`. Using it directly avoids the old
	// status-then-list pair (two CLI subprocesses for every status lookup).
	try {
		const listed = await listSessions();
		if (listed.error) return { session: null, error: listed.error };
		return { session: listed.sessions.find((session) => session.id === id) ?? null };
	} catch (error) {
		return { session: null, error: error instanceof Error ? error.message : String(error) };
	}
}

async function statusOf(id: string): Promise<BsSession | null> {
	return (await lookupStatus(id)).session;
}

export function isConfirmedTerminalState(state: string): boolean {
	return state === "killed" || state === "exited";
}

export function validateKillResponse(stdout: string): string | null {
	try {
		const response = JSON.parse(stdout);
		if (response.killed !== true || response.confirmed === false) {
			return `Kill was not confirmed by babysit: ${stdout.trim()}`;
		}
		return null;
	} catch {
		return `Invalid kill response from babysit: ${stdout.trim() || "(empty)"}`;
	}
}

async function awaitConfirmedTermination(id: string): Promise<BsSession | null> {
	const initial = await statusOf(id);
	if (!initial || isConfirmedTerminalState(initial.state) || initial.state === "dead") {
		return initial;
	}
	// New babysit versions return only after persistence, so this is normally
	// skipped. It is a bounded compatibility guard for older binaries that
	// acknowledged signal delivery before the process actually exited.
	await bs(["wait", "-s", id, "--timeout", KILL_CONFIRM_TIMEOUT]);
	return statusOf(id);
}

// ---------------------------------------------------------------------------
// per-session metadata
// ---------------------------------------------------------------------------

// kind=process: name/command + `notified` (exit notification dedup).
// kind=subagent: task + the raw-log byte offset of the last prompt, which lets
// check/wait analyze only the CURRENT task's events (important for follow-ups).
export interface SubagentBudget {
	maxCost?: number;
	maxTurns?: number;
	maxToolCalls?: number;
	maxUsageTokens?: number;
}

interface Meta {
	kind: "process" | "subagent";
	// process
	name?: string;
	command?: string;
	notificationGroup?: string;
	notified?: boolean;
	// A confirmed kill permanently owns completion delivery. An interrupted
	// concurrent wait must not re-enable the automatic notification afterward.
	killNotificationSuppressed?: boolean;
	// Temporary reservation while kill is in flight. Unlike `notified`, this
	// must be cleared on failure so a real completion remains deliverable.
	notificationPaused?: boolean;
	// Concurrent explicit waits share a reference-counted notification claim.
	// A timeout must not re-enable the poller while another wait still owns it.
	waitReservations?: number;
	waitCompletionClaimed?: boolean;
	completionObservedAt?: number;
	startedAt?: number;
	// subagent
	task?: string;
	promptOffset?: number;
	model?: string;
	tools?: string[];
	messageTempDirs?: Array<{ dir: string; afterAgentEnd: number }>;
	depth?: number;
	maxDepth?: number;
	budget?: SubagentBudget;
	/** Soft-limit warning (80% by default) was accepted for this task. */
	budgetWarnedAt?: number;
	budgetWarningReason?: string;
	/** Hard limit was first observed; grace is measured from observation, not RPC acceptance. */
	budgetExceededAt?: number;
	budgetReason?: string;
	budgetKilled?: boolean;
	/** Prompt offset whose nested usage has already been charged to the parent session. */
	usageReportedOffset?: number;
	/** Prompt offset explicitly collected by foreground mode or babysit_wait. */
	subagentCollectedOffset?: number;
	/** Prompt offset whose ready-to-collect reminder was sent to the parent. */
	subagentNotifiedOffset?: number;
	/** Current task completion first observed by the reminder poller. */
	subagentCompletionObservedOffset?: number;
	subagentCompletionObservedAt?: number;
}

const metaDir = () => path.join(ROOT, "meta");
const logPath = (id: string) => path.join(ROOT, "sessions", id, "output.log");

function writeMeta(id: string, m: Meta): boolean {
	const target = path.join(metaDir(), `${id}.json`);
	const temp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
	try {
		fs.mkdirSync(metaDir(), { recursive: true });
		fs.writeFileSync(temp, JSON.stringify(m));
		fs.renameSync(temp, target);
		return true;
	} catch {
		try {
			fs.rmSync(temp, { force: true });
		} catch {
			/* best-effort */
		}
		return false;
	}
}

export function claimFileOnce(file: string, payload: string): boolean {
	let fd: number;
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fd = fs.openSync(file, "wx");
	} catch {
		return false;
	}
	try {
		fs.writeFileSync(fd, payload);
	} finally {
		fs.closeSync(fd);
	}
	return true;
}

function readMeta(id: string): Meta | null {
	try {
		return JSON.parse(fs.readFileSync(path.join(metaDir(), `${id}.json`), "utf-8"));
	} catch {
		return null;
	}
}

export interface BabysitGcResult {
	candidates: string[];
	deleted: string[];
	bytes: number;
	skippedLive: string[];
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

const GC_LOCK_FILE = ".pi-babysit-gc.lock";
const GC_STAMP_FILE = ".pi-babysit-gc.last";
const AUTOMATIC_GC_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const ACTIVE_LEASE_PREFIX = ".pi-babysit-active-";

function automaticGcDue(now = Date.now()): boolean {
	try {
		return now - fs.statSync(path.join(ROOT_BASE, GC_STAMP_FILE)).mtimeMs >= AUTOMATIC_GC_INTERVAL_MS;
	} catch {
		return true;
	}
}

function markAutomaticGc(now = new Date()): void {
	try {
		fs.mkdirSync(ROOT_BASE, { recursive: true });
		fs.writeFileSync(path.join(ROOT_BASE, GC_STAMP_FILE), now.toISOString());
	} catch {
		/* best-effort; GC safety does not depend on this throttle stamp */
	}
}

function scanTreeStats(root: string): { bytes: number; newestMtimeMs: number } {
	let bytes = 0;
	let newestMtimeMs = 0;
	const pending = [root];
	while (pending.length > 0) {
		const current = pending.pop() as string;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.name === GC_LOCK_FILE) continue;
			const fullPath = path.join(current, entry.name);
			try {
				const stat = fs.lstatSync(fullPath);
				newestMtimeMs = Math.max(newestMtimeMs, stat.mtimeMs);
				if (entry.isDirectory()) pending.push(fullPath);
				else if (entry.isFile()) bytes += stat.size;
			} catch {
				/* raced with cleanup */
			}
		}
	}
	return { bytes, newestMtimeMs };
}

function gcRootIsSafe(root: string): boolean {
	let rootEntries: fs.Dirent[];
	try {
		rootEntries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return false;
	}
	for (const entry of rootEntries) {
		if (!entry.isFile() || !entry.name.startsWith(ACTIVE_LEASE_PREFIX)) continue;
		try {
			const lease = JSON.parse(fs.readFileSync(path.join(root, entry.name), "utf8")) as {
				pid?: number;
			};
			if (!Number.isSafeInteger(lease.pid) || (lease.pid as number) <= 0) return false;
			if (processIsAlive(lease.pid as number)) return false;
		} catch {
			return false;
		}
	}

	const sessionsDir = path.join(root, "sessions");
	let sessionDirs: fs.Dirent[];
	try {
		sessionDirs = fs.readdirSync(sessionsDir, { withFileTypes: true });
	} catch {
		return false;
	}
	let sawStatus = false;
	for (const sessionEntry of sessionDirs) {
		if (!sessionEntry.isDirectory()) continue;
		const sessionDir = path.join(sessionsDir, sessionEntry.name);
		try {
			const status = JSON.parse(
				fs.readFileSync(path.join(sessionDir, "status.json"), "utf8"),
			) as { state?: string; child_pid?: number | null };
			sawStatus = true;
			if (status.state !== "running") {
				if (!status.state || (!isConfirmedTerminalState(status.state) && status.state !== "dead")) {
					return false;
				}
				continue;
			}
			const supervisorPid = Number(
				(JSON.parse(fs.readFileSync(path.join(sessionDir, "meta.json"), "utf8")) as {
					babysit_pid?: number;
				}).babysit_pid,
			);
			const childPid = Number(status.child_pid);
			if (
				!Number.isSafeInteger(supervisorPid) ||
				supervisorPid <= 0 ||
				processIsAlive(supervisorPid) ||
				(Number.isSafeInteger(childPid) && childPid > 0 && processIsAlive(childPid))
			) {
				return false;
			}
		} catch {
			return false;
		}
	}
	return sawStatus;
}

function acquireRootLease(root: string): string | null {
	fs.mkdirSync(root, { recursive: true });
	const leasePath = path.join(
		root,
		`${ACTIVE_LEASE_PREFIX}${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
	);
	const sleeper = new Int32Array(new SharedArrayBuffer(4));
	for (let attempt = 0; attempt < 100; attempt++) {
		if (fs.existsSync(path.join(root, GC_LOCK_FILE))) {
			Atomics.wait(sleeper, 0, 0, 50);
			continue;
		}
		try {
			fs.writeFileSync(leasePath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), {
				flag: "wx",
			});
			if (!fs.existsSync(path.join(root, GC_LOCK_FILE))) return leasePath;
			fs.rmSync(leasePath, { force: true });
		} catch {
			/* retry while a collector owns the namespace */
		}
		Atomics.wait(sleeper, 0, 0, 50);
	}
	return null;
}

function releaseRootLease(leasePath: string | undefined): void {
	if (!leasePath) return;
	try {
		fs.rmSync(leasePath, { force: true });
	} catch {
		/* best-effort */
	}
}

export function gcBabysitRoots(options: {
	rootBase: string;
	currentRoot: string;
	olderThanMs: number;
	dryRun?: boolean;
	now?: number;
}): BabysitGcResult {
	const now = options.now ?? Date.now();
	const current = path.resolve(options.currentRoot);
	const result: BabysitGcResult = { candidates: [], deleted: [], bytes: 0, skippedLive: [] };
	let roots: fs.Dirent[];
	try {
		roots = fs.readdirSync(options.rootBase, { withFileTypes: true });
	} catch {
		return result;
	}

	for (const entry of roots) {
		if (!entry.isDirectory() || entry.name.startsWith(".pi-babysit-gc-")) continue;
		const root = path.join(options.rootBase, entry.name);
		if (path.resolve(root) === current) continue;
		if (!gcRootIsSafe(root)) {
			result.skippedLive.push(entry.name);
			continue;
		}
		const stats = scanTreeStats(root);
		if (now - stats.newestMtimeMs < options.olderThanMs) continue;
		result.candidates.push(entry.name);
		if (options.dryRun !== false) {
			result.bytes += stats.bytes;
			continue;
		}

		const lockPath = path.join(root, GC_LOCK_FILE);
		let lockFd: number | undefined;
		let tombstone: string | undefined;
		try {
			lockFd = fs.openSync(lockPath, "wx");
			// Compatible Pi processes acquire an active lease around this same lock.
			// Revalidate after locking, then atomically rename the root so a resume
			// racing deletion creates a fresh namespace instead of writing into rmSync.
			if (!gcRootIsSafe(root)) {
				result.skippedLive.push(entry.name);
				continue;
			}
			const refreshedStats = scanTreeStats(root);
			if (now - refreshedStats.newestMtimeMs < options.olderThanMs) continue;
			tombstone = path.join(
				options.rootBase,
				`.pi-babysit-gc-${entry.name}-${process.pid}-${Date.now()}`,
			);
			fs.closeSync(lockFd);
			lockFd = undefined;
			fs.renameSync(root, tombstone);
			fs.rmSync(tombstone, { recursive: true, force: true });
			result.deleted.push(entry.name);
			result.bytes += refreshedStats.bytes;
		} catch {
			/* report only roots whose atomic removal completed */
		} finally {
			if (lockFd != null) {
				try {
					fs.closeSync(lockFd);
				} catch {
					/* best-effort */
				}
			}
			try {
				fs.rmSync(lockPath, { force: true });
			} catch {
				/* root may already have been atomically renamed */
			}
		}
	}
	return result;
}

function cleanupMessageTempDirs(id: string, meta: Meta, agentEnds: number): void {
	if (!meta.messageTempDirs?.length) return;
	const keep: NonNullable<Meta["messageTempDirs"]> = [];
	for (const entry of meta.messageTempDirs) {
		if (entry.afterAgentEnd > agentEnds) {
			keep.push(entry);
			continue;
		}
		try {
			fs.rmSync(entry.dir, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
	if (keep.length > 0) meta.messageTempDirs = keep;
	else delete meta.messageTempDirs;
	writeMeta(id, meta);
}

export function shouldDeliverProcessCompletion(
	meta: Meta | null,
): meta is Meta & { kind: "process" } {
	return meta?.kind === "process" && !meta.notified && !meta.notificationPaused;
}

export function shouldDeliverSubagentCompletion(meta: Meta | null): meta is Meta & { kind: "subagent" } {
	if (meta?.kind !== "subagent") return false;
	const offset = meta.promptOffset ?? 0;
	return (
		meta.usageReportedOffset !== offset &&
		meta.subagentCollectedOffset !== offset &&
		meta.subagentNotifiedOffset !== offset
	);
}

export function isNotificationGroupReady(
	meta: Meta,
	sessions: BsSession[],
	metaFor: (id: string) => Meta | null,
): boolean {
	if (!meta.notificationGroup) return true;
	return !sessions.some(
		(session) =>
			session.state === "running" &&
			metaFor(session.id)?.notificationGroup === meta.notificationGroup,
	);
}

export function shouldDeferCompletionNotification(agentIsIdle: boolean): boolean {
	return !agentIsIdle;
}

export function shouldKeepPolling(
	sessions: Array<{ id: string; state: string }>,
	metaFor: (id: string) => Meta | null,
): boolean {
	return sessions.some((session) => {
		const meta = metaFor(session.id);
		return (
			session.state === "running" ||
			shouldDeliverProcessCompletion(meta) ||
			(session.state !== "running" && shouldDeliverSubagentCompletion(meta))
		);
	});
}

export function shouldKeepPollingAfterList(
	listed: { sessions: Array<{ id: string; state: string }>; error?: string },
	metaFor: (id: string) => Meta | null,
): boolean {
	return Boolean(listed.error) || shouldKeepPolling(listed.sessions, metaFor);
}

const kindOf = (id: string): "process" | "subagent" => readMeta(id)?.kind ?? "process";

// Compact elapsed formatting: "42s", "3m12s", "1h04m".
function fmtDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

// Elapsed since a session started, from its recorded startedAt (null if unknown).
function elapsedOf(id: string): string | null {
	const started = readMeta(id)?.startedAt;
	return started ? fmtDuration(Date.now() - started) : null;
}

// ---------------------------------------------------------------------------
// RPC plumbing over babysit (subagent kind: send a command, await its response)
// ---------------------------------------------------------------------------

// `babysit send --json` returns the raw-log byte offset just BEFORE the input
// was injected — pass it to `expect --since` to wait for the reply race-free.
async function sendRpc(
	id: string,
	cmd: Record<string, unknown>,
): Promise<{ offset: number } | { error: string }> {
	const r = await bs(["send", "-s", id, "--json", JSON.stringify(cmd)]);
	if (r.code !== 0) return { error: r.stderr || r.stdout || "send failed" };
	try {
		return { offset: JSON.parse(r.stdout).offset as number };
	} catch {
		return { error: `could not parse send output: ${r.stdout}` };
	}
}

export function parseRpcResponseBytes(
	bytes: Buffer,
	since: number,
	command: string,
):
	| { ok: true; data?: Record<string, unknown>; offset: number }
	| { ok: false; error: string } {
	let start = 0;
	while (start < bytes.length) {
		const newline = bytes.indexOf(0x0a, start);
		const end = newline < 0 ? bytes.length : newline + 1;
		const line = bytes
			.subarray(start, newline < 0 ? end : newline)
			.toString("utf8")
			.replace(/\r$/, "")
			.trim();
		if (line.startsWith("{")) {
			try {
				const event = JSON.parse(line);
				if (event.type === "response" && event.command === command) {
					if (event.success === false) {
						return { ok: false, error: clip(String(event.error ?? `${command} failed`)) };
					}
					return {
						ok: true,
						data: event.data as Record<string, unknown> | undefined,
						offset: since + end,
					};
				}
			} catch {
				/* partial line */
			}
		}
		start = end;
	}
	return { ok: false, error: `no ${command} response found in log` };
}

// Wait for `{"type":"response","command":<command>}` after `since`, then parse
// it. Distinguishes: success, explicit failure (success:false → the error
// message, e.g. "No API key found for …"), subagent death, and timeout — this
// is what makes bad-model/config failures LOUD instead of silent.
export function rpcResponsePattern(command: string): string {
	const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// Match only a complete response record. A loose `"command":"…"` can occur
	// in assistant/tool text, and matching before the terminating newline can
	// race the writer while the JSON record is still partial.
	return `(?m)^\\{(?:"id":"[^"\\n]*",)?"type":"response","command":"${escaped}"[^\\n]*\\}\\r?\\n`;
}

export function readLogBytesFrom(file: string, since: number): Buffer {
	const size = fs.statSync(file).size;
	const offset = Math.min(Math.max(0, since), size);
	const length = size - offset;
	const bytes = Buffer.allocUnsafe(length);
	const fd = fs.openSync(file, "r");
	let read = 0;
	try {
		while (read < length) {
			const count = fs.readSync(fd, bytes, read, length - read, offset + read);
			if (count === 0) break;
			read += count;
		}
	} finally {
		fs.closeSync(fd);
	}
	return bytes.subarray(0, read);
}

const RPC_RESPONSE_WINDOW_MAX_BYTES = 1_000_000;
function readLogWindowFrom(
	file: string,
	since: number,
	maxBytes = RPC_RESPONSE_WINDOW_MAX_BYTES,
): { bytes: Buffer; offset: number } {
	const size = fs.statSync(file).size;
	const requested = Math.min(Math.max(0, since), size);
	const offset = Math.max(requested, size - maxBytes);
	return { bytes: readLogBytesFrom(file, offset), offset };
}

async function rpcResponse(
	id: string,
	since: number,
	command: string,
	timeout = "30s",
	signal?: AbortSignal,
): Promise<
	| { ok: true; data?: Record<string, unknown>; offset: number }
	| { ok: false; error: string }
> {
	const e = await bs(
		[
			"expect",
			"-s",
			id,
			"--since",
			String(since),
			"--timeout",
			timeout,
			rpcResponsePattern(command),
		],
		{ signal },
	);
	if (e.code !== 0) {
		const st = await statusOf(id);
		if (st && st.state !== "running") {
			let structuredError = "";
			try {
				// Long-lived follow-up workers can have very large historical logs. Read
				// only the response window rather than synchronously loading all history.
				const window = readLogWindowFrom(logPath(id), since);
				structuredError = parseEvents(window.bytes.toString("utf8")).errorMsg ?? "";
			} catch {
				/* full log path below remains the diagnostic source */
			}
			return {
				ok: false,
				error:
					`subagent exited (exit_code=${st.exit_code ?? "?"}) before responding to ${command}.` +
					(structuredError ? `\n${structuredError}` : "") +
					`\nFull log: ${logPath(id)}`,
			};
		}
		return {
			ok: false,
			error:
				e.code === 124
					? `timed out waiting for ${command} response (${timeout})`
					: e.stderr || `expect failed (code ${e.code})`,
		};
	}
	try {
		const window = readLogWindowFrom(logPath(id), since);
		return parseRpcResponseBytes(window.bytes, window.offset, command);
	} catch (error) {
		return { ok: false, error: `could not read ${command} response: ${String(error)}` };
	}
}

// "5m" / "30s" / "2h" → milliseconds (null = no limit).
function parseDurMs(s?: string): number | null {
	if (!s || s === "none" || s === "0") return null;
	const m = /^(\d+)(ms|s|m|h)?$/.exec(s.trim());
	if (!m) return null;
	const n = Number(m[1]);
	const u = m[2] ?? "s";
	return n * (u === "ms" ? 1 : u === "s" ? 1000 : u === "m" ? 60_000 : 3_600_000);
}

// ---------------------------------------------------------------------------
// Context-size guard — every string that flows back into the agent's context
// passes through clip(). Log tails are line-capped upstream (`--tail N`), but
// a single pathological line (minified JS, a giant JSON blob) can still be
// megabytes, so we also cap bytes, eliding the middle so both the head and
// the tail of the output stay visible.

function byteLimitFromEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw == null || raw.trim() === "") return fallback;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

const TAIL_MAX_BYTES = byteLimitFromEnv("PI_BABYSIT_TAIL_MAX_BYTES", 4_000);
// Direct run/wait results can carry more context because the caller explicitly
// requested them. Unsolicited completion notifications default much smaller.
const INLINE_OUTPUT_MAX_BYTES = byteLimitFromEnv("PI_BABYSIT_INLINE_OUTPUT_MAX_BYTES", 8_000);
const NOTIFY_OUTPUT_MAX_BYTES = byteLimitFromEnv("PI_BABYSIT_NOTIFY_OUTPUT_MAX_BYTES", 2_000);
const NOTIFY_COMMAND_MAX_BYTES = byteLimitFromEnv("PI_BABYSIT_NOTIFY_COMMAND_MAX_BYTES", 240);
const NOTIFY_BATCH_MAX_BYTES = byteLimitFromEnv("PI_BABYSIT_NOTIFY_BATCH_MAX_BYTES", 8_000);
const ANSWER_MAX_BYTES = 24_000; // single subagent answers / structured error messages
const MAX_MULTI_WAIT_SESSIONS = 32;
const SUBAGENT_BUDGET_GRACE_MS =
	parseDurMs(process.env.PI_BABYSIT_BUDGET_GRACE ?? "90s") ?? 90_000;
const SUBAGENT_REAP_AFTER =
	process.env.PI_BABYSIT_REAP_AFTER ?? process.env.PI_SUBAGENT_REAP_AFTER ?? "120s";
const SUBAGENT_REUSE_HINT = ["0", "off", "none"].includes(SUBAGENT_REAP_AFTER)
	? "Session remains available until its absolute timeout."
	: `Session remains available for follow-ups during the ${SUBAGENT_REAP_AFTER} idle grace.`;

export function clip(s: string, maxBytes = TAIL_MAX_BYTES): string {
	if (maxBytes <= 0) return "";
	const buf = Buffer.from(s, "utf8");
	if (buf.length <= maxBytes) return s;

	// The marker counts toward the limit. Recompute a few times because the
	// omitted-byte count can change the marker's digit width.
	let available = maxBytes;
	let marker = "";
	for (let i = 0; i < 3; i++) {
		marker = `\n… [${buf.length - available} bytes elided] …\n`;
		available = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
	}
	if (Buffer.byteLength(marker, "utf8") > maxBytes) return truncateUtf8End(marker, maxBytes);
	const headBytes = Math.floor(available / 2);
	const tailBytes = available - headBytes;
	// Strip replacement chars from a mid-codepoint cut at either boundary.
	const head = buf.subarray(0, headBytes).toString("utf8").replace(/\uFFFD+$/, "");
	const tail = buf.subarray(buf.length - tailBytes).toString("utf8").replace(/^\uFFFD+/, "");
	return `${head}${marker}${tail}`;
}

export function clipMultiWaitResult(
	value: string,
	maxBytes = INLINE_OUTPUT_MAX_BYTES,
): string {
	return clip(value, Math.min(maxBytes, ANSWER_MAX_BYTES));
}

interface SearchLogCacheEntry {
	size: number;
	mtimeMs: number;
	text: string;
}
const searchLogCache = new Map<string, SearchLogCacheEntry>();

async function searchLog(
	id: string,
	pattern: string,
	maxLines: number,
	signal?: AbortSignal,
	maxBytes = TAIL_MAX_BYTES,
): Promise<{ text: string; error?: string }> {
	const file = logPath(id);
	if (!fs.existsSync(file)) return { text: "", error: `Log file is missing: ${file}` };
	if (signal?.aborted) return { text: "", error: "Log search was interrupted." };
	const stat = fs.statSync(file);
	const cacheKey = `${file}\u0000${pattern}\u0000${maxLines}\u0000${maxBytes}`;
	const cached = searchLogCache.get(cacheKey);
	if (cached?.size === stat.size && cached.mtimeMs === stat.mtimeMs) return { text: cached.text };

	// Run regex evaluation out of process so catastrophic backtracking or a huge
	// no-newline log cannot freeze or exhaust pi's main Node process. The helper
	// clips each retained line; this parent also enforces a hard wall-clock limit.
	return new Promise((resolve) => {
		const helper = path.join(EXT_DIR, "search-log.mjs");
		const nodeOptions = [process.env.NODE_OPTIONS, "--max-old-space-size=32"]
			.filter(Boolean)
			.join(" ");
		const child = spawn(process.execPath, [helper, file, pattern, String(maxLines)], {
			env: { ...process.env, NODE_OPTIONS: nodeOptions },
		});
		let stdout = "";
		let stderr = "";
		let finished = false;
		let timedOut = false;
		const finish = (result: { text: string; error?: string }) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};
		const onAbort = () => {
			child.kill("SIGTERM");
			finish({ text: "", error: "Log search was interrupted." });
		};
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, 3_000);
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout?.on("data", (data) => {
			stdout += data.toString();
		});
		child.stderr?.on("data", (data) => {
			stderr = clip(stderr + data.toString());
		});
		child.on("error", (error) => {
			finish({ text: "", error: `Could not start log search: ${String(error)}` });
		});
		child.on("close", (code) => {
			if (timedOut) {
				finish({ text: "", error: "Log search timed out after 3s; narrow the pattern or log." });
			} else if (code !== 0) {
				finish({ text: "", error: stderr.trim() || `Log search failed (exit ${code ?? "?"}).` });
			} else {
				const text = clip(stdout.trimEnd(), maxBytes);
				searchLogCache.set(cacheKey, { size: stat.size, mtimeMs: stat.mtimeMs, text });
				while (searchLogCache.size > 64) searchLogCache.delete(searchLogCache.keys().next().value as string);
				finish({ text });
			}
		});
	});
}

export function shouldInlineCompleteOutput(outputBytes: number, maxBytes: number): boolean {
	return maxBytes > 0 && outputBytes <= maxBytes;
}

async function inlineOutput(
	id: string,
	status: BsSession,
	maxBytes = INLINE_OUTPUT_MAX_BYTES,
): Promise<string> {
	let bytes = status.output_bytes;
	if (bytes == null) {
		try {
			bytes = fs.statSync(logPath(id)).size;
		} catch {
			bytes = Number.POSITIVE_INFINITY;
		}
	}
	if (!shouldInlineCompleteOutput(bytes, maxBytes)) {
		const size = Number.isFinite(bytes) ? `${bytes} bytes` : "size unavailable";
		return `\nOutput omitted (${size}; inline limit ${maxBytes}).`;
	}
	const output = (await bs(["log", "-s", id])).stdout.trimEnd();
	if (Buffer.byteLength(output) > maxBytes) {
		return `\nOutput omitted (exceeds inline limit ${maxBytes} bytes).`;
	}
	return output ? `\n\nOutput:\n${output}` : "";
}

interface ProcessOutputSelection {
	pattern?: string;
	lines?: number;
	maxBytes?: number;
}

async function selectedProcessOutput(
	id: string,
	status: BsSession,
	selection?: ProcessOutputSelection,
	signal?: AbortSignal,
): Promise<string> {
	if (!selection || (!selection.pattern && selection.lines == null && selection.maxBytes == null)) {
		return inlineOutput(id, status);
	}
	const maxBytes = selection.maxBytes ?? INLINE_OUTPUT_MAX_BYTES;
	const lines = Math.min(Math.max(1, Math.floor(selection.lines ?? 30)), 200);
	if (selection.pattern) {
		const result = await searchLog(id, selection.pattern, lines, signal, maxBytes);
		if (result.error) return `\nOutput filter failed: ${result.error}`;
		const body = result.text || `(no output matching /${selection.pattern}/)`;
		return `\n\nSelected output /${selection.pattern}/:\n${clip(body, maxBytes)}`;
	}
	const tail = (await bs(["log", "-s", id, "--tail", String(lines)])).stdout.trimEnd();
	return tail ? `\n\nSelected tail (${lines} lines max):\n${clip(tail, maxBytes)}` : "";
}

export function summarizeNotificationCommand(command: string | undefined): string {
	const preview =
		(command ?? "?")
			.trim()
			.replace(/\r/g, "\\r")
			.replace(/\n/g, "\\n")
			.replace(/\t/g, "\\t")
			.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, (char) =>
				`\\x${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
			) || "?";
	const bytes = Buffer.from(preview, "utf8");
	if (bytes.length <= NOTIFY_COMMAND_MAX_BYTES) return preview;
	if (NOTIFY_COMMAND_MAX_BYTES === 0) return "";
	const ellipsis = Buffer.from("…", "utf8");
	if (NOTIFY_COMMAND_MAX_BYTES <= ellipsis.length) {
		return ".".repeat(NOTIFY_COMMAND_MAX_BYTES);
	}
	const prefix = bytes
		.subarray(0, NOTIFY_COMMAND_MAX_BYTES - ellipsis.length)
		.toString("utf8")
		.replace(/\uFFFD+$/, "");
	return `${prefix}…`;
}

type CompletionStatus = "success" | "failed" | "terminated";

export interface ProcessCompletionNotice {
	id: string;
	exitCode: number | null | undefined;
	success: boolean;
	status: CompletionStatus;
	runtime: string;
	summary: string;
	command: string | undefined;
	logPath: string;
	output: string;
}

interface ProcessCompletionMessage {
	customType: "pi-babysit-process-end";
	content: string;
	display: true;
	details: {
		id?: string;
		exitCode?: number | null;
		success: boolean;
		status: CompletionStatus;
		runtime?: string;
		logPath?: string;
		command?: string;
		count: number;
		totalCount: number;
		remainingCount: number;
		processes: Array<{
			id: string;
			exitCode: number | null | undefined;
			success: boolean;
			status: CompletionStatus;
			runtime: string;
			command: string | undefined;
			logPath: string;
		}>;
	};
}

const COMPLETION_FOOTER =
	"Automatic completion notification. Inspect the bounded log with babysit_check only if needed.";
const AGGREGATE_OUTPUT_OMISSION = "\nOutput omitted from aggregate notification; inspect log.";

function truncateUtf8End(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= maxBytes) return value;
	const suffix = Buffer.from("…", "utf8");
	if (maxBytes <= suffix.length) return ".".repeat(maxBytes);
	const prefix = bytes
		.subarray(0, maxBytes - suffix.length)
		.toString("utf8")
		.replace(/\uFFFD+$/, "");
	return `${prefix}…`;
}

/** Build one bounded message for as many deliverable completions as fit. */
export function buildProcessCompletionMessage(
	notices: ProcessCompletionNotice[],
	maxBytes = NOTIFY_BATCH_MAX_BYTES,
): ProcessCompletionMessage {
	if (notices.length === 0) throw new Error("At least one completion notice is required.");

	const totalCount = notices.length;
	const footer = `\n\n${COMPLETION_FOOTER}`;
	const header = (count: number) =>
		totalCount === 1
			? ""
			: count === totalCount
				? `${count} processes completed:\n\n`
				: `${count} of ${totalCount} processes completed:\n\n`;
	const deferred = (count: number) =>
		count < totalCount
			? `\n\n${totalCount - count} completion${totalCount - count === 1 ? "" : "s"} deferred to the next poll.`
			: "";
	const renderCompact = (batch: ProcessCompletionNotice[]) =>
		header(batch.length) +
		batch.map((notice) => `${notice.summary}\nLog: ${notice.logPath}`).join("\n\n") +
		deferred(batch.length) +
		footer;

	// If every summary and log path cannot fit, notify the largest fitting prefix
	// and leave the rest unacknowledged for a later poll. Always make progress for
	// pathological single ids/paths by delivering one UTF-8-truncated entry.
	let batch = notices;
	if (Buffer.byteLength(renderCompact(batch), "utf8") > maxBytes) {
		let low = 1;
		let high = notices.length - 1;
		let fittedCount = 0;
		while (low <= high) {
			const mid = Math.floor((low + high) / 2);
			if (Buffer.byteLength(renderCompact(notices.slice(0, mid)), "utf8") <= maxBytes) {
				fittedCount = mid;
				low = mid + 1;
			} else {
				high = mid - 1;
			}
		}
		batch = fittedCount > 0 ? notices.slice(0, fittedCount) : [notices[0]];
	}

	const blockBase = (notice: ProcessCompletionNotice) =>
		`${notice.summary}\nCommand: ${summarizeNotificationCommand(notice.command)}\nLog: ${notice.logPath}`;
	const outputs = batch.map((notice) =>
		notice.output.startsWith("\n\nOutput:") ? AGGREGATE_OUTPUT_OMISSION : notice.output,
	);
	const renderDetailed = () =>
		header(batch.length) +
		batch.map((notice, i) => blockBase(notice) + outputs[i]).join("\n\n") +
		deferred(batch.length) +
		footer;

	let content = renderDetailed();
	let contentBytes = Buffer.byteLength(content, "utf8");
	if (contentBytes <= maxBytes) {
		// Spend the remaining aggregate budget on complete inline outputs without
		// repeatedly rebuilding the entire batch for every candidate.
		for (let i = 0; i < batch.length; i++) {
			if (!batch[i].output.startsWith("\n\nOutput:")) continue;
			const delta =
				Buffer.byteLength(batch[i].output, "utf8") - Buffer.byteLength(outputs[i], "utf8");
			if (contentBytes + delta > maxBytes) continue;
			outputs[i] = batch[i].output;
			contentBytes += delta;
		}
		content = renderDetailed();
	} else {
		content = truncateUtf8End(renderCompact(batch), maxBytes);
	}

	const statuses = new Set(batch.map((notice) => notice.status));
	const status: CompletionStatus = statuses.has("failed")
		? "failed"
		: statuses.has("terminated")
			? "terminated"
			: "success";
	const processes = batch.map((notice) => ({
		id: notice.id,
		exitCode: notice.exitCode,
		success: notice.success,
		status: notice.status,
		runtime: notice.runtime,
		command: notice.command,
		logPath: notice.logPath,
	}));
	const single = totalCount === 1 ? batch[0] : undefined;
	return {
		customType: "pi-babysit-process-end",
		content,
		display: true,
		details: {
			id: single?.id,
			exitCode: single?.exitCode,
			success: batch.every((notice) => notice.success),
			status,
			runtime: single?.runtime,
			logPath: single?.logPath,
			command: single?.command,
			count: batch.length,
			totalCount,
			remainingCount: totalCount - batch.length,
			processes,
		},
	};
}

/** Send once and only acknowledge notices represented in the accepted batch. */
export function deliverProcessCompletionMessage(
	notices: ProcessCompletionNotice[],
	send: (
		message: ProcessCompletionMessage,
		options: { triggerTurn: true; deliverAs: "steer" },
	) => void,
	onSent: (notice: ProcessCompletionNotice) => void,
): boolean {
	if (notices.length === 0) return false;
	let message: ProcessCompletionMessage;
	try {
		message = buildProcessCompletionMessage(notices);
		send(message, { triggerTurn: true, deliverAs: "steer" });
	} catch {
		return false;
	}
	const deliveredIds = new Set(message.details.processes.map(({ id }) => id));
	for (const notice of notices) {
		if (deliveredIds.has(notice.id)) onSent(notice);
	}
	return true;
}

// ---------------------------------------------------------------------------
// parked-turn detection (shared rule with self-reap.ts)
// ---------------------------------------------------------------------------

// A turn that ends right after `babysit_run { command }` only means "parked
// awaiting the process-exit notification" — pi resumes it on its own; that is
// NOT task completion. Such runs stamp NOTIFY_MARKER into their tool result,
// so the marker in the LAST message's toolResult identifies a parked turn.
// (A subagent-profile run does NOT carry the marker: ending a turn to "wait"
// for a subagent is a guidance violation, and treating it as completion keeps
// the parent from hanging forever.) `process` is the legacy pi-processes tool.
function isParkedMessages(
	messages:
		| {
				role?: string;
				toolName?: string;
				content?: unknown;
				details?: { kind?: string; status?: string };
			}[]
		| undefined,
): boolean {
	if (!messages) return false;
	// Models sometimes add a short assistant note after starting a process. Scan
	// the run rather than requiring the marker-bearing tool result to be the last
	// message, otherwise that harmless note turns a parked build into false task
	// completion (and lets the self-reaper kill it).
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "toolResult") continue;
		if (message.toolName === "process") return true; // legacy pi-processes
		if (message.toolName !== "babysit_run") continue;
		if (message.details?.kind === "process" && message.details.status === "started") {
			return true;
		}
		const text = Array.isArray(message.content)
			? message.content
					.filter((part): part is { type: "text"; text: string } =>
						Boolean(part && typeof part === "object" && part.type === "text" && typeof part.text === "string"),
					)
					.map((part) => part.text)
					.join("")
			: typeof message.content === "string"
				? message.content
				: "";
		if (/^Process started \(id: [^)]+\)\. \[notify-on-exit\]\nLog: /.test(text)) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// parse a subagent's RPC event stream (from its babysit log)
// ---------------------------------------------------------------------------

interface ToolCall {
	name: string;
	summary: string;
}
export interface Progress {
	turns: number;
	/** Bounded recent calls for status rendering. */
	toolCalls: ToolCall[];
	/** Exact count, independent of the bounded recent-call ring. */
	toolCallCount: number;
	finalText: string;
	/** Best-effort text from the currently streaming assistant message. */
	streamingText: string;
	/** Context size reported by the most recent assistant response. */
	tokens?: number;
	/** Cumulative model usage for the current subagent task. */
	modelCalls: number;
	usageTokens: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens: number;
	cost: number;
	inputCost: number;
	outputCost: number;
	cacheReadCost: number;
	cacheWriteCost: number;
	errorMsg?: string;
	// RPC lifecycle bookkeeping (computed over the analyzed log slice):
	agentStarts: number;
	agentEnds: number;
	agentSettled: number;
	lastEndWasProcessWait: boolean;
	running: boolean; // an agent run is in flight right now
	waitingOnProcess: boolean; // idle, but a process resume is pending
	done: boolean; // task genuinely complete
}

function summarizeToolCall(name: string, args: Record<string, unknown>): string {
	const s = (v: unknown, n = 60) => {
		const str = String(v ?? "");
		return str.length > n ? `${str.slice(0, n - 1)}\u2026` : str;
	};
	switch (name) {
		case "bash":
			return `$ ${s(args.command)}`;
		case "read":
			return `read ${s(args.file_path ?? args.path)}`;
		case "write":
			return `write ${s(args.file_path ?? args.path)}`;
		case "edit":
			return `edit ${s(args.file_path ?? args.path)}`;
		case "grep":
			return `grep /${s(args.pattern, 40)}/`;
		case "find":
			return `find ${s(args.pattern ?? args.path, 40)}`;
		case "ls":
			return `ls ${s(args.path)}`;
		case "babysit_run":
			return `babysit ${s(args.command ?? args.task, 50)}`;
		default:
			return `${name} ${s(JSON.stringify(args), 40)}`;
	}
}

function emptyProgress(): Progress {
	return {
		turns: 0,
		toolCalls: [],
		toolCallCount: 0,
		finalText: "",
		streamingText: "",
		modelCalls: 0,
		usageTokens: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		cost: 0,
		inputCost: 0,
		outputCost: 0,
		cacheReadCost: 0,
		cacheWriteCost: 0,
		agentStarts: 0,
		agentEnds: 0,
		agentSettled: 0,
		lastEndWasProcessWait: false,
		running: false,
		waitingOnProcess: false,
		done: false,
	};
}

export function subagentBudgetViolation(
	progress: Progress,
	budget?: SubagentBudget,
): string | null {
	if (!budget) return null;
	if (budget.maxCost != null && progress.cost >= budget.maxCost) {
		return `cost $${progress.cost.toFixed(4)} reached maxCost $${budget.maxCost.toFixed(4)}`;
	}
	if (budget.maxTurns != null && progress.turns >= budget.maxTurns) {
		return `${progress.turns} turns reached maxTurns ${budget.maxTurns}`;
	}
	if (budget.maxToolCalls != null && progress.toolCallCount >= budget.maxToolCalls) {
		return `${progress.toolCallCount} tool calls reached maxToolCalls ${budget.maxToolCalls}`;
	}
	if (budget.maxUsageTokens != null && progress.usageTokens >= budget.maxUsageTokens) {
		return `${progress.usageTokens} usage tokens reached maxUsageTokens ${budget.maxUsageTokens}`;
	}
	return null;
}

export function subagentBudgetSoftViolation(
	progress: Progress,
	budget?: SubagentBudget,
	ratio = 0.8,
): string | null {
	if (!budget || ratio <= 0 || ratio >= 1) return null;
	if (budget.maxCost != null && progress.cost >= budget.maxCost * ratio) {
		return `cost $${progress.cost.toFixed(4)} reached ${Math.round(ratio * 100)}% of maxCost $${budget.maxCost.toFixed(4)}`;
	}
	if (budget.maxTurns != null && progress.turns >= Math.max(1, Math.ceil(budget.maxTurns * ratio))) {
		return `${progress.turns} turns reached ${Math.round(ratio * 100)}% of maxTurns ${budget.maxTurns}`;
	}
	if (
		budget.maxToolCalls != null &&
		progress.toolCallCount >= Math.max(1, Math.ceil(budget.maxToolCalls * ratio))
	) {
		return `${progress.toolCallCount} tool calls reached ${Math.round(ratio * 100)}% of maxToolCalls ${budget.maxToolCalls}`;
	}
	if (
		budget.maxUsageTokens != null &&
		progress.usageTokens >= Math.max(1, Math.ceil(budget.maxUsageTokens * ratio))
	) {
		return `${progress.usageTokens} usage tokens reached ${Math.round(ratio * 100)}% of maxUsageTokens ${budget.maxUsageTokens}`;
	}
	return null;
}

export function subagentBudgetAction(
	progress: Progress,
	budget: SubagentBudget | undefined,
	exceededAt: number | undefined,
	now: number,
	graceMs: number,
): { action: "none" | "steer" | "kill"; reason?: string } {
	const reason = subagentBudgetViolation(progress, budget);
	if (!reason) return { action: "none" };
	if (exceededAt == null) return { action: "steer", reason };
	return now - exceededAt >= graceMs
		? { action: "kill", reason }
		: { action: "none", reason };
}

function updateProgressState(progress: Progress): Progress {
	progress.running = progress.agentStarts > progress.agentEnds;
	progress.waitingOnProcess =
		!progress.running && progress.agentEnds > 0 && progress.lastEndWasProcessWait;
	// `agent_end` is not final: Pi may still retry, compact-and-retry, or process
	// queued continuations. `agent_settled` is the authoritative completion event.
	progress.done =
		!progress.running &&
		progress.agentSettled > 0 &&
		!progress.lastEndWasProcessWait;
	return progress;
}

function parseEventLine(progress: Progress, raw: string): void {
	const line = raw.replace(/\r$/, "").trim();
	if (!line.startsWith("{")) return;
	let event: Record<string, unknown>;
	try {
		event = JSON.parse(line);
	} catch {
		return; // partial trailing line, etc.
	}
	switch (event.type) {
		case "turn_start":
			progress.turns++;
			progress.streamingText = "";
			break;
		case "message_update": {
			const update = event.assistantMessageEvent as
				| { type?: string; delta?: string }
				| undefined;
			if (update?.type === "text_delta" && typeof update.delta === "string") {
				progress.streamingText = clip(progress.streamingText + update.delta, ANSWER_MAX_BYTES);
			}
			break;
		}
		case "tool_execution_start": {
			const name = String(event.toolName ?? "tool");
			progress.toolCallCount++;
			progress.toolCalls.push({
				name,
				summary: summarizeToolCall(name, (event.args as Record<string, unknown>) ?? {}),
			});
			// Open-ended workers must not retain an unbounded tool history in Pi.
			if (progress.toolCalls.length > 200) progress.toolCalls.splice(0, progress.toolCalls.length - 200);
			break;
		}
		case "message_end": {
			const message = event.message as
				| {
						role?: string;
						content?: { type: string; text?: string }[];
						stopReason?: string;
						errorMessage?: string;
						usage?: {
							input?: number;
							output?: number;
							cacheRead?: number;
							cacheWrite?: number;
							reasoning?: number;
							totalTokens?: number;
							cost?: {
								input?: number;
								output?: number;
								cacheRead?: number;
								cacheWrite?: number;
								total?: number;
							};
						};
					}
				| undefined;
			if (message?.role === "assistant") {
				const text = (message.content ?? [])
					.filter((content) => content.type === "text" && content.text)
					.map((content) => content.text)
					.join("");
				if (text.trim()) progress.finalText = clip(text, ANSWER_MAX_BYTES);
				if (message.stopReason === "error") {
					progress.errorMsg = message.errorMessage || "subagent model request failed";
				}
				progress.streamingText = "";
				if (message.usage) {
					const finite = (value: number | undefined) =>
						typeof value === "number" && Number.isFinite(value) ? value : 0;
					progress.modelCalls++;
					progress.tokens = message.usage.totalTokens;
					progress.usageTokens += finite(message.usage.totalTokens);
					progress.inputTokens += finite(message.usage.input);
					progress.outputTokens += finite(message.usage.output);
					progress.cacheReadTokens += finite(message.usage.cacheRead);
					progress.cacheWriteTokens += finite(message.usage.cacheWrite);
					progress.reasoningTokens += finite(message.usage.reasoning);
					progress.inputCost += finite(message.usage.cost?.input);
					progress.outputCost += finite(message.usage.cost?.output);
					progress.cacheReadCost += finite(message.usage.cost?.cacheRead);
					progress.cacheWriteCost += finite(message.usage.cost?.cacheWrite);
					progress.cost += finite(message.usage.cost?.total);
				}
			}
			break;
		}
		case "agent_start":
			progress.agentStarts++;
			break;
		case "agent_end": {
			progress.agentEnds++;
			progress.lastEndWasProcessWait =
				typeof event.piBabysitParked === "boolean"
					? event.piBabysitParked
					: isParkedMessages(
							event.messages as
								| {
										role?: string;
										toolName?: string;
										content?: unknown;
										details?: { kind?: string; status?: string };
									}[]
								| undefined,
						);
			break;
		}
		case "agent_settled":
			progress.agentSettled++;
			break;
		case "response":
			if (event.success === false) {
				progress.errorMsg = String(event.error ?? `rpc ${event.command ?? "command"} failed`);
			}
			break;
		case "error":
			progress.errorMsg = String(event.message ?? event.error ?? line);
			break;
		case "extension_error": {
			const extension = event.extensionPath ? `${String(event.extensionPath)}: ` : "";
			progress.errorMsg = `${extension}${String(event.error ?? "extension failed")}`;
			break;
		}
	}
}

export function parseEvents(logText: string): Progress {
	const progress = emptyProgress();
	for (const line of logText.split("\n")) parseEventLine(progress, line);
	return updateProgressState(progress);
}

export function buildSubagentDoneResult(
	progress: Progress,
): { body: string; ok: boolean } {
	const finalText = progress.finalText.trim();
	return {
		body: clip(
			progress.errorMsg
				? `Extension error: ${progress.errorMsg}` +
					(finalText ? `\n\n--- final answer ---\n${finalText}` : "")
				: finalText || "(no answer text)",
			ANSWER_MAX_BYTES,
		),
		ok: !progress.errorMsg,
	};
}

export function buildSubagentExitDiagnostic(
	progress: Progress,
	fullLogPath: string,
): string {
	const body = clip(
		progress.errorMsg ||
			progress.streamingText.trim() ||
			progress.finalText.trim() ||
			"(no structured error was emitted; inspect the full log)",
		ANSWER_MAX_BYTES,
	);
	return `${body}\n\nFull log: ${fullLogPath}`;
}

interface TaskProgressCache {
	base: number;
	offset: number;
	pending: Buffer;
	progress: Progress;
}
const taskProgressCache = new Map<string, TaskProgressCache>();

export function pruneTerminalSessionCache<T>(
	cache: Map<string, T>,
	sessions: Array<{ id: string; state: string }>,
): number {
	const running = new Set(
		sessions.filter((session) => session.state === "running").map((session) => session.id),
	);
	let removed = 0;
	for (const id of cache.keys()) {
		if (running.has(id)) continue;
		cache.delete(id);
		removed++;
	}
	return removed;
}

/** Parse only bytes appended since the previous observation of this task. */
function taskProgressOf(id: string): { progress: Progress; offset: number } {
	const base = readMeta(id)?.promptOffset ?? 0;
	const file = logPath(id);
	const size = fs.statSync(file).size;
	let cached = taskProgressCache.get(id);
	if (!cached || cached.base !== base || size < cached.offset) {
		cached = { base, offset: base, pending: Buffer.alloc(0), progress: emptyProgress() };
		taskProgressCache.set(id, cached);
	}
	if (size > cached.offset) {
		const added = Buffer.allocUnsafe(size - cached.offset);
		const fd = fs.openSync(file, "r");
		let read = 0;
		try {
			while (read < added.length) {
				const count = fs.readSync(fd, added, read, added.length - read, cached.offset + read);
				if (count === 0) break;
				read += count;
			}
		} finally {
			fs.closeSync(fd);
		}
		cached.offset += read;
		const bytes = cached.pending.length
			? Buffer.concat([cached.pending, added.subarray(0, read)])
			: added.subarray(0, read);
		let start = 0;
		for (let index = 0; index < bytes.length; index++) {
			if (bytes[index] !== 0x0a) continue;
			parseEventLine(cached.progress, bytes.subarray(start, index).toString("utf8"));
			start = index + 1;
		}
		cached.pending = Buffer.from(bytes.subarray(start));
	}
	updateProgressState(cached.progress);
	const currentMeta = readMeta(id);
	if (currentMeta?.budgetKilled && currentMeta.budgetReason) {
		cached.progress.errorMsg = `Subagent budget exceeded: ${currentMeta.budgetReason}`;
	}
	if (cached.progress.agentEnds > 0) {
		const meta = currentMeta;
		if (meta) cleanupMessageTempDirs(id, meta, cached.progress.agentEnds);
	}
	// If the writer was observed mid-record, let `babysit expect --since` start
	// before that partial line so a split agent_settled marker cannot be missed.
	return {
		progress: cached.progress,
		offset: cached.offset - cached.pending.length,
	};
}

// ---------------------------------------------------------------------------
// spawning — kind=process
// ---------------------------------------------------------------------------

// Friendly name → unique babysit session id (babysit ids allow [\w.-]).
const reservedSessionIds = new Set<string>();

async function reserveUniqueSessionId(name: string): Promise<string> {
	const base = name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "proc";
	const taken = new Set((await listSessions()).sessions.map((s) => s.id));
	for (const id of reservedSessionIds) taken.add(id);
	let id = base;
	for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
	reservedSessionIds.add(id);
	return id;
}

interface ProcOpts {
	name?: string;
	command: string;
	cwd: string;
	timeout?: string; // default: none — dev servers may run indefinitely
	idleTimeout?: string;
	pty: boolean;
	notificationGroup?: string;
}

async function spawnProcess(opts: ProcOpts): Promise<{ id: string } | { error: string }> {
	const bsArgs = ["run", "-d", "--json", "--size", "120x40"];
	if (!opts.pty) bsArgs.push("--no-tty");
	if (opts.timeout && opts.timeout !== "none") bsArgs.push("--timeout", opts.timeout);
	if (opts.idleTimeout && opts.idleTimeout !== "none")
		bsArgs.push("--idle-timeout", opts.idleTimeout);
	const reservedId = opts.name ? await reserveUniqueSessionId(opts.name) : undefined;
	if (reservedId) bsArgs.push("--id", reservedId);
	bsArgs.push("--", SHELL, "-c", opts.command);

	let r: Awaited<ReturnType<typeof bs>>;
	try {
		r = await bs(bsArgs, { cwd: opts.cwd });
	} finally {
		if (reservedId) reservedSessionIds.delete(reservedId);
	}
	if (r.code !== 0) {
		return {
			error:
				r.stderr || r.stdout ||
				`babysit run failed (exit ${r.code}, no output) — check that \`${BABYSIT_BIN}\` works and ${ROOT} is writable`,
		};
	}
	let id: string;
	try {
		id = JSON.parse(r.stdout).id;
	} catch {
		return { error: `could not parse id from: ${r.stdout}` };
	}
	writeMeta(id, {
		kind: "process",
		name: opts.name ?? id,
		command: opts.command,
		notificationGroup: opts.notificationGroup,
		notified: false,
		startedAt: Date.now(),
	});
	return { id };
}

// ---------------------------------------------------------------------------
// spawning — kind=subagent
// ---------------------------------------------------------------------------

function writePromptTempFile(agentName: string, prompt: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-babysit-"));
	const safe = agentName.replace(/[^\w.-]+/g, "_");
	const file = path.join(dir, `prompt-${safe}.md`);
	fs.writeFileSync(file, prompt, "utf-8");
	return file;
}

// RPC messages are injected into the subagent's PTY stdin via `babysit send`.
// A PTY input queue is tiny (~1KB canonical limit on macOS), so long messages
// get truncated/dropped, mangling the RPC JSON and silently breaking spawn.
// Anything over this budget is written to a file instead, and only a short
// "read this file" instruction travels through the PTY.
const PTY_SAFE_MESSAGE_BYTES = 600;
const messageNeedsReadTool = (text: string): boolean =>
	Buffer.byteLength(text, "utf-8") > PTY_SAFE_MESSAGE_BYTES;

interface DeliverableMessage {
	message: string;
	tempDir?: string;
}

function deliverableMessage(kind: "task" | "steering message", text: string): DeliverableMessage {
	if (!messageNeedsReadTool(text)) return { message: text };
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-babysit-msg-"));
	const file = path.join(dir, "message.md");
	fs.writeFileSync(file, text, "utf-8");
	return {
		message: `Your full ${kind} is in the file ${file} — read it with the Read tool FIRST, then carry it out exactly as written.`,
		tempDir: dir,
	};
}

function discardDelivery(delivery: DeliverableMessage): void {
	if (!delivery.tempDir) return;
	try {
		fs.rmSync(delivery.tempDir, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
}

interface SubagentOpts {
	name?: string;
	agent?: AgentConfig;
	task: string;
	model?: string;
	tools?: string[];
	cwd: string;
	depth: number;
	maxDepth: number;
	budget?: SubagentBudget;
	// Idle-timeout is OFF by default: an RPC-mode pi is silent while it works,
	// so idle detection would false-kill a busy subagent. The absolute timeout
	// is the safety valve instead.
	idleTimeout?: string;
	timeout: string;
}

async function spawnSubagent(
	opts: SubagentOpts,
): Promise<{ id: string; model?: string } | { error: string }> {
	// Long-lived RPC worker: the task is NOT passed as argv — it is injected
	// below as an RPC `prompt` command, whose response we validate so spawn
	// failures (bad model, missing API key) are loud instead of a silent exit=1.
	const piArgs: string[] = ["--mode", "rpc", "--no-session"];
	const model = opts.model ?? opts.agent?.model;
	if (model) piArgs.push("--model", model);
	const tools = opts.tools ?? opts.agent?.tools;
	if (messageNeedsReadTool(opts.task) && tools?.length && !tools.includes("read")) {
		return {
			error:
				"This task exceeds the PTY-safe inline limit and must be delivered through a file, " +
				"but the subagent tool allowlist excludes `read`. Add `read` or shorten the task.",
		};
	}
	if (tools && tools.length > 0) piArgs.push("--tools", tools.join(","));
	piArgs.push(
		"--append-system-prompt",
		subagentGuidance(
			opts.depth,
			opts.maxDepth,
			isAllowedDirectBash("") && (!tools || tools.includes("bash")),
			!tools || tools.includes("babysit_run"),
		),
	);
	let promptTempFile: string | undefined;
	if (opts.agent?.systemPrompt?.trim()) {
		promptTempFile = writePromptTempFile(opts.agent.name, opts.agent.systemPrompt);
		piArgs.push("--append-system-prompt", promptTempFile);
	}
	const cleanupPromptTemp = () => {
		if (!promptTempFile) return;
		try {
			fs.rmSync(path.dirname(promptTempFile), { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
		promptTempFile = undefined;
	};
	// Self-reaper: a finished subagent exits after a short idle grace instead of
	// lingering until the absolute --timeout. Cancelled by a follow-up task, and
	// it never reaps a turn parked on a process-exit notification. See self-reap.ts.
	piArgs.push("--extension", path.join(EXT_DIR, "self-reap.ts"));

	// A real PTY is used (NOT --no-tty): it lets a human `attach` and fully
	// take over the subagent.
	const bsArgs = [
		"run",
		"-d",
		"--json",
		"--size",
		"120x40",
		"--timeout",
		opts.timeout,
	];
	// Pretty-print the compact JSONL stream for humans who `attach`. The RPC
	// proxy retains authoritative message_end/response/error events and reduces
	// redundant lifecycle/tool payloads; parseEvents accepts both log formats.
	if (VIEW_CMD.trim()) bsArgs.push("--view-cmd", VIEW_CMD);
	if (opts.idleTimeout && opts.idleTimeout !== "none") {
		bsArgs.push("--idle-timeout", opts.idleTimeout);
	}
	const reservedId = opts.name ? await reserveUniqueSessionId(opts.name) : undefined;
	if (reservedId) bsArgs.push("--id", reservedId);
	bsArgs.push(
		"--",
		process.execPath,
		path.join(EXT_DIR, "rpc-stream-proxy.mjs"),
		"--",
		PI_BIN,
		...piArgs,
	);

	let r: Awaited<ReturnType<typeof bs>>;
	try {
		r = await bs(bsArgs, {
			cwd: opts.cwd,
			env: {
				[SUBAGENT_DEPTH_ENV]: String(opts.depth),
				[SUBAGENT_MAX_DEPTH_ENV]: String(opts.maxDepth),
			},
		});
	} finally {
		if (reservedId) reservedSessionIds.delete(reservedId);
	}
	if (r.code !== 0) {
		cleanupPromptTemp();
		return { error: r.stderr || r.stdout || `babysit run failed (exit ${r.code}, no output) — check that \`${BABYSIT_BIN}\` works and ${ROOT} is writable` };
	}
	let id: string;
	try {
		id = JSON.parse(r.stdout).id;
	} catch {
		cleanupPromptTemp();
		return { error: `could not parse id from: ${r.stdout}` };
	}

	// Stamp the kind IMMEDIATELY (with notified:true) so that if validation
	// below fails and we kill the session, the exit poller does NOT mistake it
	// for an un-notified process and fire a spurious process-end notification.
	// The success path overwrites this with the full task meta.
	writeMeta(id, {
		kind: "subagent",
		name: opts.name ?? id,
		task: opts.task,
		notified: true,
		depth: opts.depth,
		maxDepth: opts.maxDepth,
		budget: opts.budget,
	});

	// Wait for pi to boot (first JSON event in the log), then inject the task.
	// Pi has loaded --append-system-prompt before emitting that event, so the
	// anonymous prompt file can be removed immediately instead of leaking.
	const boot = await bs(["expect", "-s", id, "--timeout", "30s", '\\{"type"']);
	cleanupPromptTemp();
	if (boot.code !== 0) {
		await bs(["kill", "-s", id]);
		return {
			error: boot.code === 124
				? `subagent ${id} did not emit an RPC startup event within 30s`
				: boot.stderr || `subagent ${id} startup probe failed (code ${boot.code})`,
		};
	}
	const delivery = deliverableMessage("task", opts.task);
	const sent = await sendRpc(id, {
		type: "prompt",
		message: `Task: ${delivery.message}`,
	});
	if ("error" in sent) {
		discardDelivery(delivery);
		await bs(["kill", "-s", id]);
		return { error: `could not send task to subagent ${id}: ${sent.error}` };
	}
	// Validate the prompt was ACCEPTED (this is where "No API key found for …"
	// and similar config errors surface — fail the spawn loudly).
	const resp = await rpcResponse(id, sent.offset, "prompt", "60s");
	if (!resp.ok) {
		discardDelivery(delivery);
		await bs(["kill", "-s", id]);
		return { error: `subagent ${id} rejected the task: ${resp.error}` };
	}
	// Prompt acceptance does not guarantee provider authentication: Pi reports
	// failures that occur after acceptance through the event stream. Probe a short
	// window so immediate missing-key/config errors fail the spawn instead of
	// creating a zero-work worker that the caller must discover later.
	const startupProbe = await bs([
		"expect",
		"-s",
		id,
		"--since",
		String(resp.offset),
		"--timeout",
		"500ms",
		'(?m)^\\{"type":"(?:message_end|error|extension_error|agent_settled)"',
	]);
	if (startupProbe.code === 0) {
		try {
			const window = readLogWindowFrom(logPath(id), resp.offset);
			const initialProgress = parseEvents(window.bytes.toString("utf8"));
			if (initialProgress.errorMsg && initialProgress.modelCalls === 0) {
				discardDelivery(delivery);
				await bs(["kill", "-s", id]);
				return { error: `subagent ${id} failed before its first model response: ${initialProgress.errorMsg}` };
			}
		} catch {
			/* normal startup continues; the full stream remains available to check/wait */
		}
	}
	// Report the RESOLVED model (a fuzzy pattern may match something unexpected;
	// null means nothing resolved at all).
	let resolvedModel: string | undefined;
	const gs = await sendRpc(id, { type: "get_state" });
	if (!("error" in gs)) {
		const st = await rpcResponse(id, gs.offset, "get_state", "15s");
		if (st.ok && st.data) {
			const m = (st.data as { model?: { id?: string } | null }).model;
			if (m === null) {
				discardDelivery(delivery);
				await bs(["kill", "-s", id]);
				return {
					error: `subagent ${id} has no usable model${opts.model ? ` (requested "${opts.model}")` : ""} — check the model name with \`pi --list-models\`.`,
				};
			}
			resolvedModel = m?.id;
		}
	}

	writeMeta(id, {
		kind: "subagent",
		name: opts.name ?? id,
		task: opts.task,
		promptOffset: resp.offset,
		model: resolvedModel,
		tools,
		messageTempDirs: delivery.tempDir
			? [{ dir: delivery.tempDir, afterAgentEnd: 1 }]
			: undefined,
		depth: opts.depth,
		maxDepth: opts.maxDepth,
		budget: opts.budget,
		startedAt: Date.now(),
	});
	return { id, model: resolvedModel };
}

// ---------------------------------------------------------------------------
// widget (live counts)
// ---------------------------------------------------------------------------

// A subagent whose task is done stays alive as an idle RPC worker (for
// follow-ups), so "running" in babysit does NOT mean "working" — count
// processes / busy subagents / idle subagents separately.
export type WidgetSessionKind = "process" | "agent";
export type WidgetSessionState = "running" | "idle";

export function widgetSummaryText(procs: number, busy: number, idle: number): string {
	const sections: string[] = [];
	const running: string[] = [];
	if (procs > 0) running.push(`${procs} process${procs > 1 ? "es" : ""}`);
	if (busy > 0) running.push(`${busy} agent${busy > 1 ? "s" : ""}`);
	if (running.length > 0) sections.push(`RUNNING  ${running.join(" · ")}`);
	if (idle > 0) sections.push(`IDLE  ${idle} agent${idle > 1 ? "s" : ""}`);
	return sections.join("  │  ");
}

export function widgetSessionHeader(
	id: string,
	kind: WidgetSessionKind,
	state: WidgetSessionState,
	elapsed?: string,
): string {
	const icon = state === "running" ? "▶" : "○";
	return `  ${icon} ${id}  [${kind.toUpperCase()}] [${state.toUpperCase()}]${elapsed ? ` · age ${elapsed}` : ""}`;
}

function renderWidgetLines(procs: number, busy: number, idle: number, theme: Theme): string[] {
	if (procs === 0 && busy === 0 && idle === 0) return [];
	const sections: string[] = [];
	const running: string[] = [];
	if (procs > 0) running.push(`${procs} process${procs > 1 ? "es" : ""}`);
	if (busy > 0) running.push(`${busy} agent${busy > 1 ? "s" : ""}`);
	if (running.length > 0) {
		sections.push(`${theme.fg("success", theme.bold("RUNNING"))}  ${running.join(" · ")}`);
	}
	if (idle > 0) {
		sections.push(`${theme.fg("muted", theme.bold("IDLE"))}  ${idle} agent${idle > 1 ? "s" : ""}`);
	}
	return [theme.bg("toolPendingBg", ` ${sections.join("  │  ")} `)];
}

function renderWidgetSessionHeader(
	id: string,
	kind: WidgetSessionKind,
	state: WidgetSessionState,
	elapsed: string,
	theme: Theme,
): string {
	const running = state === "running";
	const icon = theme.fg(running ? "success" : "muted", running ? "▶" : "○");
	const kindLabel = theme.fg(kind === "process" ? "accent" : "warning", theme.bold(`[${kind.toUpperCase()}]`));
	const stateLabel = theme.fg(running ? "success" : "muted", theme.bold(`[${state.toUpperCase()}]`));
	return `  ${icon} ${id}  ${kindLabel} ${stateLabel}${elapsed ? theme.fg("dim", ` · age ${elapsed}`) : ""}`;
}

// How many trailing output lines to show per running session in the widget.
const WIDGET_TAIL_LINES = 1;
const WIDGET_TAIL_WIDTH = 100;

// Strip ANSI/control escapes and clamp width so raw PTY output can't wrap or
// corrupt the widget area.
function sanitizeTailLine(s: string): string {
	// PTY progress bars often redraw one logical line with carriage returns.
	// Keep the latest frame rather than concatenating every historical frame.
	const terminalFrame = s.split("\r").filter(Boolean).at(-1) ?? "";
	const clean = terminalFrame
		// CSI / OSC / other escape sequences
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b[@-Z\\-_]|\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		// remaining non-printable control chars (keep tab)
		.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
	return clean.length > WIDGET_TAIL_WIDTH ? `${clean.slice(0, WIDGET_TAIL_WIDTH - 1)}…` : clean;
}

function readTailLines(file: string, lines: number, maxBytes = 64_000): string[] {
	try {
		const size = fs.statSync(file).size;
		const start = Math.max(0, size - maxBytes);
		const length = size - start;
		const bytes = Buffer.allocUnsafe(length);
		const fd = fs.openSync(file, "r");
		let read = 0;
		try {
			while (read < length) {
				const count = fs.readSync(fd, bytes, read, length - read, start + read);
				if (count === 0) break;
				read += count;
			}
		} finally {
			fs.closeSync(fd);
		}
		const parts = bytes.subarray(0, read).toString("utf8").split("\n");
		if (start > 0) parts.shift(); // first fragment may begin mid-line
		return parts.slice(-Math.max(1, lines + 1));
	} catch {
		return [];
	}
}

// Trailing lines to show for a running session (sanitized, unprefixed).
// Process tails are read directly from the bounded end of output.log, avoiding
// one `babysit log` subprocess per active process on every poll.
async function widgetTail(
	id: string,
	isSub: boolean,
	subagentProgress?: Progress,
): Promise<string[]> {
	let raw: string[];
	if (!isSub) {
		raw = readTailLines(logPath(id), WIDGET_TAIL_LINES);
	} else {
		const progress = subagentProgress ?? taskProgressOf(id).progress;
		if (progress.finalText.trim()) {
			raw = progress.finalText.trim().split("\n");
		} else if (progress.toolCalls.length > 0) {
			raw = progress.toolCalls.map((tool) => tool.summary);
		} else {
			raw = progress.errorMsg ? [`⚠ ${progress.errorMsg}`] : [];
		}
	}
	return raw
		.map(sanitizeTailLine)
		.filter((line) => line.trim().length > 0)
		.slice(-WIDGET_TAIL_LINES);
}

// ---------------------------------------------------------------------------
// human take-over hint (no tmux dependency)
// ---------------------------------------------------------------------------

// The command a human can run in their OWN terminal/pane to take over a live
// process interactively (detach with Ctrl-\ Ctrl-\). `/babysit` shows this as a
// hint alongside an inline snapshot instead of spawning a tmux window itself.
function attachCmd(id: string): string {
	return `BABYSIT_DIR=${shq(ROOT)} ${shq(BABYSIT_BIN)} attach -s ${shq(id)}`;
}

// ---------------------------------------------------------------------------
// waiting
// ---------------------------------------------------------------------------

interface WaitOutcome {
	id: string;
	kind: "done" | "exited" | "timeout" | "interrupted";
	ok: boolean;
	text: string;
	status?: BsSession | null;
	progress?: Progress;
}

export interface NestedUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export function usageFromProgress(progress: Progress): NestedUsage | undefined {
	if (progress.modelCalls === 0) return undefined;
	return {
		input: progress.inputTokens,
		output: progress.outputTokens,
		cacheRead: progress.cacheReadTokens,
		cacheWrite: progress.cacheWriteTokens,
		totalTokens: progress.usageTokens,
		cost: {
			input: progress.inputCost,
			output: progress.outputCost,
			cacheRead: progress.cacheReadCost,
			cacheWrite: progress.cacheWriteCost,
			total: progress.cost,
		},
	};
}

/** Charge one completed task exactly once, even across concurrent wait callers. */
function claimOutcomeUsage(outcome: WaitOutcome): NestedUsage | undefined {
	if (!outcome.progress || (outcome.kind !== "done" && outcome.kind !== "exited")) return undefined;
	const usage = usageFromProgress(outcome.progress);
	if (!usage) return undefined;
	const meta = readMeta(outcome.id);
	if (meta?.kind !== "subagent") return undefined;
	const offset = meta.promptOffset ?? 0;
	if (meta.usageReportedOffset === offset) return undefined;

	// `open(..., "wx")` is the cross-process compare-and-set. A resumed Pi
	// session can briefly have overlapping extension processes; metadata alone
	// would let both read the old value and charge the same nested usage.
	const marker = path.join(metaDir(), `${outcome.id}.usage-${offset}.claimed`);
	if (!claimFileOnce(marker, JSON.stringify({ pid: process.pid, claimedAt: Date.now() }))) {
		return undefined;
	}
	meta.usageReportedOffset = offset;
	writeMeta(outcome.id, meta); // compatibility/display hint; marker is authoritative
	return usage;
}

function sumNestedUsage(values: Array<NestedUsage | undefined>): NestedUsage | undefined {
	const present = values.filter((value): value is NestedUsage => Boolean(value));
	if (present.length === 0) return undefined;
	return present.reduce<NestedUsage>(
		(total, value) => ({
			input: total.input + value.input,
			output: total.output + value.output,
			cacheRead: total.cacheRead + value.cacheRead,
			cacheWrite: total.cacheWrite + value.cacheWrite,
			totalTokens: total.totalTokens + value.totalTokens,
			cost: {
				input: total.cost.input + value.cost.input,
				output: total.cost.output + value.cost.output,
				cacheRead: total.cost.cacheRead + value.cost.cacheRead,
				cacheWrite: total.cost.cacheWrite + value.cost.cacheWrite,
				total: total.cost.total + value.cost.total,
			},
		}),
		{
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	);
}

// Wait for ONE subagent's current task. Completion = agent_settled without a
// parked babysit_run/process result (a parked run only means "waiting for
// process exit; pi will resume itself"). Parse appended bytes incrementally,
// then block on the next agent_settled via race-free byte offsets.
async function waitForTask(
	id: string,
	limitMs: number | null,
	signal?: AbortSignal,
): Promise<WaitOutcome> {
	const t0 = Date.now();

	for (;;) {
		let observed: { progress: Progress; offset: number };
		try {
			observed = taskProgressOf(id);
		} catch {
			observed = { progress: emptyProgress(), offset: readMeta(id)?.promptOffset ?? 0 };
		}
		const { progress: prog, offset: cur } = observed;
		const st = await statusOf(id);

		const stats =
			`turns=${prog.turns} calls=${prog.modelCalls} tools=${prog.toolCallCount}` +
			(prog.tokens != null ? ` ctx=${prog.tokens}` : "") +
			(prog.modelCalls > 0
				? ` usage=${prog.usageTokens} (in=${prog.inputTokens} out=${prog.outputTokens} cache=${prog.cacheReadTokens}) $${prog.cost.toFixed(4)}`
				: "");

		if (prog.done) {
			const completed = buildSubagentDoneResult(prog);
			return {
				id,
				kind: "done",
				ok: completed.ok,
				text:
					`Subagent ${id} finished its task (${stats}).\n` +
					`${SUBAGENT_REUSE_HINT} Follow-up: babysit_send { id: "${id}" }, ` +
					`or babysit_kill when done.\n\n${completed.body}`,
				status: st,
				progress: prog,
			};
		}

		if (!st || st.state !== "running") {
			// Never inject a raw RPC JSON tail into model context. Structured errors
			// are parsed above; the complete stream remains available at the log path.
			const diagnostic = buildSubagentExitDiagnostic(prog, logPath(id));
			return {
				id,
				kind: "exited",
				ok: false,
				text:
					`Subagent ${id} EXITED before completing the task ` +
					`(state=${st?.state ?? "missing"}, exit_code=${st?.exit_code ?? "?"}, ${stats}).\n\n` +
					diagnostic,
				status: st,
				progress: prog,
			};
		}

		const timeoutOutcome = (): WaitOutcome => ({
			id,
			kind: "timeout",
			ok: false,
			text:
				`⏱ wait timed out; subagent ${id} still ` +
				`${prog.waitingOnProcess ? "waiting on a background process" : "working"} (${stats}).`,
			status: st,
			progress: prog,
		});

		// Still working — block until Pi declares the run fully settled. Unlike
		// agent_end, this cannot fire before an automatic retry/compaction retry.
		let expectTimeout = "0"; // indefinite
		if (limitMs != null) {
			const remaining = limitMs - (Date.now() - t0);
			if (remaining <= 0) return timeoutOutcome();
			expectTimeout = `${Math.ceil(remaining / 1000)}s`;
		}
		const e = await bs(
			["expect", "-s", id, "--since", String(cur), "--timeout", expectTimeout, '"type":"agent_settled"'],
			{ signal },
		);
		if (signal?.aborted || e.code === 130) {
			return {
				id,
				kind: "interrupted",
				ok: false,
				text: `wait for ${id} was interrupted.`,
				status: st,
				progress: prog,
			};
		}
		if (e.code === 124) return timeoutOutcome();
		// e.code !== 0 (session likely exited mid-wait) falls through to the
		// next loop iteration, where the exited branch reports the cause.
		if (e.code !== 0) {
			await new Promise((res) => setTimeout(res, 500));
		}
	}
}

// Mark a session as already reported so completion pollers do not send a
// duplicate message for something the agent just observed.
function suppressNotify(id: string, reason: "observed" | "kill" = "observed"): void {
	const meta = readMeta(id);
	if (!meta) return;
	if (meta.kind === "process") {
		meta.notified = true;
		if (reason === "kill") meta.killNotificationSuppressed = true;
		delete meta.notificationPaused;
	} else {
		meta.subagentCollectedOffset = meta.promptOffset ?? 0;
	}
	writeMeta(id, meta);
}

function collectSubagentOutcome(outcome: WaitOutcome): void {
	if (outcome.kind !== "done" && outcome.kind !== "exited") return;
	const meta = readMeta(outcome.id);
	if (!meta || meta.kind !== "subagent") return;
	meta.subagentCollectedOffset = meta.promptOffset ?? 0;
	writeMeta(outcome.id, meta);
}

export interface WaitReservationState {
	notified?: boolean;
	killNotificationSuppressed?: boolean;
	waitReservations?: number;
	waitCompletionClaimed?: boolean;
}

export function canRestoreNotificationAfterWait(meta: WaitReservationState): boolean {
	return (
		meta.notified === true &&
		meta.killNotificationSuppressed !== true &&
		meta.waitCompletionClaimed !== true &&
		(meta.waitReservations ?? 0) === 0
	);
}

export function transitionWaitReservation(
	state: WaitReservationState,
	action: "reserve" | "abandon" | "claim",
): WaitReservationState {
	const next = { ...state };
	if (action === "reserve") {
		next.waitReservations = (next.waitReservations ?? 0) + 1;
		next.notified = true;
		return next;
	}

	next.waitReservations = Math.max(0, (next.waitReservations ?? 0) - 1);
	if (action === "claim") next.waitCompletionClaimed = true;
	if (action === "claim" || next.waitCompletionClaimed) {
		next.notified = true;
	} else if (canRestoreNotificationAfterWait(next)) {
		next.notified = false;
	}
	return next;
}

function updateWaitReservation(id: string, action: "reserve" | "abandon" | "claim"): void {
	const meta = readMeta(id);
	if (!meta || meta.kind !== "process") return;
	writeMeta(id, { ...meta, ...transitionWaitReservation(meta, action) });
}

function pauseNotify(id: string): void {
	const meta = readMeta(id);
	if (meta && meta.kind === "process" && !meta.notificationPaused) {
		meta.notificationPaused = true;
		writeMeta(id, meta);
	}
}

function resumeNotify(id: string): void {
	const meta = readMeta(id);
	if (meta && meta.kind === "process" && meta.notificationPaused) {
		delete meta.notificationPaused;
		writeMeta(id, meta);
	}
}

// Wait for a PROCESS session: either until a regex appears in its output
// (`expect` — e.g. "server listening") or until the process exits.
async function waitForExit(
	id: string,
	limitMs: number | null,
	signal?: AbortSignal,
	expectPattern?: string,
	outputSelection?: ProcessOutputSelection,
): Promise<WaitOutcome> {
	const t = limitMs != null ? `${Math.ceil(limitMs / 1000)}s` : "0";

	if (expectPattern) {
		const e = await bs(["expect", "-s", id, "--timeout", t, expectPattern], { signal });
		if (signal?.aborted) {
			return { id, kind: "interrupted", ok: false, text: `wait for ${id} was interrupted.` };
		}
		if (e.code === 130) {
			const interruptedStatus = await statusOf(id);
			if (interruptedStatus?.state === "running") {
				return { id, kind: "interrupted", ok: false, text: `wait for ${id} was interrupted.` };
			}
		}
		if (e.code === 0) {
			return {
				id,
				kind: "done",
				ok: true,
				text: `Pattern /${expectPattern}/ matched in ${id} output (process still running).\nLog: ${logPath(id)}`,
			};
		}
		const st0 = await statusOf(id);
		if (e.code === 124 && st0?.state === "running") {
			return {
				id,
				kind: "timeout",
				ok: false,
				text: `⏱ wait timed out; /${expectPattern}/ not seen in ${id} output yet (still running).`,
				status: st0,
			};
		}
		// fall through: session exited before the pattern appeared
	} else {
		// An explicit wait owns completion delivery. Reference-count the claim so
		// one concurrent wait timing out cannot re-enable notifications underneath
		// another wait that is still pending.
		updateWaitReservation(id, "reserve");
		let w: Awaited<ReturnType<typeof bs>>;
		let attempt = 0;
		for (;;) {
			w = await bs(["wait", "-s", id, "--timeout", t], { signal });
			if (signal?.aborted) {
				updateWaitReservation(id, "abandon");
				return { id, kind: "interrupted", ok: false, text: `wait for ${id} was interrupted.` };
			}
			if (w.code === 0 || w.code === 124 || w.code === 130) break;

			// A freshly spawned session can be visible in `list` before the backend's
			// wait endpoint is ready, especially when sibling foreground tools start
			// concurrently. Retry that transient startup race instead of reporting the
			// still-running child as "exited with code ?".
			const retryStatus = await statusOf(id);
			if (retryStatus?.state !== "running" || attempt++ >= 3) break;
			await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
		}
		if (w.code === 130) {
			const interruptedStatus = await statusOf(id);
			if (interruptedStatus?.state === "running") {
				updateWaitReservation(id, "abandon");
				return { id, kind: "interrupted", ok: false, text: `wait for ${id} was interrupted.` };
			}
		}
		if (w.code === 124) {
			// 124 is ambiguous (timeout vs child exiting 124) — disambiguate.
			const st0 = await statusOf(id);
			if (st0?.state === "running") {
				updateWaitReservation(id, "abandon");
				return {
					id,
					kind: "timeout",
					ok: false,
					text: `⏱ wait timed out; process ${id} is still running.`,
					status: st0,
				};
			}
		}
	}

	const statusLookup = await lookupStatus(id);
	if (statusLookup.error) {
		// The registry could not be read, so do not convert a transient backend
		// failure into a missing session or permanently claim its notification.
		if (!expectPattern) updateWaitReservation(id, "abandon");
		return {
			id,
			kind: "interrupted",
			ok: false,
			text: `Could not verify ${id} after waiting: ${statusLookup.error}`,
		};
	}
	const st = statusLookup.session;
	if (!st) {
		if (!expectPattern) updateWaitReservation(id, "claim");
		return { id, kind: "exited", ok: false, text: `No such session: ${id}` };
	}
	if (st.state === "running") {
		if (!expectPattern) updateWaitReservation(id, "abandon");
		return {
			id,
			kind: "interrupted",
			ok: false,
			text:
				`The wait backend returned before process ${id} exited; the process is still running. ` +
				`Use babysit_wait to continue waiting.\nLog: ${logPath(id)}`,
			status: st,
		};
	}
	if (expectPattern) suppressNotify(id);
	else updateWaitReservation(id, "claim"); // the agent sees the exit here; don't notify again
	const meta = readMeta(id);
	const workerDead = st.state === "dead" && st.exit_code == null;
	const ok = st.exit_code === 0;
	const output = await selectedProcessOutput(id, st, outputSelection, signal);
	return {
		id,
		kind: "exited",
		ok,
		text:
			`Process ${id}${meta?.command ? ` (${summarizeNotificationCommand(meta.command)})` : ""} ` +
			(workerDead
				? "worker-dead: the babysit supervisor disappeared without an exit status"
				: ok ? "completed successfully" : `exited with code ${st.exit_code ?? "?"}`) +
			`${expectPattern ? ` before /${expectPattern}/ appeared` : ""}.` +
			(workerDead
				? " The supervisor disappeared without recording an exit; possible causes include host process cleanup, endpoint security, or a supervisor crash. The command may have started, so retry only if it is safe and idempotent."
				: "") +
			`\nLog: ${logPath(id)}` + output,
		status: st,
	};
}

const waitFor = (
	id: string,
	limitMs: number | null,
	signal?: AbortSignal,
	expectPattern?: string,
): Promise<WaitOutcome> =>
	kindOf(id) === "subagent"
		? waitForTask(id, limitMs, signal)
		: waitForExit(id, limitMs, signal, expectPattern);

// ---------------------------------------------------------------------------
// direct bash policy
// ---------------------------------------------------------------------------

// Heuristic (no shell AST): catch `... &` backgrounding (not `&&`), nohup,
// setsid, and disown — those should go through babysit_run instead.
function backgroundsItself(command: string): boolean {
	const stripped = command.replace(/#[^\n]*/g, "").trimEnd();
	if (/(^|[^&])&\s*$/.test(stripped)) return true;
	if (/(^|[;&|]\s*)(nohup|setsid)\s/.test(stripped)) return true;
	if (/\bdisown\b/.test(stripped)) return true;
	return false;
}

/** Emergency escape hatch only. All ordinary shell commands go through babysit_run. */
export function isAllowedDirectBash(_command: string): boolean {
	return process.env.PI_BABYSIT_ALLOW_BASH === "1";
}

export function activeToolsWithoutDirectBash(activeTools: string[], allowDirectBash: boolean): string[] {
	return allowDirectBash ? activeTools : activeTools.filter((name) => name !== "bash");
}

export function automaticNotificationGroup(entry: unknown): string | undefined {
	const candidate = entry as {
		id?: unknown;
		type?: unknown;
		message?: { role?: unknown; content?: unknown };
	};
	if (
		candidate?.type !== "message" ||
		candidate.message?.role !== "assistant" ||
		typeof candidate.id !== "string" ||
		!Array.isArray(candidate.message.content)
	) {
		return undefined;
	}
	const group = `turn-${candidate.id}`;
	const runs = candidate.message.content.filter((part) => {
		if (!part || typeof part !== "object") return false;
		const call = part as {
			type?: unknown;
			name?: unknown;
			arguments?: Record<string, unknown>;
		};
		if (call.type !== "toolCall" || call.name !== "babysit_run") return false;
		const args = call.arguments ?? {};
		const existing = typeof args.notificationGroup === "string"
			? args.notificationGroup.trim()
			: "";
		return (
			typeof args.command === "string" &&
			args.command.length > 0 &&
			args.profile !== "subagent" &&
			args.foreground !== true &&
			(existing === "" || existing === group)
		);
	});
	return runs.length >= 2 ? group : undefined;
}

export function resolveSubagentSendMode(
	requested: "auto" | "steer" | "task",
	streaming?: boolean,
	currentTaskDone?: boolean,
): { mode: "steer" | "task" } | { error: "busy" | "unknown" | "unsettled" } {
	if (requested === "steer") return { mode: "steer" };
	if (requested === "auto") {
		return { mode: streaming === false && currentTaskDone === true ? "task" : "steer" };
	}
	if (streaming === true) return { error: "busy" };
	if (streaming === undefined || currentTaskDone === undefined) return { error: "unknown" };
	if (!currentTaskDone) return { error: "unsettled" };
	return { mode: "task" };
}

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let pollNeeded = true;
	let automaticGcRan = false;
	let rootLeasePath: string | undefined;
	const declaredToolErrors = new Set<string>();
	const sessionRpcTails = new Map<string, Promise<void>>();

	async function withSessionRpcLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
		const previous = sessionRpcTails.get(id) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.then(() => gate);
		sessionRpcTails.set(id, tail);
		await previous;
		try {
			return await operation();
		} finally {
			release();
			if (sessionRpcTails.get(id) === tail) sessionRpcTails.delete(id);
		}
	}

	// Pi only persists custom-tool failures when they are thrown or patched by a
	// tool_result hook; an `isError` property returned from execute() is ignored.
	// Keep the structured result (status, log path, diagnostics) while promoting
	// its declared error bit at the supported hook boundary.
	const registerTool = <TParams extends TSchema>(
		tool: ToolDefinition<TParams, unknown, unknown>,
	): void => {
		const execute = tool.execute;
		pi.registerTool({
			...tool,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const result = await execute(toolCallId, params, signal, onUpdate, ctx);
				if ((result as typeof result & { isError?: boolean }).isError === true) {
					declaredToolErrors.add(toolCallId);
				}
				return result;
			},
		});
	};

	pi.on("tool_result", (event) => {
		if (declaredToolErrors.delete(event.toolCallId)) return { isError: true };
	});

	async function enforceSubagentBudgets(sessions: BsSession[]): Promise<void> {
		// Independent workers must not serialize 3-second RPC probes and delay
		// unrelated completion notifications. Per-session RPC locks still preserve
		// ordering within each worker.
		await Promise.all(
			sessions
				.filter((session) => session.state === "running")
				.map((session) =>
					withSessionRpcLock(session.id, async () => {
						const meta = readMeta(session.id);
						if (meta?.kind !== "subagent" || !meta.budget || meta.budgetKilled) return;

						let progress: Progress;
						try {
							progress = taskProgressOf(session.id).progress;
						} catch {
							return;
						}
						if (progress.done) return;
						const now = Date.now();
						const hardReason = subagentBudgetViolation(progress, meta.budget);
						const softReason = subagentBudgetSoftViolation(progress, meta.budget);

						if (hardReason) {
							if (meta.budgetExceededAt == null) {
								// The hard grace begins when the violation is observed, even if a
								// wedged worker never accepts steering. This makes the cap enforceable.
								meta.budgetExceededAt = now;
								meta.budgetReason = hardReason;
								writeMeta(session.id, meta);
								const latestStatus = await statusOf(session.id);
								if (latestStatus?.state !== "running") return;
								const sent = await sendRpc(session.id, {
									type: "steer",
									message: `Hard budget reached (${hardReason}). Stop calling tools and return your best answer now.`,
								});
								if (!("error" in sent)) await rpcResponse(session.id, sent.offset, "steer", "3s");
								return;
							}
							if (now - meta.budgetExceededAt < SUBAGENT_BUDGET_GRACE_MS) return;
							const latestStatus = await statusOf(session.id);
							if (latestStatus?.state !== "running") return;
							const killed = await bs(["kill", "-s", session.id, "--json"]);
							if (killed.code !== 0) return;
							const terminal = await awaitConfirmedTermination(session.id);
							const current = readMeta(session.id);
							if (
								terminal &&
								isConfirmedTerminalState(terminal.state) &&
								current?.kind === "subagent" &&
								current.promptOffset === meta.promptOffset &&
								current.budgetExceededAt === meta.budgetExceededAt
							) {
								current.budgetKilled = true;
								current.budgetReason = current.budgetReason ?? hardReason;
								writeMeta(session.id, current);
							}
							return;
						}

						if (!softReason || meta.budgetWarnedAt != null) return;
						const latestStatus = await statusOf(session.id);
						if (latestStatus?.state !== "running") return;
						const sent = await sendRpc(session.id, {
							type: "steer",
							message: `Budget is approaching its limit (${softReason}). Wrap up now and preserve your best findings.`,
						});
						if ("error" in sent) return;
						const accepted = await rpcResponse(session.id, sent.offset, "steer", "3s");
						if (!accepted.ok) return;
						const current = readMeta(session.id);
						if (
							current?.kind === "subagent" &&
							current.promptOffset === meta.promptOffset &&
							current.budgetWarnedAt == null
						) {
							current.budgetWarnedAt = now;
							current.budgetWarningReason = softReason;
							writeMeta(session.id, current);
						}
					}),
				),
		);
	}

	// Exit notifications for kind=process sessions: the poller detects
	// running→exited transitions and injects ONE message (triggerTurn) for all
	// processes that became deliverable in the same poll. This resumes an agent
	// that ended its turn after babysit_run without spending one turn per exit.
	// Kills via babysit_kill and exits already reported by babysit_wait are
	// suppressed via meta.notified.
	async function notifyEndedProcesses(
		ctx: ExtensionContext,
		snapshot?: BsSession[],
	): Promise<void> {
		// Never steer a completion into an active agent turn. In particular, this
		// lets an immediately-following babysit_wait reserve the completion first,
		// instead of racing the poller and receiving both wait + auto notification.
		if (shouldDeferCompletionNotification(ctx.isIdle())) return;
		const sessions = snapshot ?? (await listSessions()).sessions;
		const ready: Array<{ session: BsSession; meta: Meta }> = [];
		for (const session of sessions) {
			if (session.state === "running") continue;
			const meta = readMeta(session.id);
			if (!shouldDeliverProcessCompletion(meta)) continue;
			// A notification group is delivered only after all currently known
			// members have stopped, even when their exit times span many polls.
			if (!isNotificationGroupReady(meta, sessions, readMeta)) continue;
			// Delay delivery by one poll interval. This gives an agent that chose
			// babysit_wait immediately after babysit_run enough time to claim the
			// completion and suppress the otherwise duplicate automatic message.
			if (!meta.completionObservedAt) {
				meta.completionObservedAt = Date.now();
				writeMeta(session.id, meta);
				continue;
			}
			if (Date.now() - meta.completionObservedAt < POLL_MS) continue;
			ready.push({ session, meta });
		}

		const prepared: ProcessCompletionNotice[] = [];
		for (const { session, meta } of ready) {
			const ok = session.exit_code === 0;
			const status: CompletionStatus = ok
				? "success"
				: session.state === "dead" || session.exit_code == null
					? "terminated"
					: "failed";
			const output = await inlineOutput(session.id, session, NOTIFY_OUTPUT_MAX_BYTES);
			const runtime = meta.startedAt
				? `${Math.round(((meta.completionObservedAt ?? Date.now()) - meta.startedAt) / 1000)}s`
				: "?";
			const summary = ok
				? `Process "${session.id}" completed successfully after ${runtime}.`
				: session.state === "dead" || session.exit_code == null
					? `Process "${session.id}" was terminated after ${runtime}.`
					: `Process "${session.id}" exited with code ${session.exit_code} after ${runtime}.`;
			prepared.push({
				id: session.id,
				exitCode: session.exit_code,
				success: ok,
				status,
				runtime,
				summary,
				command: meta.command,
				logPath: logPath(session.id),
				output,
			});
		}

		if (prepared.length === 0) return;

		// Output loading above is asynchronous. Refresh sessions and metadata
		// immediately before the single send so concurrent wait/kill calls and newly
		// started notification-group members are honored.
		const refreshed = await listSessions();
		if (refreshed.error) return;
		const finalSessions = refreshed.sessions;
		const metadataById = new Map<string, Meta>();
		const notices = prepared.flatMap((notice) => {
			const current = readMeta(notice.id);
			if (!shouldDeliverProcessCompletion(current)) return [];
			if (!isNotificationGroupReady(current, finalSessions, readMeta)) return [];
			metadataById.set(notice.id, current);
			return [{ ...notice, command: current.command }];
		});
		// Output collection above yields to the event loop. Re-check idleness so a
		// newly-started agent turn cannot receive a duplicate completion mid-turn.
		if (shouldDeferCompletionNotification(ctx.isIdle())) return;
		deliverProcessCompletionMessage(
			notices,
			(message, options) => pi.sendMessage(message, options),
			(notice) => {
				const meta = metadataById.get(notice.id);
				if (!meta) return;
				meta.notified = true;
				delete meta.notificationPaused;
				writeMeta(notice.id, meta);
			},
		);
	}

	async function notifySettledSubagents(
		ctx: ExtensionContext,
		snapshot?: BsSession[],
	): Promise<void> {
		if (shouldDeferCompletionNotification(ctx.isIdle())) return;
		const sessions = snapshot ?? (await listSessions()).sessions;
		const ready: Array<{ id: string; offset: number; state: string; summary: string }> = [];
		for (const session of sessions) {
			const meta = readMeta(session.id);
			if (!shouldDeliverSubagentCompletion(meta)) continue;
			let progress: Progress;
			try {
				progress = taskProgressOf(session.id).progress;
			} catch {
				progress = emptyProgress();
			}
			if (session.state === "running" && !progress.done) continue;

			const offset = meta.promptOffset ?? 0;
			if (meta.subagentCompletionObservedOffset !== offset) {
				meta.subagentCompletionObservedOffset = offset;
				meta.subagentCompletionObservedAt = Date.now();
				writeMeta(session.id, meta);
				continue;
			}
			if (Date.now() - (meta.subagentCompletionObservedAt ?? 0) < POLL_MS) continue;
			const summary = progress.done
				? `task settled; ${progress.turns} turns, ${progress.toolCallCount} tools, $${progress.cost.toFixed(4)}`
				: `worker ${session.state} with exit code ${session.exit_code ?? "?"}; partial usage $${progress.cost.toFixed(4)}`;
			ready.push({ id: session.id, offset, state: session.state, summary });
		}
		if (ready.length === 0 || shouldDeferCompletionNotification(ctx.isIdle())) return;

		const deliverable = ready.filter(({ id, offset }) => {
			const meta = readMeta(id);
			return shouldDeliverSubagentCompletion(meta) && (meta.promptOffset ?? 0) === offset;
		});
		if (deliverable.length === 0) return;
		pi.sendMessage(
			{
				customType: "pi-babysit-subagent-ready",
				content:
					`${deliverable.length === 1 ? "A background subagent is" : `${deliverable.length} background subagents are`} ready to collect:\n` +
					deliverable.map(({ id, summary }) => `- ${id}: ${summary}`).join("\n") +
					"\nCall babysit_wait now to retrieve the answer and charge nested usage before finishing the parent task.",
				display: true,
				details: { subagents: deliverable.map(({ id, state }) => ({ id, state })) },
			},
			{ triggerTurn: true, deliverAs: "steer" },
		);
		for (const { id, offset } of deliverable) {
			const meta = readMeta(id);
			if (!meta || meta.kind !== "subagent" || (meta.promptOffset ?? 0) !== offset) continue;
			meta.subagentNotifiedOffset = offset;
			writeMeta(id, meta);
		}
	}

	const refreshWidget = async (ctx: ExtensionContext, snapshot?: BsSession[]) => {
		if (!ctx.hasUI) return;
		const active = (snapshot ?? (await listSessions()).sessions).filter(
			(session) => session.state === "running",
		);
		const subs = active.filter((session) => kindOf(session.id) === "subagent");
		const procs = active.length - subs.length;
		const progressById = new Map<string, Progress>();
		for (const subagent of subs) {
			try {
				progressById.set(subagent.id, taskProgressOf(subagent.id).progress);
			} catch {
				progressById.set(subagent.id, emptyProgress());
			}
		}
		const idle = subs.filter((session) => progressById.get(session.id)?.done).length;
		const theme = ctx.ui.theme;
		const lines = renderWidgetLines(procs, subs.length - idle, idle, theme);
		const tails = await Promise.all(
			active.map((session) => {
				const isSubagent = kindOf(session.id) === "subagent";
				return widgetTail(
					session.id,
					isSubagent,
					isSubagent ? progressById.get(session.id) : undefined,
				);
			}),
		);
		active.forEach((session, index) => {
			const isSubagent = kindOf(session.id) === "subagent";
			const state: WidgetSessionState = isSubagent && progressById.get(session.id)?.done
				? "idle"
				: "running";
			const elapsed = elapsedOf(session.id);
			const header = renderWidgetSessionHeader(
				session.id,
				isSubagent ? "agent" : "process",
				state,
				elapsed,
				theme,
			);
			if (tails[index].length === 1) {
				lines.push(`${header}  │ ${tails[index][0]}`);
			} else {
				lines.push(header);
				for (const tail of tails[index]) lines.push(`     │ ${tail}`);
			}
		});
		ctx.ui.setWidget("pi-babysit", lines, { placement: "belowEditor" });
	};

	type DisplayStatus = "started" | "running" | "idle" | "success" | "failed" | "terminated";
	const renderStatus = (status: DisplayStatus, theme: Theme, prefix?: string): string => {
		const labels: Record<
			DisplayStatus,
			{ icon: string; text: string; color: "accent" | "warning" | "success" | "error" }
		> = {
			started: { icon: "", text: "STARTED", color: "accent" },
			running: { icon: "", text: "RUNNING", color: "accent" },
			idle: { icon: "", text: "IDLE", color: "warning" },
			success: { icon: "", text: "SUCCESS", color: "success" },
			failed: { icon: "", text: "FAILED", color: "error" },
			terminated: { icon: "", text: "TERMINATED", color: "error" },
		};
		const label = labels[status];
		const text = prefix ? `${prefix} ${label.text}` : label.text;
		const decorated = label.icon ? `${label.icon} ${text}` : text;
		return theme.fg(label.color, theme.bold(decorated));
	};
	const outcomeStatus = (outcome: WaitOutcome): DisplayStatus =>
		outcome.ok
			? "success"
			: outcome.status &&
					(outcome.status.state === "dead" || outcome.status.exit_code == null)
				? "terminated"
				: "failed";

	// Render snapshots and subagent answers INLINE in the transcript as formatted
	// markdown, with a semantic status label that remains readable on any theme.
	pi.registerMessageRenderer("pi-babysit-result", (message, _opts, theme) => {
		const d = (message.details ?? {}) as {
			title?: string;
			body?: string;
			status?: DisplayStatus;
		};
		const body =
			d.body ?? (typeof message.content === "string" ? message.content : "");
		const box = new Box(1, 0, (t) => theme.bg("toolSuccessBg", t));
		if (d.status) box.addChild(new Text(renderStatus(d.status, theme), 0, 0));
		if (d.title) box.addChild(new Text(theme.fg("accent", d.title), 0, 0));
		box.addChild(new Markdown(body, 0, 0, getMarkdownTheme()));
		return box;
	});

	// Process-end notification rendering with a colored lifecycle label. Keep the
	// box background subtle: coloring a potentially large log excerpt is noisy.
	pi.registerMessageRenderer("pi-babysit-process-end", (message, _opts, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		const d = (message.details ?? {}) as {
			status?: DisplayStatus;
			success?: boolean;
			exitCode?: number | null;
			command?: string;
			count?: number;
		};
		const status =
			d.status ?? (d.success ? "success" : d.exitCode == null ? "terminated" : "failed");
		const payload = d.command
			? `  ${summarizeNotificationCommand(d.command)}`
			: d.count && d.count > 1
				? `  ×${d.count}`
				: "";
		const header = theme.fg("warning", theme.bold(`babysit_run COMMAND${payload}`));
		const box = new Box(1, 1, (t) => theme.bg("toolSuccessBg", t));
		box.addChild(new Text(header, 0, 0));
		box.addChild(new Text(renderStatus(status, theme), 0, 0));
		box.addChild(new Text(theme.fg("toolOutput", content), 0, 0));
		return box;
	});

	let polling = false;
	pi.on("session_start", async (_event, ctx) => {
		// Do not expose the built-in bash tool only to reject it after the model has
		// already paid for a failed tool turn. The tool_call hook remains a fallback
		// if another extension/preset re-enables bash later in the session.
		const activeTools = pi.getActiveTools();
		const supervisedTools = activeToolsWithoutDirectBash(
			activeTools,
			isAllowedDirectBash(""),
		);
		if (supervisedTools.length !== activeTools.length) pi.setActiveTools(supervisedTools);

		// Session-local registry: scope the babysit root to this pi session so
		// other sessions' processes/subagents are invisible here. Resuming a
		// session keeps the same id, so its sessions come back with it.
		releaseRootLease(rootLeasePath);
		try {
			ROOT = path.join(ROOT_BASE, ctx.sessionManager.getSessionId());
		} catch {
			ROOT = ROOT_BASE;
		}
		rootLeasePath = acquireRootLease(ROOT) ?? undefined;
		if (!rootLeasePath) {
			const desiredRoot = ROOT;
			ROOT = `${desiredRoot}-active-${process.pid}-${Date.now()}`;
			rootLeasePath = acquireRootLease(ROOT) ?? undefined;
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Babysit GC was busy for ${desiredRoot}; using an isolated root for this run.`,
					"warning",
				);
			}
		}
		taskProgressCache.clear();
		searchLogCache.clear();
		pollNeeded = true;
		const retentionDays = Number(process.env.PI_BABYSIT_RETENTION_DAYS ?? "3");
		if (
			!automaticGcRan &&
			Number.isFinite(retentionDays) &&
			retentionDays > 0 &&
			automaticGcDue()
		) {
			automaticGcRan = true;
			const gc = gcBabysitRoots({
				rootBase: ROOT_BASE,
				currentRoot: ROOT,
				olderThanMs: retentionDays * 86_400_000,
				dryRun: false,
			});
			markAutomaticGc();
			if (gc.deleted.length > 0 && ctx.hasUI) {
				ctx.ui.notify(
					`pi-babysit GC removed ${gc.deleted.length} roots (${gc.bytes} bytes).`,
					"info",
				);
			}
		}
		// Warn early if the binary is missing so the user isn't surprised only when
		// a tool later fails. Tools/commands still enforce it via requireBabysit.
		if (ctx.hasUI && !(await babysitAvailable())) {
			ctx.ui.notify(babysitPreflightError ?? INSTALL_HINT, "warning");
		}
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = setInterval(() => {
			// Once a namespace has no live workers or pending notifications, avoid
			// spawning `babysit list` forever while the UI is idle. A successful
			// babysit_run re-arms polling below.
			if (polling || !pollNeeded) return;
			polling = true;
			void (async () => {
				const listed = await listSessions();
				if (listed.error) {
					pollNeeded = shouldKeepPollingAfterList(listed, readMeta);
					throw new Error(listed.error);
				}
				const snapshot = listed.sessions;
				await enforceSubagentBudgets(snapshot);
				await Promise.all([
					notifyEndedProcesses(ctx, snapshot),
					notifySettledSubagents(ctx, snapshot),
					refreshWidget(ctx, snapshot),
				]);
				pruneTerminalSessionCache(taskProgressCache, snapshot);
				pollNeeded = shouldKeepPolling(snapshot, readMeta);
			})()
				.catch(() => {
					// Keep polling armed after a transient CLI/filesystem error.
					pollNeeded = true;
				})
				.finally(() => {
					polling = false;
				});
		}, POLL_MS);
	});

	pi.on("session_shutdown", async () => {
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = undefined;
		releaseRootLease(rootLeasePath);
		rootLeasePath = undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "babysit_run") {
			const input = event.input as {
				command?: unknown;
				profile?: unknown;
				foreground?: unknown;
				notificationGroup?: unknown;
			};
			if (
				typeof input.command === "string" &&
				input.profile !== "subagent" &&
				input.foreground !== true &&
				(typeof input.notificationGroup !== "string" || input.notificationGroup.trim() === "")
			) {
				const group = automaticNotificationGroup(ctx.sessionManager.getLeafEntry());
				if (group) input.notificationGroup = group;
			}
			return;
		}
		if (event.toolName !== "bash") return;
		const command = String((event.input as { command?: unknown }).command ?? "");
		if (backgroundsItself(command)) {
			return {
				block: true,
				reason:
					`This bash command tries to run in the background. Use babysit_run instead, e.g. ` +
					`babysit_run({ name: "background-process", command: ${JSON.stringify(command.replace(/\s*&\s*$/, ""))} })`,
			};
		}
		if (isAllowedDirectBash(command)) return;
		return {
			block: true,
			reason:
				"Use babysit_run for shell commands so output is supervised and captured outside model context. " +
				"Inspect an existing session log with babysit_check { id, lines, pattern? }. " +
				`Retry as babysit_run({ command: ${JSON.stringify(command)} }).`,
		};
	});

	// ----- babysit_run --------------------------------------------------------
	registerTool({
		name: "babysit_run",
		label: "Babysit: run",
		description:
			"Run a supervised shell command, or start a reusable pi subagent with `profile: \"subagent\"`. " +
			"Use `foreground` for results needed now; otherwise long commands notify on exit. Full logs stay on disk. " +
			"`returnPattern`/`returnLines` bound foreground output. Sessions support check, wait, send, and kill.",
		promptSnippet: "Run supervised commands or bounded pi subagents with context-safe logs",
		promptGuidelines: [
			"Use babysit_run for shell commands and give meaningful sessions a stable name; bundle tiny related read-only observations into one command.",
			"Use babysit_run foreground mode for one process or subagent whose result is needed now; never issue sibling foreground runs in parallel. For parallel checks, start background runs with continueAfterStart and collect them with one multi-session babysit_wait.",
			"Use returnPattern/returnLines for noisy commands. During edit/fix loops run targeted checks first and one full validation suite at the end instead of repeating every full gate.",
			"After a background process starts, stop the turn for its automatic notification; never poll or sleep. Use continueAfterStart only for specific non-polling work.",
			"Inspect large logs with a narrow babysit_check pattern and maxBytes rather than broad tails.",
			"Use retryOnWorkerDeath only once and only for idempotent commands; retries may duplicate side effects.",
			"Delegate independent work with bounded babysit_run subagents. Prefer foreground for one result needed now; every background subagent must be collected with babysit_wait before the parent task finishes. Size budgets above the worker's initial context and expected tool count.",
			"Subagent recursion defaults to depth 1; only a top-level caller may explicitly raise maxDepth.",
		],
		parameters: Type.Object({
			command: Type.Optional(
				Type.String({
					description: "Shell command to run (process mode). Mutually exclusive with profile/task.",
				}),
			),
			name: Type.Optional(
				Type.String({
					description: "Friendly stable name for a process or subagent (becomes the session id), e.g. 'cargo-build' or 'review-api'.",
				}),
			),
			profile: Type.Optional(
				StringEnum(["subagent"] as const, {
					description: "Session profile. 'subagent' spawns a pi worker; requires `task`.",
				}),
			),
			task: Type.Optional(
				Type.String({ description: "The task for the subagent to perform (subagent profile)." }),
			),
			agent: Type.Optional(
				Type.String({ description: "Named agent definition (see ~/.pi/agent/agents). Subagent profile only." }),
			),
			model: Type.Optional(Type.String({ description: "Model override for the subagent, e.g. 'sonnet'." })),
			tools: Type.Optional(
				Type.Array(Type.String(), { description: "Tool allowlist for the subagent." }),
			),
			maxDepth: Type.Optional(
				Type.Integer({
					minimum: 1,
					description:
						"Maximum subagent nesting depth. Top-level subagent mode only; default 1 prevents workers from spawning workers. Nested workers inherit this limit and cannot override it.",
				}),
			),
			maxCost: Type.Optional(
				Type.Number({
					exclusiveMinimum: 0,
					description: "Subagent only: steer it to wrap up at this cumulative reported cost, then kill after the budget grace period.",
				}),
			),
			maxTurns: Type.Optional(
				Type.Integer({
					minimum: 1,
					description:
						"Subagent only: observed turn threshold for steering it to wrap up. In-flight work can overshoot before the poller intervenes.",
				}),
			),
			maxToolCalls: Type.Optional(
				Type.Integer({
					minimum: 1,
					description:
						"Subagent only: observed tool-call threshold for steering it to wrap up. A parallel in-flight tool batch can overshoot.",
				}),
			),
			maxUsageTokens: Type.Optional(
				Type.Integer({
					minimum: 1,
					description:
						"Subagent only: observed cumulative reported totalTokens threshold for steering it to wrap up.",
				}),
			),
			agentScope: Type.Optional(
				StringEnum(["user", "project", "both"] as const, {
					description: "Where to discover named agents. Default 'user'.",
				}),
			),
			timeout: Type.Optional(
				Type.String({
					description:
						"Absolute auto-kill after this long (e.g. 30m). Default: none for processes (dev servers may run forever), 15m for subagents. 'none' disables.",
				}),
			),
			idleTimeout: Type.Optional(
				Type.String({
					description:
						"Auto-kill after NO output for this long (e.g. 90s). Off by default — silence is often legitimate (a busy subagent, a quiet server). Set it only for commands that stream steadily.",
				}),
			),
			pty: Type.Optional(
				Type.Boolean({
					description:
						"Process mode: run in a PTY (default true; enables interactive input/screen). false = plain pipes for cleaner line-oriented logs.",
				}),
			),
			foreground: Type.Optional(
				Type.Boolean({
					description: "Process or subagent: wait for completion and return the result in this tool call.",
				}),
			),
			returnPattern: Type.Optional(
				Type.String({ description: "Foreground/quick process: return only latest regex matches." }),
			),
			returnLines: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 200, description: "Lines retained by returnPattern/tail (default 30)." }),
			),
			maxBytes: Type.Optional(
				Type.Integer({ minimum: 1_000, maximum: ANSWER_MAX_BYTES, description: "Returned process-output cap (default 8 KB)." }),
			),
			notificationGroup: Type.Optional(
				Type.String({
					description:
						"Process mode: defer automatic completion until every running process with this group has stopped, then send one batched notification. Sibling background runs are auto-grouped when omitted.",
				}),
			),
			continueAfterStart: Type.Optional(
				Type.Boolean({
					description:
						"Process mode only. Default false: starting a process ENDS the current turn (you are resumed by the exit notification). Set true only when you have immediate, specific, non-polling work to do after starting.",
				}),
			),
			retryOnWorkerDeath: Type.Optional(
				Type.Boolean({
					description:
						"Process mode only. Retry once if the babysit worker is killed externally during startup. Use only for safe, idempotent commands because the first attempt may have produced side effects.",
				}),
			),

		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			await requireBabysit();
			const isSubagent = params.profile === "subagent";
			if (isSubagent && !params.task) {
				return {
					content: [{ type: "text", text: "profile 'subagent' requires `task`." }],
					isError: true,
					details: {},
				};
			}
			if (!isSubagent && !params.command) {
				return {
					content: [{ type: "text", text: "Provide `command` (process) or profile 'subagent' + `task`." }],
					isError: true,
					details: {},
				};
			}
			if (params.command && isSubagent) {
				return {
					content: [{ type: "text", text: "`command` and profile 'subagent' are mutually exclusive." }],
					isError: true,
					details: {},
				};
			}
			const hasBudget =
				params.maxCost != null ||
				params.maxTurns != null ||
				params.maxToolCalls != null ||
				params.maxUsageTokens != null;
			if (!isSubagent && hasBudget) {
				return {
					content: [{ type: "text", text: "Subagent budget parameters require profile 'subagent'." }],
					isError: true,
					details: {},
				};
			}
			if (isSubagent && params.notificationGroup) {
				return {
					content: [{ type: "text", text: "`notificationGroup` is available only in process mode." }],
					isError: true,
					details: {},
				};
			}
			if (isSubagent && (params.returnPattern || params.returnLines != null || params.maxBytes != null)) {
				return {
					content: [{ type: "text", text: "`returnPattern`, `returnLines`, and `maxBytes` are process-output options." }],
					isError: true,
					details: {},
				};
			}
			if (isSubagent && params.continueAfterStart != null) {
				return {
					content: [{ type: "text", text: "`continueAfterStart` is available only in process mode." }],
					isError: true,
					details: {},
				};
			}
			if (!isSubagent && params.foreground && params.continueAfterStart) {
				return {
					content: [{ type: "text", text: "`foreground` and `continueAfterStart` are mutually exclusive." }],
					isError: true,
					details: {},
				};
			}

			// Compute nesting only for subagent mode. Ordinary command processes remain
			// available even when the hosting agent is at its subagent depth limit.
			const nesting = isSubagent
				? planSubagentSpawn(params.maxDepth)
				: undefined;
			if (nesting && !nesting.allowed) {
				return {
					content: [{ type: "text", text: nesting.error }],
					isError: true,
					details: {},
				};
			}

			// --- process mode ---
			if (!isSubagent) {
				if (params.returnPattern) {
					try {
						new RegExp(params.returnPattern);
					} catch (error) {
						return {
							content: [{ type: "text", text: `Invalid returnPattern: ${String(error)}` }],
							isError: true,
							details: {},
						};
					}
				}
				const outputSelection: ProcessOutputSelection | undefined =
					params.returnPattern || params.returnLines != null || params.maxBytes != null
						? { pattern: params.returnPattern, lines: params.returnLines, maxBytes: params.maxBytes }
						: undefined;
				const spawnOpts: ProcOpts = {
					name: params.name,
					command: params.command as string,
					cwd: ctx.cwd,
					timeout: params.timeout,
					idleTimeout: params.idleTimeout,
					pty: params.pty ?? true,
					notificationGroup: params.notificationGroup?.trim() || undefined,
				};
				let res = await spawnProcess(spawnOpts);
				if ("error" in res) {
					return {
						content: [{ type: "text", text: `Failed to start process: ${res.error}` }],
						isError: true,
						details: {},
					};
				}
				pollNeeded = true;
				await refreshWidget(ctx);

				// One-shot / non-interactive mode has no event loop that can deliver an
				// exit notification. `foreground: true` provides the same single-tool-call
				// result in interactive mode, avoiding a separate babysit_wait model turn.
				// The command remains supervised, logged, killable, and subject to its
				// babysit timeout in either case.
				if (!ctx.hasUI || params.foreground) {
					// The babysit supervisor owns the absolute command timeout. Waiting with
					// the same deadline here races its terminal-state write and can return a
					// false "still running" result at the boundary, so wait for the
					// supervisor's definitive exit instead.
					let outcome = await waitForExit(res.id, null, _signal, undefined, outputSelection);
					let retried = false;
					if (params.retryOnWorkerDeath && outcome.status?.state === "dead" && outcome.status.exit_code == null) {
						const retry = await spawnProcess(spawnOpts);
						if (!("error" in retry)) {
							res = retry;
							retried = true;
							outcome = await waitForExit(res.id, null, _signal, undefined, outputSelection);
						}
					}
					if (ctx.hasUI) await refreshWidget(ctx);
					return {
						content: [{ type: "text", text: `${retried ? "Retried once after external worker death.\n" : ""}${outcome.text}` }],
						isError: !outcome.ok,
						details: {
							id: res.id,
							kind: "process",
							command: params.command,
							logPath: logPath(res.id),
							retried,
							status: outcomeStatus(outcome),
						},
					};
				}

				// Keep ordinary quick commands ergonomic. Give the process a short grace
				// period; if it exits, return lifecycle metadata + log path immediately.
				// A process still running after the grace follows the parked-turn /
				// automatic-notification contract below.
				await bs(["wait", "-s", res.id, "--timeout", QUICK_COMMAND_GRACE], { signal: _signal });
				let quickStatus = await statusOf(res.id);
				let retried = false;
				if (params.retryOnWorkerDeath && quickStatus?.state === "dead" && quickStatus.exit_code == null) {
					// This attempt is already represented by the retrying tool result; do
					// not let the exit poller emit a second, stale completion message.
					suppressNotify(res.id);
					const retry = await spawnProcess(spawnOpts);
					if (!("error" in retry)) {
						res = retry;
						retried = true;
						await bs(["wait", "-s", res.id, "--timeout", QUICK_COMMAND_GRACE], { signal: _signal });
						quickStatus = await statusOf(res.id);
					}
				}
				if (quickStatus && quickStatus.state !== "running") {
					const outcome = await waitForExit(res.id, null, _signal, undefined, outputSelection);
					await refreshWidget(ctx);
					return {
						content: [{ type: "text", text: `${retried ? "Retried once after external worker death.\n" : ""}${outcome.text}` }],
						isError: !outcome.ok,
						details: {
							id: res.id,
							kind: "process",
							command: params.command,
							logPath: logPath(res.id),
							retried,
							status: outcomeStatus(outcome),
						},
					};
				}

				const continueAfter = params.continueAfterStart === true;
				const nextStep = continueAfter
					? "Continue with specific non-polling work now; the exit notification will arrive on its own."
					: "This turn will stop now so you can wait for the automatic process-end notification. Do not call babysit_check just to see whether it is still running.";
				return {
					content: [
						{
							type: "text",
							text:
								`${retried ? "Retried once after external worker death.\n" : ""}` +
								`Process started (id: ${res.id}). ${NOTIFY_MARKER}\nLog: ${logPath(res.id)}\n${nextStep}\n` +
								`Inspect: babysit_check { id: "${res.id}" } (screen: true for TUIs) · ` +
								`Wait: babysit_wait { id: "${res.id}" } · Kill: babysit_kill { id: "${res.id}" }\n` +
								`Human can watch/take over: /babysit`,
						},
					],
					details: {
						id: res.id,
						kind: "process",
						command: params.command,
						logPath: logPath(res.id),
						retried,
						status: "started" satisfies DisplayStatus,
					},
					// Do not return `terminate: true` here. In RPC/subagent hosts that hint
					// can shut down the hosting pi worker, whose process-tree cleanup then
					// kills the otherwise detached babysit supervisor and closes its PTY
					// (observed as an immediate `^D`). The prompt contract tells the model
					// to stop after this result instead; the NOTIFY_MARKER still identifies
					// a parked turn to the parent/self-reaper logic.
					terminate: false,
				};
			}

			// --- subagent mode ---
			let agent: AgentConfig | undefined;
			if (params.agent) {
				const scope = (params.agentScope ?? "user") as AgentScope;
				const { agents } = discoverAgents(ctx.cwd, scope);
				agent = agents.find((a) => a.name === params.agent);
				if (!agent) {
					const avail = agents.map((a) => a.name).join(", ") || "none";
					return {
						content: [
							{ type: "text", text: `Unknown agent "${params.agent}". Available: ${avail}.` },
						],
						isError: true,
						details: {},
					};
				}
			}

			// The branch above guarantees a successful plan in subagent mode.
			const subagentNesting = nesting as Extract<SubagentSpawnPlan, { allowed: true }>;
			const res = await spawnSubagent({
				name: params.name,
				agent,
				task: params.task as string,
				model: params.model,
				tools: params.tools,
				cwd: ctx.cwd,
				depth: subagentNesting.childDepth,
				maxDepth: subagentNesting.maxDepth,
				budget:
					hasBudget
						? {
							maxCost: params.maxCost,
							maxTurns: params.maxTurns,
							maxToolCalls: params.maxToolCalls,
							maxUsageTokens: params.maxUsageTokens,
						}
						: undefined,
				timeout: params.timeout ?? "15m",
				idleTimeout: params.idleTimeout,
			});

			if ("error" in res) {
				return {
					content: [{ type: "text", text: `Failed to spawn subagent: ${res.error}` }],
					isError: true,
					details: {},
				};
			}

			pollNeeded = true;
			await refreshWidget(ctx);
			if (params.foreground || !ctx.hasUI) {
				const outcome = await waitForTask(res.id, null, _signal);
				collectSubagentOutcome(outcome);
				const usage = claimOutcomeUsage(outcome);
				if (ctx.hasUI) await refreshWidget(ctx);
				return {
					content: [{ type: "text", text: outcome.text }],
					isError: !outcome.ok,
					usage,
					details: {
						id: res.id,
						kind: "subagent",
						name: params.name ?? res.id,
						agent: agent?.name,
						model: res.model,
						task: params.task,
						depth: subagentNesting.childDepth,
						maxDepth: subagentNesting.maxDepth,
						status: outcomeStatus(outcome),
					},
				};
			}
			return {
				content: [
					{
						type: "text",
						text:
							`Subagent started (id: ${res.id})${agent ? ` [agent: ${agent.name}]` : ""}${res.model ? ` [model: ${res.model}]` : ""} [depth: ${subagentNesting.childDepth}/${subagentNesting.maxDepth}].\n` +
							`Task accepted — running in the background. You MUST collect it with babysit_wait before finishing the parent task; use foreground: true next time when no independent work is available.\n` +
							`Progress: babysit_check { id: "${res.id}" } (only when inspection is needed)\n` +
							`Collect:  babysit_wait  { id: "${res.id}" }\n` +
							`Human can watch/steer: /babysit (pick ${res.id})`,
					},
				],
				details: {
					id: res.id,
					kind: "subagent",
					name: params.name ?? res.id,
					agent: agent?.name,
					model: res.model,
					task: params.task,
					depth: subagentNesting.childDepth,
					maxDepth: subagentNesting.maxDepth,
					status: "started" satisfies DisplayStatus,
				},
			};
		},
		// Make the execution kind and payload identifiable before the result arrives.
		// Use semantic theme colors rather than the fallback gray tool-call text.
		renderCall(args, theme) {
			const isSubagent = args.profile === "subagent";
			const kind = isSubagent ? "AGENT" : "COMMAND";
			const payload = isSubagent ? args.task : args.command;
			const agent = isSubagent && args.agent ? ` [${args.agent}]` : "";
			const title = theme.bold(`babysit_run ${kind}`);
			const detail =
				typeof payload === "string" && payload.length > 0
					? `  ${summarizeNotificationCommand(payload)}`
					: "";
			return new Text(theme.fg("warning", `${title}${agent}${detail}`), 0, 0);
		},
		renderResult(result, { isPartial }, theme, context) {
			const details = (result.details ?? {}) as {
				kind?: "process" | "subagent";
				status?: DisplayStatus;
			};
			const content = result.content
				.filter((item): item is { type: "text"; text: string } => item.type === "text")
				.map((item) => item.text)
				.join("\n");
			// A vanished supervisor must never be presented as success, even if an
			// older/stale result omitted status details or the host did not preserve
			// the custom isError field. The textual diagnosis is part of our stable
			// tool contract, so give it precedence over all fallback classification.
			const workerDead =
				content.includes("worker-dead") ||
				content.includes("babysit supervisor disappeared");
			const status: DisplayStatus = isPartial
				? "running"
				: workerDead
					? "terminated"
					: details.status ??
						(context.isError
							? "failed"
							: details.kind === "subagent" || content.includes(NOTIFY_MARKER)
								? "started"
								: "success");
			const label = renderStatus(status, theme);
			return new Text(content ? `${label}\n${theme.fg("toolOutput", content)}` : label, 0, 0);
		},
	});

	// ----- babysit_check ------------------------------------------------------
	registerTool({
		name: "babysit_check",
		label: "Babysit: check",
		description:
			"Inspect babysit session(s). Without an id: lists running sessions by default; use `state: \"all\"` " +
			"for history, or filter by terminal state/kind. With an id: a process shows state + recent " +
			"output, searches its log with `pattern`, " +
			"or captures the rendered screen with `screen: true`; a subagent shows live progress " +
			"(or raw log matches with `pattern`). Results are bounded by `lines` and clipped. " +
			"Do NOT poll this while merely waiting for a process to end — the exit notification is automatic.",
		promptSnippet: "Check status/progress of babysit sessions (processes and subagents)",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Session id. Omit to list sessions." })),
			state: Type.Optional(
				StringEnum(["running", "terminal", "all"] as const, {
					description: "List mode only: state filter. Defaults to running; terminal means any non-running state.",
				}),
			),
			kind: Type.Optional(
				StringEnum(["process", "subagent", "all"] as const, {
					description: "List mode only: session kind filter. Defaults to all.",
				}),
			),
			tools: Type.Optional(
				Type.Number({ description: "Subagent: how many recent tool calls to show (default 8, max 50)." }),
			),
			lines: Type.Optional(
				Type.Number({ description: "How many tail lines or latest matches to show (default 30, max 200)." }),
			),
			maxBytes: Type.Optional(
				Type.Integer({
					minimum: 1_000,
					maximum: ANSWER_MAX_BYTES,
					description: "Maximum returned bytes for this check (default 4 KB).",
				}),
			),
			pattern: Type.Optional(
				Type.String({
					description:
						"Search this session's raw log with a regular expression; returns the latest bounded matches.",
				}),
			),
			screen: Type.Optional(
				Type.Boolean({
					description:
						"Process: capture the rendered terminal screen instead of the log stream (for full-screen TUIs).",
				}),
			),
		}),
		async execute(_id, params, signal) {
			await requireBabysit();
			if (!params.id) {
				const { sessions, error } = await listSessions();
				if (error) {
					return {
						content: [{ type: "text", text: `Could not list sessions: ${error}` }],
						isError: true,
						details: {},
					};
				}
				if (sessions.length === 0) {
					return { content: [{ type: "text", text: "No babysit sessions." }], details: { sessions: [] } };
				}
				const stateFilter = params.state ?? "running";
				const kindFilter = params.kind ?? "all";
				const stateMatches = (session: BsSession) => stateFilter === "all"
					? true
					: stateFilter === "running"
						? session.state === "running"
						: session.state !== "running";
				const kindOfSession = (session: BsSession) => readMeta(session.id)?.kind ?? "process";
				const selected = sessions.filter((session) =>
					stateMatches(session) && (kindFilter === "all" || kindOfSession(session) === kindFilter),
				);
				const reveal: string[] = [];
				if (stateFilter !== "all" && sessions.some((session) => !stateMatches(session))) {
					reveal.push('state: "all"');
				}
				if (kindFilter !== "all" && sessions.some((session) => kindOfSession(session) !== kindFilter)) {
					reveal.push('kind: "all"');
				}
				const revealHint = reveal.length > 0 ? `; use ${reveal.join(" and ")} to widen the list` : "";
				if (selected.length === 0) {
					const hidden = sessions.length;
					return {
						content: [{
							type: "text",
							text: `No ${stateFilter}${kindFilter === "all" ? "" : ` ${kindFilter}`} babysit sessions.${hidden > 0 ? ` ${hidden} session(s) hidden${revealHint}.` : ""}`,
						}],
						details: { sessions: [], total: sessions.length, hidden, state: stateFilter, kind: kindFilter },
					};
				}
				const lines = selected.map((s) => {
					const meta = readMeta(s.id);
					const kind = meta?.kind ?? "process";
					const flag = s.note ? ` ⚑ ${s.note}` : "";
					const ec = s.exit_code != null ? ` exit=${s.exit_code}` : "";
					const depth =
						kind === "subagent" && meta?.depth != null
							? ` depth=${meta.depth}/${meta.maxDepth ?? "?"}`
							: "";
					const what = (kind === "subagent" ? meta?.task : meta?.command) ?? "";
					const preview = what.length > 60 ? `${what.slice(0, 57)}…` : what;
					return `${s.id}  [${kind}] ${s.state}${ec}${depth}${flag}${preview ? `  — ${preview}` : ""}`;
				});
				const hidden = sessions.length - selected.length;
				const suffix = hidden > 0 ? `\n… ${hidden} session(s) hidden${revealHint}.` : "";
				return {
					content: [{ type: "text", text: clip(lines.join("\n") + suffix) }],
					details: { sessions: selected, total: sessions.length, hidden, state: stateFilter, kind: kindFilter },
				};
			}

			const st = await statusOf(params.id);
			if (!st) {
				return {
					content: [{ type: "text", text: `No such session: ${params.id}` }],
					isError: true,
					details: {},
				};
			}
			const meta = readMeta(params.id);
			const nLines = Math.min(Math.max(1, Math.floor(params.lines ?? 30)), 200);
			const checkMaxBytes = params.maxBytes ?? TAIL_MAX_BYTES;
			if (params.pattern !== undefined) {
				if (params.screen) {
					return {
						content: [{ type: "text", text: "`pattern` and `screen` are mutually exclusive." }],
						isError: true,
						details: {},
					};
				}
				if (params.pattern.length === 0) {
					return {
						content: [{ type: "text", text: "`pattern` must not be empty." }],
						isError: true,
						details: {},
					};
				}
				const result = await searchLog(params.id, params.pattern, nLines, signal, checkMaxBytes);
				if (result.error) {
					return {
						content: [{ type: "text", text: result.error }],
						isError: true,
						details: {},
					};
				}
				const kind = meta?.kind ?? "process";
				const header = `[${kind}] state=${st.state}\nlog: ${logPath(params.id)}`;
				const body = result.text
					? `--- latest matches /${params.pattern}/ ---\n${result.text}`
					: `(no output matching /${params.pattern}/)`;
				return {
					content: [{ type: "text", text: clip(`${header}\n${body}`, checkMaxBytes) }],
					details: { status: st, kind, logPath: logPath(params.id), pattern: params.pattern },
				};
			}

			// --- process ---
			if (meta?.kind !== "subagent") {
				const parts: string[] = [];
				let header = `[process] state=${st.state}`;
				if (st.state === "running") {
					const el = elapsedOf(params.id);
					if (el) header += ` elapsed=${el}`;
				}
				if (st.exit_code != null) header += ` exit_code=${st.exit_code}`;
				if (meta?.command) header += `\ncommand: ${summarizeNotificationCommand(meta.command)}`;
				header += `\nlog: ${logPath(params.id)}`;
				if (st.note) header += ` ⚑ ${st.note}`;
				parts.push(header);
				if (params.screen) {
					const sc = await bs(["screenshot", "-s", params.id, "--trim"]);
					parts.push(`--- screen ---\n${clip(sc.stdout.trimEnd(), checkMaxBytes) || "(blank screen)"}`);
				} else {
					const tail = clip(
						(await bs(["log", "-s", params.id, "--tail", String(nLines)])).stdout.trimEnd(),
						checkMaxBytes,
					);
					parts.push(tail ? `--- recent output ---\n${tail}` : "(no output yet)");
				}
				return {
					content: [{ type: "text", text: clip(parts.join("\n"), checkMaxBytes) }],
					details: { status: st, kind: "process", logPath: logPath(params.id) },
				};
			}

			// --- subagent: analyze only bytes appended for the current task ---
			const prog = taskProgressOf(params.id).progress;
			const nTools = Math.min(Math.max(1, params.tools ?? 8), 50);
			const recent = prog.toolCalls.slice(-nTools);

			const parts: string[] = [];
			let header = `[subagent] state=${st.state}`;
			if (meta.depth != null) header += ` depth=${meta.depth}/${meta.maxDepth ?? "?"}`;
			if (st.state === "running") {
				const el = elapsedOf(params.id);
				if (el) header += ` elapsed=${el}`;
				header += prog.done
					? " · task-complete (idle — follow-up via babysit_send, or babysit_kill)"
					: prog.waitingOnProcess
						? " · waiting-on-background-process"
						: " · working";
			}
			if (st.exit_code != null) header += ` exit_code=${st.exit_code}`;
			header += ` turns=${prog.turns} calls=${prog.modelCalls} tools=${prog.toolCallCount}`;
			if (prog.tokens != null) header += ` ctx=${prog.tokens}`;
			if (prog.modelCalls > 0) header += ` usage=${prog.usageTokens} $${prog.cost.toFixed(4)}`;
			if (st.note) header += ` ⚑ ${st.note}`;
			parts.push(header);

			if (prog.errorMsg) parts.push(`⚠ error: ${clip(prog.errorMsg, ANSWER_MAX_BYTES)}`);

			if (recent.length > 0) {
				const skipped = Math.max(0, prog.toolCallCount - recent.length);
				parts.push(
					`--- recent tool calls${skipped > 0 ? ` (+${skipped} earlier)` : ""} ---\n` +
						recent.map((t) => `  ${t.summary}`).join("\n"),
				);
			}

			if (prog.finalText.trim()) {
				parts.push(`--- answer so far ---\n${clip(prog.finalText.trim(), ANSWER_MAX_BYTES)}`);
			} else if (prog.toolCallCount === 0 && st.state !== "running") {
				parts.push(buildSubagentExitDiagnostic(prog, logPath(params.id)));
			} else if (prog.toolCallCount === 0) {
				parts.push("(starting up… no events yet)");
			} else {
				parts.push("(working… no answer text yet)");
			}

			return {
				content: [{ type: "text", text: clip(parts.join("\n"), checkMaxBytes) }],
				details: { status: st, progress: prog, kind: "subagent" },
			};
		},
	});

	// ----- babysit_send -------------------------------------------------------
	registerTool({
		name: "babysit_send",
		label: "Babysit: send",
		description:
			"Send input to a babysit session. Process: `text` types a line into its stdin (PTY), " +
			"`keys` presses named keys (Enter, Tab, Esc, Up/Down/Left/Right, C-c, F1…) — use with " +
			"babysit_check { screen: true } to drive interactive programs. Subagent: `text` is " +
			"STEERING while it works, or a NEW TASK after the current task settles (mode: auto/steer/task) — this " +
			"is how you resume a finished subagent with full context.",
		promptSnippet: "Send text/keys to a process, or steering/follow-up tasks to a subagent",
		parameters: Type.Object({
			id: Type.String({ description: "Session id." }),
			text: Type.Optional(
				Type.String({ description: "Text to send (a line for processes; a message for subagents)." }),
			),
			keys: Type.Optional(
				Type.Array(Type.String(), {
					description: "Process only: named keys pressed in order (e.g. ['Down','Down','Enter'], ['C-c']).",
				}),
			),
			mode: Type.Optional(
				StringEnum(["auto", "steer", "task"] as const, {
					description:
						"Subagent only. auto (default): steer unless the current task is settled. task requires confirmed settlement; steer always sends guidance.",
				}),
			),
			noNewline: Type.Optional(
				Type.Boolean({ description: "Process only: don't append a trailing newline to `text`." }),
			),
		}),
		async execute(_id, params) {
			await requireBabysit();
			const st = await statusOf(params.id);
			if (!st || st.state !== "running") {
				return {
					content: [
						{ type: "text", text: `Session ${params.id} is not running (${st?.state ?? "missing"}).` },
					],
					isError: true,
					details: {},
				};
			}
			const meta = readMeta(params.id);

			// --- process: raw text/keys into the PTY ---
			if (meta?.kind !== "subagent") {
				if (!params.text && !params.keys?.length) {
					return {
						content: [{ type: "text", text: "Provide `text` or `keys`." }],
						isError: true,
						details: {},
					};
				}
				if (params.keys?.length) {
					const r = await bs(["key", "-s", params.id, ...params.keys]);
					if (r.code !== 0) {
						return {
							content: [{ type: "text", text: r.stderr || "key send failed" }],
							isError: true,
							details: {},
						};
					}
				}
				if (params.text != null) {
					const args = ["send", "-s", params.id];
					if (params.noNewline) args.push("--no-newline");
					args.push(params.text);
					const r = await bs(args);
					if (r.code !== 0) {
						return {
							content: [{ type: "text", text: r.stderr || "send failed" }],
							isError: true,
							details: {},
						};
					}
				}
				return {
					content: [
						{
							type: "text",
							text: `Sent to ${params.id}. Read the reaction with babysit_check { id: "${params.id}"${params.keys?.length ? ", screen: true" : ""} } — don't expect the echo of your own input.`,
						},
					],
					details: { kind: "process" },
				};
			}

			// --- subagent: steer / follow-up task over RPC ---
			return withSessionRpcLock(params.id, async () => {
				const lockedStatus = await statusOf(params.id);
				const meta = readMeta(params.id);
				if (lockedStatus?.state !== "running" || meta?.kind !== "subagent") {
					return {
						content: [
							{
								type: "text" as const,
								text: `Session ${params.id} is not a running subagent (${lockedStatus?.state ?? "missing"}).`,
							},
						],
						isError: true,
						details: {},
					};
				}
			if (!params.text) {
				return {
					content: [{ type: "text", text: "Provide `text` (steering or follow-up task)." }],
					isError: true,
					details: {},
				};
			}
			if (messageNeedsReadTool(params.text) && meta.tools?.length && !meta.tools.includes("read")) {
				return {
					content: [
						{
							type: "text",
							text: "This message is too large for PTY-safe inline delivery, but the subagent cannot read the required temporary file. Add `read` to its tool allowlist or shorten the message.",
						},
					],
					isError: true,
					details: {},
				};
			}
			let mode = params.mode ?? "auto";
			if (mode === "auto" || mode === "task") {
				// A prompt sent while the current run is streaming can queue behind that
				// run while immediately replacing our per-task offsets and budget state.
				// Establish idleness before every new task; auto safely falls back to
				// steering when state is unknown, while an explicit task fails closed.
				const gs = await sendRpc(params.id, { type: "get_state" });
				let streaming: boolean | undefined;
				if (!("error" in gs)) {
					const r = await rpcResponse(params.id, gs.offset, "get_state", "10s");
					if (r.ok) streaming = Boolean((r.data as { isStreaming?: boolean })?.isStreaming);
				}
				let currentTaskDone: boolean | undefined;
				try {
					currentTaskDone = taskProgressOf(params.id).progress.done;
				} catch {
					/* fail closed below rather than replacing unknown task state */
				}
				const resolved = resolveSubagentSendMode(mode, streaming, currentTaskDone);
				if ("error" in resolved) {
					return {
						content: [{
							type: "text",
							text: resolved.error === "busy"
								? `Subagent ${params.id} is still streaming; use mode \"steer\" or wait for the current task to settle before starting another task.`
								: resolved.error === "unsettled"
									? `Subagent ${params.id} has not settled its current task (it may be parked on a background process); wait for completion before starting another task.`
									: `Could not verify that subagent ${params.id} is idle and settled; retry with mode \"task\" after checking its state.`,
						}],
						isError: true,
						details: { mode: "task" },
					};
				}
				mode = resolved.mode;
			}
			const deliveryCleanupAfter =
				mode === "steer"
					? (() => {
							try {
								return taskProgressOf(params.id).progress.agentEnds + 1;
							} catch {
								return 1;
							}
						})()
					: 1;
			const delivery = deliverableMessage(
				mode === "steer" ? "steering message" : "task",
				params.text,
			);
			const cmd =
				mode === "steer"
					? { type: "steer", message: delivery.message }
					: { type: "prompt", message: delivery.message };
			const sent = await sendRpc(params.id, cmd);
			if ("error" in sent) {
				discardDelivery(delivery);
				return {
					content: [{ type: "text", text: sent.error }],
					isError: true,
					details: {},
				};
			}
			const resp = await rpcResponse(params.id, sent.offset, cmd.type, "15s");
			if (!resp.ok) {
				discardDelivery(delivery);
				return {
					content: [{ type: "text", text: `${cmd.type} was not accepted: ${resp.error}` }],
					isError: true,
					details: { mode },
				};
			}
			if (mode === "task") {
				// New task → new bookkeeping window, so check/wait track THIS task.
				writeMeta(params.id, {
					kind: "subagent",
					task: params.text,
					// Start after the prompt-acceptance response. This excludes a
					// preceding run that settled between `send` and RPC acceptance.
					promptOffset: resp.offset,
					model: meta?.model,
					tools: meta?.tools,
					messageTempDirs: delivery.tempDir
						? [{ dir: delivery.tempDir, afterAgentEnd: deliveryCleanupAfter }]
						: undefined,
					depth: meta?.depth,
					maxDepth: meta?.maxDepth,
					budget: meta?.budget,
					// Each follow-up task receives fresh budget and usage-accounting windows.
					budgetWarnedAt: undefined,
					budgetWarningReason: undefined,
					budgetExceededAt: undefined,
					budgetReason: undefined,
					budgetKilled: undefined,
					usageReportedOffset: undefined,
				});
			} else if (delivery.tempDir && meta) {
				writeMeta(params.id, {
					...meta,
					messageTempDirs: [
						...(meta.messageTempDirs ?? []),
						{ dir: delivery.tempDir, afterAgentEnd: deliveryCleanupAfter },
					],
				});
			}
			return {
				content: [
					{
						type: "text",
						text:
							mode === "steer"
								? `Steering queued for ${params.id} (delivered between turns).`
								: `New task started on ${params.id} — wait for it with babysit_wait.`,
					},
				],
				details: { mode, kind: "subagent" },
			};
			});
		},
	});

	// ----- babysit_wait -------------------------------------------------------
	registerTool({
		name: "babysit_wait",
		label: "Babysit: wait",
		description:
			"Block until babysit session(s) finish, then return the result. A process finishes " +
			"when it EXITS (or, with `expect`, as soon as a regex appears in its output — e.g. wait " +
			"for 'listening on' before hitting a dev server). A subagent finishes when its current " +
			"TASK completes (the worker remains reusable only during its configured idle grace). Pass `id` for one session, or " +
			"`ids` + `mode`: 'all' (default) waits for every one, 'any' returns on the FIRST finisher. " +
			"Multi-session results are capped at the inline-output limit (8 KB by default); use `maxBytes` " +
			"to opt into a larger result up to 24 KB. " +
			"Prefer ending your turn over babysit_wait when a process result is not needed this turn — " +
			"the exit notification will resume you.",
		promptSnippet: "Block until session(s) finish — process exit / output pattern / subagent task done",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Session id (single wait)." })),
			ids: Type.Optional(
				Type.Array(Type.String(), {
					maxItems: MAX_MULTI_WAIT_SESSIONS,
					description: `Session ids for a multi-wait (use with mode; maximum ${MAX_MULTI_WAIT_SESSIONS}, no duplicates).`,
				}),
			),
			mode: Type.Optional(
				StringEnum(["all", "any"] as const, {
					description: "Multi-wait mode: 'all' (default) or 'any' (first to finish wins).",
				}),
			),
			timeout: Type.Optional(
				Type.String({ description: "Give up after this long (e.g. 5m). Default: wait indefinitely." }),
			),
			expect: Type.Optional(
				Type.String({
					description:
						"Process only: return as soon as this regex appears in the output (readiness marker) instead of waiting for exit.",
				}),
			),
			maxBytes: Type.Optional(
				Type.Integer({
					minimum: 1_000,
					maximum: ANSWER_MAX_BYTES,
					description:
						"Multi-session result cap in bytes. Defaults to PI_BABYSIT_INLINE_OUTPUT_MAX_BYTES (8 KB).",
				}),
			),
		}),
		async execute(_id, params, signal) {
			await requireBabysit();
			const ids = params.ids?.length ? params.ids : params.id ? [params.id] : [];
			if (ids.length === 0) {
				return {
					content: [{ type: "text", text: "Provide `id` or a non-empty `ids` array." }],
					isError: true,
					details: {},
				};
			}
			if (ids.length > MAX_MULTI_WAIT_SESSIONS) {
				return {
					content: [{ type: "text", text: `Multi-wait supports at most ${MAX_MULTI_WAIT_SESSIONS} sessions.` }],
					isError: true,
					details: {},
				};
			}
			if (new Set(ids).size !== ids.length) {
				return {
					content: [{ type: "text", text: "Multi-wait session ids must be unique." }],
					isError: true,
					details: {},
				};
			}
			const limitMs = parseDurMs(params.timeout);
			const multiResultMaxBytes = params.maxBytes ?? INLINE_OUTPUT_MAX_BYTES;
			if (params.timeout !== undefined && limitMs === null) {
				throw new Error(
					`Invalid timeout ${JSON.stringify(params.timeout)}; use an integer with ms, s, m, or h (for example "90s" or "5m").`,
				);
			}

			if (ids.length === 1) {
				const r = await waitFor(ids[0], limitMs, signal, params.expect);
				collectSubagentOutcome(r);
				const usage = claimOutcomeUsage(r);
				return {
					content: [{ type: "text", text: r.text }],
					isError: !r.ok,
					usage,
					details: {
						status: r.status,
						progress: r.progress,
						timedOut: r.kind === "timeout",
						interrupted: r.kind === "interrupted",
					},
				};
			}

			if ((params.mode ?? "all") === "all") {
				// Parallel waits; report every result in input order.
				const results = await Promise.all(
					ids.map((i) => waitFor(i, limitMs, signal, params.expect)),
				);
				const ok = results.every((r) => r.ok);
				results.forEach(collectSubagentOutcome);
				const usage = sumNestedUsage(results.map(claimOutcomeUsage));
				return {
					content: [
						{
							type: "text",
							text: clipMultiWaitResult(
								results.map((result) => `── ${result.id} [${result.kind}] ──\n${result.text}`).join("\n\n"),
								multiResultMaxBytes,
							),
						},
					],
					isError: !ok,
					usage,
					details: {
						results: results.map((r) => ({ id: r.id, kind: r.kind, ok: r.ok })),
					},
				};
			}

			// mode "any": race the waits, then cancel the losers (their sessions keep
			// running — only OUR blocked `expect`/`wait` children are cancelled).
			const ctrl = new AbortController();
			const onOuterAbort = () => ctrl.abort();
			signal?.addEventListener("abort", onOuterAbort, { once: true });
			try {
				const first = await Promise.race(
					ids.map((i) => waitFor(i, limitMs, ctrl.signal, params.expect)),
				);
				const others = ids.filter((i) => i !== first.id);
				collectSubagentOutcome(first);
				const usage = claimOutcomeUsage(first);
				return {
					content: [
						{
							type: "text",
							text: clipMultiWaitResult(
								`First to finish: ${first.id} [${first.kind}]` +
									(others.length ? ` — still waiting-able: ${others.join(", ")}` : "") +
									`\n\n${first.text}`,
								multiResultMaxBytes,
							),
						},
					],
					isError: !first.ok,
					usage,
					details: { first: { id: first.id, kind: first.kind, ok: first.ok }, remaining: others },
				};
			} finally {
				ctrl.abort();
				signal?.removeEventListener("abort", onOuterAbort);
			}
		},
	});

	// ----- babysit_kill -------------------------------------------------------
	registerTool({
		name: "babysit_kill",
		label: "Babysit: kill",
		description: "Terminate a babysit session (process or subagent).",
		promptSnippet: "Terminate a babysit session",
		parameters: Type.Object({ id: Type.String({ description: "Session id." }) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			await requireBabysit();
			// Prevent the exit poller racing a requested kill, but restore delivery
			// on every failure. Permanent suppression happens only after terminal
			// state is independently confirmed.
			pauseNotify(params.id);
			const fail = async (message: string, status?: BsSession | null) => {
				resumeNotify(params.id);
				await refreshWidget(ctx);
				return {
					content: [{ type: "text" as const, text: message }],
					isError: true,
					details: { id: params.id, status: status?.state, logPath: logPath(params.id) },
				};
			};

			const r = await bs(["kill", "-s", params.id, "--json"]);
			if (r.code !== 0) return fail((r.stderr || r.stdout || "kill failed").trim());

			const responseError = validateKillResponse(r.stdout);
			if (responseError) return fail(responseError);

			const status = await awaitConfirmedTermination(params.id);
			if (!status) return fail(`Kill could not be verified: session ${params.id} disappeared.`);
			if (!isConfirmedTerminalState(status.state)) {
				return fail(
					`Kill was acknowledged but ${params.id} is still ${status.state}; completion notifications were restored.`,
					status,
				);
			}

			suppressNotify(params.id, "kill");
			await refreshWidget(ctx);
			return {
				content: [{ type: "text", text: `Killed ${params.id} (confirmed ${status.state}).` }],
				details: {
					id: params.id,
					status: status.state,
					exitCode: status.exit_code,
					logPath: logPath(params.id),
				},
			};
		},
	});

	// ----- /babysit -----------------------------------------------------------
	// Arrow up/down picker over all sessions (like /stash). Renders an INLINE
	// snapshot (no tmux): running process → current rendered screen + recent
	// output + a copy-paste `babysit attach` take-over hint; running subagent →
	// read-only progress; finished → summary. Re-run to refresh.
	pi.registerCommand("babysit", {
		description: "Pick a session to inspect, or `/babysit gc [days]` to remove old terminal roots",
		handler: async (args, ctx) => {
			const command = args.trim();
			if (command === "gc" || command.startsWith("gc ")) {
				const daysText = command.slice(2).trim();
				const days = daysText ? Number(daysText) : 14;
				if (!Number.isFinite(days) || days <= 0) {
					ctx.ui.notify("Usage: /babysit gc [positive retention days]", "error");
					return;
				}
				const options = {
					rootBase: ROOT_BASE,
					currentRoot: ROOT,
					olderThanMs: days * 86_400_000,
				};
				const preview = gcBabysitRoots({ ...options, dryRun: true });
				if (preview.candidates.length === 0) {
					ctx.ui.notify(
						`No terminal pi-babysit roots older than ${days} days are safe to remove.`,
						"info",
					);
					return;
				}
				const confirmed = await ctx.ui.confirm(
					"Remove old pi-babysit roots?",
					`${preview.candidates.length} roots · ${preview.bytes} bytes · older than ${days} days\n` +
						"Running supervisors and the current Pi session are excluded.",
				);
				if (!confirmed) return;
				const removed = gcBabysitRoots({ ...options, dryRun: false });
				ctx.ui.notify(
					`Removed ${removed.deleted.length} pi-babysit roots (${removed.bytes} bytes).`,
					"info",
				);
				return;
			}
			if (command) {
				ctx.ui.notify("Usage: /babysit or /babysit gc [days]", "error");
				return;
			}
			if (!(await babysitAvailable())) {
				ctx.ui.notify(babysitPreflightError ?? INSTALL_HINT, "error");
				return;
			}
			const sessions = (await listSessions()).sessions.sort((a, b) =>
				a.state === b.state ? 0 : a.state === "running" ? -1 : 1,
			);
			if (sessions.length === 0) {
				ctx.ui.notify("No babysit sessions.", "info");
				return;
			}

			const whatOf = (s: BsSession): string => {
				const meta = readMeta(s.id);
				return ((meta?.kind === "subagent" ? meta.task : meta?.command) ?? "")
					.replace(/\s+/g, " ")
					.trim();
			};

			// Labels must be unique for index mapping; the id makes them unique.
			const labels = sessions.map((s) => {
				const kind = kindOf(s.id);
				const icon = s.state === "running" ? "⏳" : s.exit_code === 0 ? "✓" : "✗";
				const ec = s.exit_code != null ? ` exit=${s.exit_code}` : "";
				const flag = s.note ? " ⚑" : "";
				const what = whatOf(s);
				const preview = what.length > 60 ? `${what.slice(0, 57)}…` : what;
				return `${icon} ${s.id}${flag} [${kind}] ${s.state}${ec}${preview ? `  — ${preview}` : ""}`;
			});

			const choice = await ctx.ui.select("Babysit sessions:", labels);
			if (!choice) return;
			const picked = sessions[labels.indexOf(choice)];
			if (!picked) return;
			const kind = kindOf(picked.id);
			const elapsed = picked.state === "running" ? elapsedOf(picked.id) : null;
			const elapsedSuffix = elapsed ? ` ${elapsed}` : "";

			// Inline snapshot (running) or summary (finished) — no tmux window.
			if (kind === "subagent") {
				// Parse the RPC event stream and show the final answer, not raw JSONL.
				const prog = taskProgressOf(picked.id).progress;
				const stats =
					`turns=${prog.turns} calls=${prog.modelCalls} tools=${prog.toolCallCount}` +
					(prog.tokens != null ? ` ctx=${prog.tokens}` : "") +
					(prog.modelCalls > 0 ? ` usage=${prog.usageTokens} $${prog.cost.toFixed(4)}` : "");
				const body =
					(prog.finalText.trim() ||
						prog.errorMsg ||
						`(no structured output; full log: ${logPath(picked.id)})`) +
					(picked.state === "running"
						? "\n\n_Live subagent (read-only). Re-run `/babysit` to refresh this snapshot._"
						: "");
				const title =
					`${picked.id} ${picked.state}${elapsedSuffix}` +
					(picked.exit_code != null ? ` (exit=${picked.exit_code})` : "") +
					`  ${stats}`;
				const status: DisplayStatus = prog.errorMsg
					? "failed"
					: prog.running || prog.waitingOnProcess
						? "running"
						: prog.done
							? "idle"
							: picked.exit_code === 0
								? "success"
								: "terminated";
				if (ctx.hasUI) {
					pi.sendMessage({
						customType: "pi-babysit-result",
						content: title,
						display: true,
						details: { title, body, status },
					});
				} else {
					ctx.ui.notify(`${title}\n\n${body}`, "info");
				}
			} else {
				const meta = readMeta(picked.id);
				const running = picked.state === "running";
				// For a LIVE process show the CURRENT rendered screen (TUIs redraw in
				// place, so the raw stream isn't representative); for a finished one
				// the recorded tail is enough.
				const screen = running
					? (await bs(["screenshot", "-s", picked.id, "--trim"])).stdout.trimEnd()
					: "";
				const tail = (await bs(["log", "-s", picked.id, "--tail", "30"])).stdout.trimEnd();
				const title =
					`${picked.id} ${picked.state}${elapsedSuffix}` +
					(picked.exit_code != null ? ` (exit=${picked.exit_code})` : "");
				const body =
					(meta?.command ? `\`${meta.command}\`\n\n` : "") +
					(screen ? `**screen**\n\`\`\`\n${screen}\n\`\`\`\n\n` : "") +
					(tail
						? `**recent output**\n\`\`\`\n${tail}\n\`\`\``
						: screen
							? ""
							: "(no output)") +
					(running
						? `\n\n_Take over in your own terminal:_ \`${attachCmd(picked.id)}\` _(detach: Ctrl-\\ Ctrl-\\)._ Re-run \`/babysit\` to refresh this snapshot.`
						: "");
				const status: DisplayStatus = running
					? "running"
					: picked.exit_code === 0
						? "success"
						: picked.state === "dead" || picked.exit_code == null
							? "terminated"
							: "failed";
				if (ctx.hasUI) {
					pi.sendMessage({
						customType: "pi-babysit-result",
						content: title,
						display: true,
						details: { title, body, status },
					});
				} else {
					ctx.ui.notify(`${title}\n\n${body}`, "info");
				}
			}
		},
	});
}
