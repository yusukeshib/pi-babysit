/**
 * self-reap.ts — loaded INTO each subagent (`pi --mode rpc --extension …`).
 *
 * A subagent whose task is done becomes an idle RPC worker and, without this,
 * lingers until the absolute `--timeout` (default 15m) or an explicit
 * `babysit_kill`. That leaves dead-weight `pi` processes around for minutes.
 *
 * This reaper makes a finished subagent self-terminate after a short grace
 * window, WITHOUT breaking the two reasons it's normally kept alive:
 *
 *   1. Resume — `babysit_send` injects a follow-up task, which fires
 *      `before_agent_start` and CANCELS the pending reap. So a subagent you
 *      keep talking to never dies; only a genuinely-abandoned one does.
 *   2. Process parks — a turn that ends only to await a background-process
 *      exit notification (babysit_run inside the subagent, or the legacy
 *      `process` tool) also settles the agent, but pi resumes on its own. We
 *      detect a parked toolResult anywhere in that run (same rule the parent
 *      uses) and DON'T schedule a reap, so a subagent waiting on a long
 *      build/test is never false-killed.
 *
 * Grace window: $PI_BABYSIT_REAP_AFTER (e.g. "30s", "2m"), default 120s.
 * Set to "off"/"none"/"0" to disable (falls back to the absolute --timeout).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Keep in sync with NOTIFY_MARKER in index.ts (not imported: this file is
// loaded standalone into the subagent process via --extension).
const NOTIFY_MARKER = "[notify-on-exit]";

function parseDurMs(s: string | undefined): number | null {
	if (!s || s === "none" || s === "off" || s === "0") return null;
	const m = /^(\d+)(ms|s|m|h)?$/.exec(s.trim());
	if (!m) return null;
	const n = Number(m[1]);
	const u = m[2] ?? "s";
	return n * (u === "ms" ? 1 : u === "s" ? 1000 : u === "m" ? 60_000 : 3_600_000);
}

// Same parked-turn rule as the parent: scan the run because models sometimes
// add an assistant note after the marker-bearing tool result.
function isParked(
	messages: { role?: string; toolName?: string; content?: unknown }[] | undefined,
): boolean {
	if (!messages) return false;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "toolResult") continue;
		if (message.toolName === "process") return true; // legacy pi-processes
		if (message.toolName !== "babysit_run") continue;
		try {
			const serialized = JSON.stringify(message.content ?? null);
			if (serialized === "null" || serialized.includes(NOTIFY_MARKER)) return true;
		} catch {
			return true;
		}
	}
	return false;
}

export default function (pi: ExtensionAPI) {
	const graceMs = parseDurMs(
		process.env.PI_BABYSIT_REAP_AFTER ?? process.env.PI_SUBAGENT_REAP_AFTER ?? "120s",
	);
	if (graceMs == null) return; // reaping disabled

	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastEndWasParked = false;
	const cancel = () => {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
	};

	// A new task/turn is starting — the subagent is wanted again. Stand down.
	pi.on("before_agent_start", () => {
		cancel();
		lastEndWasParked = false;
	});

	pi.on("agent_end", (event) => {
		const messages = (
			event as { messages?: { role?: string; toolName?: string; content?: unknown }[] }
		).messages;
		lastEndWasParked = isParked(messages);
	});

	// agent_end can precede automatic retries, compaction retries, and queued
	// continuations. Start the grace timer only once Pi is truly settled.
	pi.on("agent_settled", (_event, ctx) => {
		cancel();
		if (lastEndWasParked) return;
		timer = setTimeout(() => {
			// Graceful shutdown emits session_shutdown for every loaded extension.
			ctx.shutdown();
		}, graceMs);
		timer.unref?.();
	});
}
