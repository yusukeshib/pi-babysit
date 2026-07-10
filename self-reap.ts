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
 *      `process` tool) also emits `agent_end`, but pi resumes on its own. We
 *      detect that (last message is a parked toolResult, same rule the parent
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

// Same parked-turn rule as the parent (see index.ts isParkedToolResult):
// a babysit_run process start stamps NOTIFY_MARKER into its tool result; that
// as the LAST message means "parked awaiting the exit notification".
function isParked(
	last: { role?: string; toolName?: string; content?: unknown } | undefined,
): boolean {
	if (!last || last.role !== "toolResult") return false;
	if (last.toolName === "process") return true; // legacy pi-processes
	if (last.toolName !== "babysit_run") return false;
	try {
		const s = JSON.stringify(last.content ?? null);
		if (s === "null") return true; // unsure — never reap a possible build wait
		return s.includes(NOTIFY_MARKER);
	} catch {
		return true;
	}
}

export default function (pi: ExtensionAPI) {
	const graceMs = parseDurMs(
		process.env.PI_BABYSIT_REAP_AFTER ?? process.env.PI_SUBAGENT_REAP_AFTER ?? "120s",
	);
	if (graceMs == null) return; // reaping disabled

	let timer: ReturnType<typeof setTimeout> | undefined;
	const cancel = () => {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
	};

	// A new task/turn is starting — the subagent is wanted again. Stand down.
	pi.on("before_agent_start", () => {
		cancel();
	});

	pi.on("agent_end", (event) => {
		cancel(); // supersede any earlier schedule with this end's decision

		const msgs = (
			event as { messages?: { role?: string; toolName?: string; content?: unknown }[] }
		).messages;
		if (isParked(msgs?.[msgs.length - 1])) return;

		timer = setTimeout(() => {
			// Clean exit: babysit sees the child exit and marks the session done,
			// so it drops out of the session list/widget instead of idling.
			process.exit(0);
		}, graceMs);
		// Don't let this timer keep the event loop alive on its own.
		timer.unref?.();
	});
}
