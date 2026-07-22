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
 *                  event stream (`agent_end`), NOT process exit; the session
 *                  stays alive for cheap follow-up tasks. Same design as the
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
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
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

// Marker embedded in babysit_run's tool RESULT text for kind=process runs.
// It is how "the turn parked awaiting a process-exit notification" is told
// apart from any other turn end (see isParkedToolResult / self-reap.ts).
export const NOTIFY_MARKER = "[notify-on-exit]";

// Human-readable view for the subagent JSONL stream when a human attaches.
// babysit records the raw JSON to its log (parsers unaffected) and pipes only
// the live attach view through this formatter. Set PI_BABYSIT_VIEW_CMD="" to
// disable (raw JSON), or to a custom command to override.
const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const VIEW_CMD =
	process.env.PI_BABYSIT_VIEW_CMD ??
	`${shq(process.execPath)} ${shq(path.join(EXT_DIR, "format-stream.mjs"))}`;

// Appended to every subagent's system prompt. The subagent is a long-lived
// headless `pi --mode rpc` worker: turns can end and resume, so babysit_run
// (process kind) works normally inside it. It just cannot talk to a human.
const SUBAGENT_GUIDANCE = [
	"You are a headless background worker driven over pi's RPC protocol.",
	"Work autonomously: you cannot ask the user questions, so state assumptions",
	"in your final answer instead. Long commands may be run synchronously via",
	"bash (blocking is fine) or via babysit_run (it works here). When your",
	"task is complete, produce a final answer message summarizing the outcome —",
	"your controller reads it from the event stream.",
].join(" ");
const POLL_MS = 2500;
const QUICK_COMMAND_GRACE = process.env.PI_BABYSIT_QUICK_GRACE ?? "1s";

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
	opts: { cwd?: string; signal?: AbortSignal } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve) => {
		if (opts.signal?.aborted) {
			resolve({ stdout: "", stderr: "aborted", code: 130 });
			return;
		}
		const child = spawn(BABYSIT_BIN, args, {
			cwd: opts.cwd,
			env: { ...process.env, BABYSIT_DIR: ROOT },
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
async function babysitAvailable(): Promise<boolean> {
	// Cache only success. A missing or outdated binary may be installed while pi
	// stays open, so subsequent tool calls must be able to recover without a restart.
	if (babysitPreflightError === null) return true;
	const r = await bs(["--version"]);
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

async function statusOf(id: string): Promise<BsSession | null> {
	// `status --json` shape: { session, status: { state, exit_code, ... } }.
	// `note` lives only in `list --json`, so fold it in from there.
	const r = await bs(["status", "-s", id, "--json"]);
	if (r.code !== 0) return null;
	try {
		const parsed = JSON.parse(r.stdout);
		const inner = parsed.status ?? parsed;
		// `note` and `alive` live only in `list --json`, so fold them in from there
		// (alive is what lets us detect a crashed-but-"running" worker).
		const listed = (await listSessions()).sessions.find((s) => s.id === id);
		return normalizeSession({
			id: parsed.session ?? id,
			note: listed?.note ?? null,
			alive: listed?.alive,
			...inner,
		});
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// per-session metadata
// ---------------------------------------------------------------------------

// kind=process: name/command + `notified` (exit notification dedup).
// kind=subagent: task + the raw-log byte offset of the last prompt, which lets
// check/wait analyze only the CURRENT task's events (important for follow-ups).
interface Meta {
	kind: "process" | "subagent";
	// process
	name?: string;
	command?: string;
	notified?: boolean;
	completionObservedAt?: number;
	startedAt?: number;
	// subagent
	task?: string;
	promptOffset?: number;
	model?: string;
}

const metaDir = () => path.join(ROOT, "meta");
const logPath = (id: string) => path.join(ROOT, "sessions", id, "output.log");

function writeMeta(id: string, m: Meta): void {
	try {
		fs.mkdirSync(metaDir(), { recursive: true });
		fs.writeFileSync(path.join(metaDir(), `${id}.json`), JSON.stringify(m));
	} catch {
		/* best-effort */
	}
}

function readMeta(id: string): Meta | null {
	try {
		return JSON.parse(fs.readFileSync(path.join(metaDir(), `${id}.json`), "utf-8"));
	} catch {
		return null;
	}
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

// Wait for `{"type":"response","command":<command>}` after `since`, then parse
// it. Distinguishes: success, explicit failure (success:false → the error
// message, e.g. "No API key found for …"), subagent death, and timeout — this
// is what makes bad-model/config failures LOUD instead of silent.
async function rpcResponse(
	id: string,
	since: number,
	command: string,
	timeout = "30s",
	signal?: AbortSignal,
): Promise<{ ok: true; data?: Record<string, unknown> } | { ok: false; error: string }> {
	const e = await bs(
		["expect", "-s", id, "--since", String(since), "--timeout", timeout, `"command":"${command}"`],
		{ signal },
	);
	if (e.code !== 0) {
		const st = await statusOf(id);
		if (st && st.state !== "running") {
			const tail = clip((await bs(["log", "-s", id, "--tail", "15"])).stdout.trim());
			return {
				ok: false,
				error:
					`subagent exited (exit_code=${st.exit_code ?? "?"}) before responding to ${command}.` +
					(tail ? `\nLast output:\n${tail}` : ""),
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
	const lg = await bs(["log", "-s", id, "--since", String(since)]);
	for (const raw of lg.stdout.split("\n")) {
		const line = raw.replace(/\r$/, "").trim();
		if (!line.startsWith("{")) continue;
		try {
			const ev = JSON.parse(line);
			if (ev.type === "response" && ev.command === command) {
				if (ev.success === false) {
					return { ok: false, error: clip(String(ev.error ?? `${command} failed`)) };
				}
				return { ok: true, data: ev.data as Record<string, unknown> | undefined };
			}
		} catch {
			/* partial line */
		}
	}
	return { ok: false, error: `no ${command} response found in log` };
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

const TAIL_MAX_BYTES = 8_000; // explicit tails / screens
const INLINE_OUTPUT_MAX_BYTES = 8_000; // complete output returned only below this threshold
const ANSWER_MAX_BYTES = 24_000; // subagent answers / error messages

function clip(s: string, maxBytes = TAIL_MAX_BYTES): string {
	const buf = Buffer.from(s, "utf8");
	if (buf.length <= maxBytes) return s;
	const half = Math.floor(maxBytes / 2);
	// Strip replacement chars from a mid-codepoint cut at the boundary.
	const head = buf.subarray(0, half).toString("utf8").replace(/\uFFFD+$/, "");
	const tail = buf.subarray(buf.length - half).toString("utf8").replace(/^\uFFFD+/, "");
	return `${head}\n… [${buf.length - maxBytes} bytes elided] …\n${tail}`;
}

async function searchLog(
	id: string,
	pattern: string,
	maxLines: number,
	signal?: AbortSignal,
): Promise<{ text: string; error?: string }> {
	const file = logPath(id);
	if (!fs.existsSync(file)) return { text: "", error: `Log file is missing: ${file}` };
	if (signal?.aborted) return { text: "", error: "Log search was interrupted." };

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
				finish({ text: clip(stdout.trimEnd()) });
			}
		});
	});
}

async function inlineOutput(id: string, status: BsSession): Promise<string> {
	let bytes = status.output_bytes;
	if (bytes == null) {
		try {
			bytes = fs.statSync(logPath(id)).size;
		} catch {
			bytes = Number.POSITIVE_INFINITY;
		}
	}
	if (bytes > INLINE_OUTPUT_MAX_BYTES) {
		const size = Number.isFinite(bytes) ? `${bytes} bytes` : "size unavailable";
		return `\nOutput omitted (${size}; inline limit ${INLINE_OUTPUT_MAX_BYTES}).`;
	}
	const output = (await bs(["log", "-s", id])).stdout.trimEnd();
	if (Buffer.byteLength(output) > INLINE_OUTPUT_MAX_BYTES) {
		return `\nOutput omitted (exceeds inline limit ${INLINE_OUTPUT_MAX_BYTES} bytes).`;
	}
	return output ? `\n\nOutput:\n${output}` : "";
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
function isParkedToolResult(
	last: { role?: string; toolName?: string; content?: unknown } | undefined,
): boolean {
	if (!last || last.role !== "toolResult") return false;
	if (last.toolName === "process") return true; // legacy
	if (last.toolName !== "babysit_run") return false;
	try {
		const s = JSON.stringify(last.content ?? null);
		if (s === "null") return true; // content unavailable — err on "parked" (never false-kill a build wait)
		return s.includes(NOTIFY_MARKER);
	} catch {
		return true;
	}
}

// ---------------------------------------------------------------------------
// parse a subagent's RPC event stream (from its babysit log)
// ---------------------------------------------------------------------------

interface ToolCall {
	name: string;
	summary: string;
}
interface Progress {
	turns: number;
	toolCalls: ToolCall[];
	finalText: string;
	tokens?: number;
	cost?: number;
	errorMsg?: string;
	// RPC lifecycle bookkeeping (computed over the analyzed log slice):
	agentStarts: number;
	agentEnds: number;
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

function parseEvents(logText: string): Progress {
	const p: Progress = {
		turns: 0,
		toolCalls: [],
		finalText: "",
		agentStarts: 0,
		agentEnds: 0,
		lastEndWasProcessWait: false,
		running: false,
		waitingOnProcess: false,
		done: false,
	};
	for (const raw of logText.split("\n")) {
		const line = raw.replace(/\r$/, "").trim();
		if (!line.startsWith("{")) continue;
		let ev: Record<string, unknown>;
		try {
			ev = JSON.parse(line);
		} catch {
			continue; // partial trailing line, etc.
		}
		switch (ev.type) {
			case "turn_start":
				p.turns++;
				break;
			case "tool_execution_start": {
				const name = String(ev.toolName ?? "tool");
				p.toolCalls.push({
					name,
					summary: summarizeToolCall(name, (ev.args as Record<string, unknown>) ?? {}),
				});
				break;
			}
			case "message_end": {
				const msg = ev.message as
					| { role?: string; content?: { type: string; text?: string }[]; usage?: { totalTokens?: number; cost?: { total?: number } } }
					| undefined;
				if (msg?.role === "assistant") {
					const txt = (msg.content ?? [])
						.filter((c) => c.type === "text" && c.text)
						.map((c) => c.text)
						.join("");
					if (txt.trim()) p.finalText = txt; // keep the latest non-empty assistant text
					if (msg.usage) {
						p.tokens = msg.usage.totalTokens;
						p.cost = msg.usage.cost?.total;
					}
				}
				break;
			}
			case "agent_start":
				p.agentStarts++;
				break;
			case "agent_end": {
				p.agentEnds++;
				const msgs = ev.messages as
					| { role?: string; toolName?: string; content?: unknown }[]
					| undefined;
				p.lastEndWasProcessWait = isParkedToolResult(msgs?.[msgs.length - 1]);
				break;
			}
			case "response":
				// RPC command failures (bad model, no API key, …) surface here.
				if (ev.success === false) {
					p.errorMsg = String(ev.error ?? `rpc ${ev.command ?? "command"} failed`);
				}
				break;
			case "error":
				p.errorMsg = String(ev.message ?? ev.error ?? line);
				break;
		}
	}
	p.running = p.agentStarts > p.agentEnds;
	p.waitingOnProcess = !p.running && p.agentEnds > 0 && p.lastEndWasProcessWait;
	p.done = !p.running && p.agentEnds > 0 && !p.lastEndWasProcessWait;
	return p;
}

// ---------------------------------------------------------------------------
// spawning — kind=process
// ---------------------------------------------------------------------------

// Friendly name → unique babysit session id (babysit ids allow [\w.-]).
async function uniqueSessionId(name: string): Promise<string> {
	const base = name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "proc";
	const taken = new Set((await listSessions()).sessions.map((s) => s.id));
	if (!taken.has(base)) return base;
	for (let i = 2; ; i++) {
		if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
	}
}

interface ProcOpts {
	name?: string;
	command: string;
	cwd: string;
	timeout?: string; // default: none — dev servers may run indefinitely
	idleTimeout?: string;
	pty: boolean;
}

async function spawnProcess(opts: ProcOpts): Promise<{ id: string } | { error: string }> {
	const bsArgs = ["run", "-d", "--json", "--size", "120x40"];
	if (!opts.pty) bsArgs.push("--no-tty");
	if (opts.timeout && opts.timeout !== "none") bsArgs.push("--timeout", opts.timeout);
	if (opts.idleTimeout && opts.idleTimeout !== "none")
		bsArgs.push("--idle-timeout", opts.idleTimeout);
	if (opts.name) bsArgs.push("--id", await uniqueSessionId(opts.name));
	bsArgs.push("--", SHELL, "-c", opts.command);

	const r = await bs(bsArgs, { cwd: opts.cwd });
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

function deliverableMessage(kind: "task" | "steering message", text: string): string {
	if (Buffer.byteLength(text, "utf-8") <= PTY_SAFE_MESSAGE_BYTES) return text;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-babysit-msg-"));
	const file = path.join(dir, "message.md");
	fs.writeFileSync(file, text, "utf-8");
	return `Your full ${kind} is in the file ${file} — read it with the Read tool FIRST, then carry it out exactly as written.`;
}

interface SubagentOpts {
	agent?: AgentConfig;
	task: string;
	model?: string;
	tools?: string[];
	cwd: string;
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
	if (tools && tools.length > 0) piArgs.push("--tools", tools.join(","));
	piArgs.push("--append-system-prompt", SUBAGENT_GUIDANCE);
	if (opts.agent?.systemPrompt?.trim()) {
		const f = writePromptTempFile(opts.agent.name, opts.agent.systemPrompt);
		piArgs.push("--append-system-prompt", f);
	}
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
	// Pretty-print the JSONL stream for humans who `attach`; the recorded log
	// stays raw so parseEvents/`babysit log` are unaffected.
	if (VIEW_CMD.trim()) bsArgs.push("--view-cmd", VIEW_CMD);
	if (opts.idleTimeout && opts.idleTimeout !== "none") {
		bsArgs.push("--idle-timeout", opts.idleTimeout);
	}
	bsArgs.push("--", PI_BIN, ...piArgs);

	const r = await bs(bsArgs, { cwd: opts.cwd });
	if (r.code !== 0) {
		return { error: r.stderr || r.stdout || `babysit run failed (exit ${r.code}, no output) — check that \`${BABYSIT_BIN}\` works and ${ROOT} is writable` };
	}
	let id: string;
	try {
		id = JSON.parse(r.stdout).id;
	} catch {
		return { error: `could not parse id from: ${r.stdout}` };
	}

	// Stamp the kind IMMEDIATELY (with notified:true) so that if validation
	// below fails and we kill the session, the exit poller does NOT mistake it
	// for an un-notified process and fire a spurious process-end notification.
	// The success path overwrites this with the full task meta.
	writeMeta(id, { kind: "subagent", task: opts.task, notified: true });

	// Wait for pi to boot (first JSON event in the log), then inject the task.
	await bs(["expect", "-s", id, "--timeout", "30s", '\\{"type"']);
	const sent = await sendRpc(id, {
		type: "prompt",
		message: `Task: ${deliverableMessage("task", opts.task)}`,
	});
	if ("error" in sent) {
		await bs(["kill", "-s", id]);
		return { error: `could not send task to subagent ${id}: ${sent.error}` };
	}
	// Validate the prompt was ACCEPTED (this is where "No API key found for …"
	// and similar config errors surface — fail the spawn loudly).
	const resp = await rpcResponse(id, sent.offset, "prompt", "60s");
	if (!resp.ok) {
		await bs(["kill", "-s", id]);
		return { error: `subagent ${id} rejected the task: ${resp.error}` };
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
		task: opts.task,
		promptOffset: sent.offset,
		model: resolvedModel,
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
function renderWidgetLines(procs: number, busy: number, idle: number): string[] {
	if (procs === 0 && busy === 0 && idle === 0) return [];
	const parts: string[] = [];
	if (procs > 0) parts.push(`${procs} process${procs > 1 ? "es" : ""}`);
	if (busy > 0) parts.push(`${busy} subagent${busy > 1 ? "s" : ""} working`);
	if (idle > 0) parts.push(`${idle} idle`);
	return [`\x1b[44;97m ${parts.join(" \u00b7 ")} \x1b[0m`];
}

// How many trailing output lines to show per running session in the widget.
const WIDGET_TAIL_LINES = 1;
const WIDGET_TAIL_WIDTH = 100;

// Strip ANSI/control escapes and clamp width so raw PTY output can't wrap or
// corrupt the widget area.
function sanitizeTailLine(s: string): string {
	const clean = s
		.replace(/\r/g, "")
		// CSI / OSC / other escape sequences
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b[@-Z\\-_]|\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		// remaining non-printable control chars (keep tab)
		.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
	return clean.length > WIDGET_TAIL_WIDTH ? `${clean.slice(0, WIDGET_TAIL_WIDTH - 1)}…` : clean;
}

// Trailing lines to show for a running session (sanitized, unprefixed).
// process → raw log tail; subagent → derived activity (recent tool calls /
// partial answer), since its log is RPC JSONL, not human-readable.
async function widgetTail(id: string, isSub: boolean): Promise<string[]> {
	let raw: string[];
	if (!isSub) {
		const out = (await bs(["log", "-s", id, "--tail", String(WIDGET_TAIL_LINES)])).stdout;
		raw = out.split("\n");
	} else {
		const meta = readMeta(id);
		const logArgs = ["log", "-s", id];
		if (meta?.promptOffset) logArgs.push("--since", String(meta.promptOffset));
		const prog = parseEvents((await bs(logArgs)).stdout);
		if (prog.finalText.trim()) {
			raw = prog.finalText.trim().split("\n");
		} else if (prog.toolCalls.length > 0) {
			raw = prog.toolCalls.map((t) => t.summary);
		} else {
			raw = prog.errorMsg ? [`⚠ ${prog.errorMsg}`] : [];
		}
	}
	return raw
		.map(sanitizeTailLine)
		.filter((l) => l.trim().length > 0)
		.slice(-WIDGET_TAIL_LINES);
}

// Classify a running subagent as busy or idle by analyzing the current task's
// log slice (same logic babysit_check uses).
async function isTaskDone(id: string): Promise<boolean> {
	try {
		const meta = readMeta(id);
		const logArgs = ["log", "-s", id];
		if (meta?.promptOffset) logArgs.push("--since", String(meta.promptOffset));
		return parseEvents((await bs(logArgs)).stdout).done;
	} catch {
		return false; // when unsure, treat as busy — never hide a live worker
	}
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

// Wait for ONE subagent's current task. Completion = an agent_end whose last
// message is NOT a parked babysit_run/process toolResult (that one only means
// "turn parked, waiting for a background process — pi resumes on its own").
// Loop: analyze the current-task log slice; done → return; still going →
// block on the next agent_end via `babysit expect` (race-free byte offsets).
async function waitForTask(
	id: string,
	limitMs: number | null,
	signal?: AbortSignal,
): Promise<WaitOutcome> {
	const meta = readMeta(id);
	const base = meta?.promptOffset ?? 0;
	const t0 = Date.now();

	for (;;) {
		const lg = await bs(["log", "-s", id, "--since", String(base), "--json"]);
		let text = "";
		let cur = base;
		try {
			const j = JSON.parse(lg.stdout);
			text = j.text ?? "";
			cur = j.offset ?? base;
		} catch {
			text = lg.stdout;
		}
		const prog = parseEvents(text);
		const st = await statusOf(id);

		const stats =
			`turns=${prog.turns} tools=${prog.toolCalls.length}` +
			(prog.tokens != null ? ` ctx=${prog.tokens}` : "") +
			(prog.cost != null ? ` $${prog.cost.toFixed(4)}` : "");

		if (prog.done) {
			const body = clip(
				prog.finalText.trim() || prog.errorMsg || "(no answer text)",
				ANSWER_MAX_BYTES,
			);
			const ok = prog.finalText.trim().length > 0 || !prog.errorMsg;
			return {
				id,
				kind: "done",
				ok,
				text:
					`Subagent ${id} finished its task (${stats}).\n` +
					`Session stays alive — follow-up: babysit_send { id: "${id}" }, ` +
					`or babysit_kill when done.\n\n${body}`,
				status: st,
				progress: prog,
			};
		}

		if (!st || st.state !== "running") {
			// Crash / timeout / external kill — make the cause visible.
			const tail = clip((await bs(["log", "-s", id, "--tail", "20"])).stdout.trim());
			const body = clip(
				prog.finalText.trim() || prog.errorMsg || tail || "(no output)",
				ANSWER_MAX_BYTES,
			);
			return {
				id,
				kind: "exited",
				ok: false,
				text:
					`Subagent ${id} EXITED before completing the task ` +
					`(state=${st?.state ?? "missing"}, exit_code=${st?.exit_code ?? "?"}, ${stats}).\n\n${body}`,
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

		// Still working — block on the next agent_end.
		let expectTimeout = "0"; // indefinite
		if (limitMs != null) {
			const remaining = limitMs - (Date.now() - t0);
			if (remaining <= 0) return timeoutOutcome();
			expectTimeout = `${Math.ceil(remaining / 1000)}s`;
		}
		const e = await bs(
			["expect", "-s", id, "--since", String(cur), "--timeout", expectTimeout, '"type":"agent_end"'],
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

// Mark a process session as already-reported so the exit-notification poller
// doesn't send a duplicate message for something the agent just observed.
function suppressNotify(id: string): void {
	const meta = readMeta(id);
	if (meta && meta.kind === "process" && !meta.notified) {
		meta.notified = true;
		writeMeta(id, meta);
	}
}

function enableNotify(id: string): void {
	const meta = readMeta(id);
	if (meta && meta.kind === "process" && meta.notified) {
		meta.notified = false;
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
): Promise<WaitOutcome> {
	const t = limitMs != null ? `${Math.ceil(limitMs / 1000)}s` : "0";

	if (expectPattern) {
		const e = await bs(["expect", "-s", id, "--timeout", t, expectPattern], { signal });
		if (signal?.aborted || e.code === 130) {
			return { id, kind: "interrupted", ok: false, text: `wait for ${id} was interrupted.` };
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
		// An explicit wait owns completion delivery. Mark it before blocking so
		// the exit poller cannot race us and inject a duplicate notification.
		suppressNotify(id);
		const w = await bs(["wait", "-s", id, "--timeout", t], { signal });
		if (signal?.aborted || w.code === 130) {
			enableNotify(id);
			return { id, kind: "interrupted", ok: false, text: `wait for ${id} was interrupted.` };
		}
		if (w.code === 124) {
			// 124 is ambiguous (timeout vs child exiting 124) — disambiguate.
			const st0 = await statusOf(id);
			if (st0?.state === "running") {
				enableNotify(id);
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

	const st = await statusOf(id);
	if (!st) {
		return { id, kind: "exited", ok: false, text: `No such session: ${id}` };
	}
	suppressNotify(id); // the agent sees the exit here; don't notify again
	const meta = readMeta(id);
	const workerDead = st.state === "dead" && st.exit_code == null;
	const ok = st.exit_code === 0;
	const output = await inlineOutput(id, st);
	return {
		id,
		kind: "exited",
		ok,
		text:
			`Process ${id}${meta?.command ? ` (${meta.command})` : ""} ` +
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

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let pollTimer: ReturnType<typeof setInterval> | undefined;

	// Exit notifications for kind=process sessions: the poller detects
	// running→exited transitions and injects ONE message (triggerTurn) so an
	// agent that ended its turn after babysit_run is resumed automatically —
	// the old `process` tool contract. Kills via babysit_kill and exits already
	// reported by babysit_wait are suppressed via meta.notified.
	async function notifyEndedProcesses(): Promise<void> {
		const { sessions } = await listSessions();
		for (const s of sessions) {
			if (s.state === "running") continue;
			const meta = readMeta(s.id);
			if (!meta || meta.kind !== "process" || meta.notified) continue;
			// Delay delivery by one poll interval. This gives an agent that chose
			// babysit_wait immediately after babysit_run enough time to claim the
			// completion and suppress the otherwise duplicate automatic message.
			if (!meta.completionObservedAt) {
				meta.completionObservedAt = Date.now();
				writeMeta(s.id, meta);
				continue;
			}
			if (Date.now() - meta.completionObservedAt < POLL_MS) continue;
			meta.notified = true;
			writeMeta(s.id, meta);
			const ok = s.exit_code === 0;
			const status: DisplayStatus = ok
				? "success"
				: s.state === "dead" || s.exit_code == null
					? "terminated"
					: "failed";
			const output = await inlineOutput(s.id, s);
			const runtime = meta.startedAt
				? `${Math.round((Date.now() - meta.startedAt) / 1000)}s`
				: "?";
			const summary = ok
				? `Process "${s.id}" completed successfully after ${runtime}.`
				: s.state === "dead" || s.exit_code == null
					? `Process "${s.id}" was terminated after ${runtime}.`
					: `Process "${s.id}" exited with code ${s.exit_code} after ${runtime}.`;
			pi.sendMessage(
				{
					customType: "pi-babysit-process-end",
					content:
						`${summary}\nCommand: ${meta.command ?? "?"}\nLog: ${logPath(s.id)}${output}` +
						`\n\nThis is the automatic process-end notification. Do not call babysit_check just to re-verify. Inspect the log only when needed with babysit_check { id: ${JSON.stringify(s.id)}, lines, pattern? }; never read it in full.`,
					display: true,
					details: {
						id: s.id,
						exitCode: s.exit_code,
						success: ok,
						status,
						runtime,
						logPath: logPath(s.id),
					},
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
		}
	}

	const refreshWidget = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const active = (await listSessions()).sessions.filter((s) => s.state === "running");
		const subs = active.filter((s) => kindOf(s.id) === "subagent");
		const procs = active.length - subs.length;
		const doneFlags = await Promise.all(subs.map((s) => isTaskDone(s.id)));
		const idle = doneFlags.filter(Boolean).length;
		const lines = renderWidgetLines(procs, subs.length - idle, idle);
		// Per-session elapsed time (live: refreshed every poll tick).
		const doneById = new Map(subs.map((s, i) => [s.id, doneFlags[i]]));
		const tails = await Promise.all(
			active.map((s) => widgetTail(s.id, kindOf(s.id) === "subagent")),
		);
		active.forEach((s, i) => {
			const isSub = kindOf(s.id) === "subagent";
			const tag = isSub ? (doneById.get(s.id) ? "sub idle" : "sub") : "proc";
			const el = elapsedOf(s.id);
			const header = `  ⏳ ${s.id} [${tag}]${el ? ` ${el}` : ""}`;
			if (tails[i].length === 1) {
				// Single tail line: keep it on the same row as the header.
				lines.push(`${header}  │ ${tails[i][0]}`);
			} else {
				lines.push(header);
				for (const t of tails[i]) lines.push(`     │ ${t}`);
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
		};
		const status =
			d.status ?? (d.success ? "success" : d.exitCode == null ? "terminated" : "failed");
		const box = new Box(1, 1, (t) => theme.bg("toolSuccessBg", t));
		box.addChild(new Text(renderStatus(status, theme, "babysit_run"), 0, 0));
		box.addChild(new Text(theme.fg("toolOutput", content), 0, 0));
		return box;
	});

	let polling = false;
	pi.on("session_start", async (_event, ctx) => {
		// Session-local registry: scope the babysit root to this pi session so
		// other sessions' processes/subagents are invisible here. Resuming a
		// session keeps the same id, so its sessions come back with it.
		try {
			ROOT = path.join(ROOT_BASE, ctx.sessionManager.getSessionId());
		} catch {
			ROOT = ROOT_BASE;
		}
		// Warn early if the binary is missing so the user isn't surprised only when
		// a tool later fails. Tools/commands still enforce it via requireBabysit.
		if (ctx.hasUI && !(await babysitAvailable())) {
			ctx.ui.notify(babysitPreflightError ?? INSTALL_HINT, "warn");
		}
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = setInterval(() => {
			// Skip if the previous (async) poll hasn't finished, so slow babysit
			// calls never stack up.
			if (polling) return;
			polling = true;
			Promise.all([notifyEndedProcesses(), refreshWidget(ctx)])
				.catch(() => {
					/* ignore poll errors */
				})
				.finally(() => {
					polling = false;
				});
		}, POLL_MS);
	});

	pi.on("session_shutdown", async () => {
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = undefined;
	});

	pi.on("tool_call", async (event) => {
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
	pi.registerTool({
		name: "babysit_run",
		label: "Babysit: run",
		description:
			"Run any shell command in a supervised babysit session. Commands that finish within a short " +
			"grace period return completion metadata immediately; longer commands continue in the background " +
			"and trigger an automatic notification on exit. Complete output is returned inline only when it is " +
			"small; larger output stays in the log path for bounded inspection with babysit_check. " +
			"In non-interactive mode (`pi -p`, no UI), process mode blocks until exit because there is no " +
			"notification loop. Two modes: (1) `command` — run any shell command, including builds, tests, " +
			"dev servers, watchers, and interactive TUIs; you can type into it with babysit_send and read " +
			"its screen with babysit_check. If a worker disappears during startup without recording an exit, " +
			"`retryOnWorkerDeath` can retry one idempotent command once. " +
			"(2) `profile: \"subagent\"` + `task` — spawn a pi subagent that works on the task in the " +
			"background; poll with babysit_check, steer with babysit_send, block with babysit_wait, " +
			"stop with babysit_kill.",
		promptSnippet:
			"Run any shell command with context-safe captured output; quick commands return metadata, longer ones continue in background",
		promptGuidelines: [
			"Use babysit_run as the default for shell commands, not only long-running work. Small output is returned directly; large stdout/stderr stays out of model context in the returned log path. Give meaningful commands a clear stable `name`.",
			"Inspect a babysit log with babysit_check { id, lines, pattern? }; never read or cat a potentially large log file in full.",
			"After babysit_run { command } starts a process, end your response immediately so the automatic process-end notification can resume you; NEVER poll with babysit_check or sleep. Set continueAfterStart: true only when you have immediate, specific, non-polling work to do next. Call babysit_wait when you must consume the result inside the current turn (optionally with `expect` to wait for a readiness line like 'listening on').",
			"If a babysit worker is killed externally, babysit_run reports it as worker-dead rather than hanging. Set retryOnWorkerDeath: true only for safe, idempotent commands; it retries at most once and may otherwise duplicate side effects.",
			"babysit_run gives full PTY control: drive interactive programs (installers, wizards, REPLs) with babysit_send (text or named keys) and read the rendered screen with babysit_check { screen: true }.",
			"Delegate self-contained tasks (codebase recon, a parallelizable subtask, work that would pollute your context) with babysit_run { profile: \"subagent\", task }. Launch several for independent subtasks; they run concurrently.",
			"After spawning subagents, do not idle-wait and do not end your turn to wait for them: keep making progress, then call babysit_wait (ids + mode any/all) when you need their results. Steer or send follow-up tasks with babysit_send; kill runaways with babysit_kill.",
		],
		parameters: Type.Object({
			command: Type.Optional(
				Type.String({
					description: "Shell command to run (process mode). Mutually exclusive with profile/task.",
				}),
			),
			name: Type.Optional(
				Type.String({
					description: "Friendly stable name for a process (becomes the session id), e.g. 'cargo-build'.",
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

			// --- process mode ---
			if (!isSubagent) {
				const spawnOpts: ProcOpts = {
					name: params.name,
					command: params.command as string,
					cwd: ctx.cwd,
					timeout: params.timeout,
					idleTimeout: params.idleTimeout,
					pty: params.pty ?? true,
				};
				let res = await spawnProcess(spawnOpts);
				if ("error" in res) {
					return {
						content: [{ type: "text", text: `Failed to start process: ${res.error}` }],
						isError: true,
						details: {},
					};
				}
				await refreshWidget(ctx);

				// One-shot / non-interactive mode (e.g. `pi -p`): there is no live
				// event loop to deliver the exit notification, and ending the turn
				// would exit pi entirely — orphaning the babysat process and losing
				// the session (the agent "settles" the moment it is told the turn will
				// stop). So block inline like a normal command and return the full
				// outcome in THIS turn. The process still runs under babysit (logged,
				// killable), we just wait for it here instead of fire-and-forget.
				if (!ctx.hasUI) {
					let outcome = await waitForExit(res.id, parseDurMs(params.timeout), _signal);
					let retried = false;
					if (params.retryOnWorkerDeath && outcome.status?.state === "dead" && outcome.status.exit_code == null) {
						const retry = await spawnProcess(spawnOpts);
						if (!("error" in retry)) {
							res = retry;
							retried = true;
							outcome = await waitForExit(res.id, parseDurMs(params.timeout), _signal);
						}
					}
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
				// period; if it exits, return only lifecycle metadata + log path now.
				// A timeout means it is genuinely background work and follows the normal
				// parked-turn / automatic-notification contract below.
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
					const outcome = await waitForExit(res.id, null, _signal);
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

			const res = await spawnSubagent({
				agent,
				task: params.task as string,
				model: params.model,
				tools: params.tools,
				cwd: ctx.cwd,
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

			await refreshWidget(ctx);
			return {
				content: [
					{
						type: "text",
						text:
							`Subagent started (id: ${res.id})${agent ? ` [agent: ${agent.name}]` : ""}${res.model ? ` [model: ${res.model}]` : ""}.\n` +
							`Task accepted — running in the background; keep working (do NOT end your turn just to wait for it).\n` +
							`Poll:  babysit_check { id: "${res.id}" }\n` +
							`Wait:  babysit_wait  { id: "${res.id}" }\n` +
							`Human can watch/steer: /babysit (pick ${res.id})`,
					},
				],
				details: {
					id: res.id,
					kind: "subagent",
					agent: agent?.name,
					model: res.model,
					task: params.task,
					status: "started" satisfies DisplayStatus,
				},
			};
		},
		// The result label already includes "babysit_run"; suppress the default
		// call header so the tool name is not shown twice in adjacent lines.
		renderCall() {
			return new Container();
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
			const label = renderStatus(status, theme, "babysit_run");
			return new Text(content ? `${label}\n${theme.fg("toolOutput", content)}` : label, 0, 0);
		},
	});

	// ----- babysit_check ------------------------------------------------------
	pi.registerTool({
		name: "babysit_check",
		label: "Babysit: check",
		description:
			"Inspect babysit session(s). Without an id: lists all sessions (processes + subagents). " +
			"With an id: a process shows state + recent output, searches its log with `pattern`, " +
			"or captures the rendered screen with `screen: true`; a subagent shows live progress " +
			"(or raw log matches with `pattern`). Results are bounded by `lines` and clipped. " +
			"Do NOT poll this while merely waiting for a process to end — the exit notification is automatic.",
		promptSnippet: "Check status/progress of babysit sessions (processes and subagents)",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Session id. Omit to list all sessions." })),
			tools: Type.Optional(
				Type.Number({ description: "Subagent: how many recent tool calls to show (default 8, max 50)." }),
			),
			lines: Type.Optional(
				Type.Number({ description: "How many tail lines or latest matches to show (default 30, max 200)." }),
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
					return { content: [{ type: "text", text: "No babysit sessions." }], details: {} };
				}
				const lines = sessions.map((s) => {
					const meta = readMeta(s.id);
					const kind = meta?.kind ?? "process";
					const flag = s.note ? ` ⚑ ${s.note}` : "";
					const ec = s.exit_code != null ? ` exit=${s.exit_code}` : "";
					const what = (kind === "subagent" ? meta?.task : meta?.command) ?? "";
					const preview = what.length > 60 ? `${what.slice(0, 57)}…` : what;
					return `${s.id}  [${kind}] ${s.state}${ec}${flag}${preview ? `  — ${preview}` : ""}`;
				});
				return { content: [{ type: "text", text: lines.join("\n") }], details: { sessions } };
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
				const result = await searchLog(params.id, params.pattern, nLines, signal);
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
					content: [{ type: "text", text: `${header}\n${body}` }],
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
				if (meta?.command) header += `\ncommand: ${meta.command}`;
				header += `\nlog: ${logPath(params.id)}`;
				if (st.note) header += ` ⚑ ${st.note}`;
				parts.push(header);
				if (params.screen) {
					const sc = await bs(["screenshot", "-s", params.id, "--trim"]);
					parts.push(`--- screen ---\n${clip(sc.stdout.trimEnd()) || "(blank screen)"}`);
				} else {
					const tail = clip(
						(await bs(["log", "-s", params.id, "--tail", String(nLines)])).stdout.trimEnd(),
					);
					parts.push(tail ? `--- recent output ---\n${tail}` : "(no output yet)");
				}
				return {
					content: [{ type: "text", text: parts.join("\n") }],
					details: { status: st, kind: "process", logPath: logPath(params.id) },
				};
			}

			// --- subagent: analyze only the current task's slice ---
			const logArgs = ["log", "-s", params.id];
			if (meta?.promptOffset) logArgs.push("--since", String(meta.promptOffset));
			const prog = parseEvents((await bs(logArgs)).stdout);
			const nTools = Math.min(Math.max(1, params.tools ?? 8), 50);
			const recent = prog.toolCalls.slice(-nTools);

			const parts: string[] = [];
			let header = `[subagent] state=${st.state}`;
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
			header += ` turns=${prog.turns} tools=${prog.toolCalls.length}`;
			if (prog.tokens != null) header += ` ctx=${prog.tokens}`;
			if (prog.cost != null) header += ` $${prog.cost.toFixed(4)}`;
			if (st.note) header += ` ⚑ ${st.note}`;
			parts.push(header);

			if (prog.errorMsg) parts.push(`⚠ error: ${clip(prog.errorMsg, ANSWER_MAX_BYTES)}`);

			if (recent.length > 0) {
				const skipped = prog.toolCalls.length - recent.length;
				parts.push(
					`--- recent tool calls${skipped > 0 ? ` (+${skipped} earlier)` : ""} ---\n` +
						recent.map((t) => `  ${t.summary}`).join("\n"),
				);
			}

			if (prog.finalText.trim()) {
				parts.push(`--- answer so far ---\n${clip(prog.finalText.trim(), ANSWER_MAX_BYTES)}`);
			} else if (prog.toolCalls.length === 0 && st.state !== "running") {
				// Died before doing anything — show the log tail so the cause of
				// death (model error, crash, timeout) is visible, not hidden.
				const tail = clip((await bs(["log", "-s", params.id, "--tail", "15"])).stdout.trim());
				parts.push(tail ? `--- last output ---\n${tail}` : "(no output)");
			} else if (prog.toolCalls.length === 0) {
				parts.push("(starting up… no events yet)");
			} else {
				parts.push("(working… no answer text yet)");
			}

			return {
				content: [{ type: "text", text: parts.join("\n") }],
				details: { status: st, progress: prog, kind: "subagent" },
			};
		},
	});

	// ----- babysit_send -------------------------------------------------------
	pi.registerTool({
		name: "babysit_send",
		label: "Babysit: send",
		description:
			"Send input to a babysit session. Process: `text` types a line into its stdin (PTY), " +
			"`keys` presses named keys (Enter, Tab, Esc, Up/Down/Left/Right, C-c, F1…) — use with " +
			"babysit_check { screen: true } to drive interactive programs. Subagent: `text` is " +
			"STEERING while it works, or a NEW TASK when it is idle (mode: auto/steer/task) — this " +
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
						"Subagent only. auto (default): steer if mid-run, otherwise start a new task. steer/task force one behavior.",
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
			if (!params.text) {
				return {
					content: [{ type: "text", text: "Provide `text` (steering or follow-up task)." }],
					isError: true,
					details: {},
				};
			}
			let mode = params.mode ?? "auto";
			if (mode === "auto") {
				// isStreaming tells us whether an agent run is in flight right now.
				const gs = await sendRpc(params.id, { type: "get_state" });
				let streaming = true; // assume busy when unsure — steering is the safe default
				if (!("error" in gs)) {
					const r = await rpcResponse(params.id, gs.offset, "get_state", "10s");
					if (r.ok) streaming = Boolean((r.data as { isStreaming?: boolean })?.isStreaming);
				}
				mode = streaming ? "steer" : "task";
			}
			const cmd =
				mode === "steer"
					? { type: "steer", message: deliverableMessage("steering message", params.text) }
					: { type: "prompt", message: deliverableMessage("task", params.text) };
			const sent = await sendRpc(params.id, cmd);
			if ("error" in sent) {
				return {
					content: [{ type: "text", text: sent.error }],
					isError: true,
					details: {},
				};
			}
			const resp = await rpcResponse(params.id, sent.offset, cmd.type, "15s");
			if (!resp.ok) {
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
					promptOffset: sent.offset,
					model: meta?.model,
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
		},
	});

	// ----- babysit_wait -------------------------------------------------------
	pi.registerTool({
		name: "babysit_wait",
		label: "Babysit: wait",
		description:
			"Block until babysit session(s) finish, then return the result. A process finishes " +
			"when it EXITS (or, with `expect`, as soon as a regex appears in its output — e.g. wait " +
			"for 'listening on' before hitting a dev server). A subagent finishes when its current " +
			"TASK completes (the session stays alive for follow-ups). Pass `id` for one session, or " +
			"`ids` + `mode`: 'all' (default) waits for every one, 'any' returns on the FIRST finisher. " +
			"Prefer ending your turn over babysit_wait when a process result is not needed this turn — " +
			"the exit notification will resume you.",
		promptSnippet: "Block until session(s) finish — process exit / output pattern / subagent task done",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Session id (single wait)." })),
			ids: Type.Optional(
				Type.Array(Type.String(), {
					description: "Session ids for a multi-wait (use with mode).",
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
			const limitMs = parseDurMs(params.timeout);

			if (ids.length === 1) {
				const r = await waitFor(ids[0], limitMs, signal, params.expect);
				return {
					content: [{ type: "text", text: r.text }],
					isError: !r.ok,
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
				return {
					content: [
						{
							type: "text",
							text: results.map((r) => `── ${r.id} [${r.kind}] ──\n${r.text}`).join("\n\n"),
						},
					],
					isError: !ok,
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
				return {
					content: [
						{
							type: "text",
							text:
								`First to finish: ${first.id} [${first.kind}]` +
								(others.length ? ` — still waiting-able: ${others.join(", ")}` : "") +
								`\n\n${first.text}`,
						},
					],
					isError: !first.ok,
					details: { first: { id: first.id, kind: first.kind, ok: first.ok }, remaining: others },
				};
			} finally {
				ctrl.abort();
				signal?.removeEventListener("abort", onOuterAbort);
			}
		},
	});

	// ----- babysit_kill -------------------------------------------------------
	pi.registerTool({
		name: "babysit_kill",
		label: "Babysit: kill",
		description: "Terminate a babysit session (process or subagent).",
		promptSnippet: "Terminate a babysit session",
		parameters: Type.Object({ id: Type.String({ description: "Session id." }) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			await requireBabysit();
			suppressNotify(params.id); // tool-initiated kill → no end notification
			const r = await bs(["kill", "-s", params.id, "--json"]);
			await refreshWidget(ctx);
			if (r.code !== 0) {
				return {
					content: [{ type: "text", text: r.stderr || "kill failed" }],
					isError: true,
					details: {},
				};
			}
			return { content: [{ type: "text", text: `Killed ${params.id}.` }], details: {} };
		},
	});

	// ----- /babysit -----------------------------------------------------------
	// Arrow up/down picker over all sessions (like /stash). Renders an INLINE
	// snapshot (no tmux): running process → current rendered screen + recent
	// output + a copy-paste `babysit attach` take-over hint; running subagent →
	// read-only progress; finished → summary. Re-run to refresh.
	pi.registerCommand("babysit", {
		description: "Pick a babysit session (↑/↓) to snapshot/inspect",
		handler: async (_args, ctx) => {
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
				const prog = parseEvents((await bs(["log", "-s", picked.id])).stdout);
				const stats =
					`turns=${prog.turns} tools=${prog.toolCalls.length}` +
					(prog.tokens != null ? ` ctx=${prog.tokens}` : "") +
					(prog.cost != null ? ` $${prog.cost.toFixed(4)}` : "");
				const body =
					(prog.finalText.trim() ||
						prog.errorMsg ||
						(await bs(["log", "-s", picked.id, "--tail", "20"])).stdout.trim() ||
						"(no output)") +
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
