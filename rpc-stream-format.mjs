/**
 * rpc-stream-format.mjs — pi-babysit's subagent log format for `pi --mode rpc`.
 *
 * The log is a subset of Pi's standard RPC event stream:
 *
 * - The first line is a header:
 *   {"type":"pi_babysit_stream","version":1,"profile":"compact"|"standard"}
 * - Standard events keep their type and field meaning. The compact profile only
 *   OMITS fields whose value is exactly reproducible from other lines; it never
 *   reshapes a field.
 * - pi-babysit's own data is carried by separate `pi_babysit_*` events, never by
 *   extra fields on standard events. Standard consumers can ignore them.
 *
 * Compact profile v1 omissions (see README "Subagent log format"):
 * - message_start of a non-assistant message: `message.content` and
 *   `message.details`, only when the next line is a message_end carrying an
 *   identical message.
 * - tool_execution_end with `isError !== true`: `result.content` and
 *   `result.details`. They equal the toolResult message_end for the same
 *   toolCallId; otherwise a `pi_babysit_tool_execution_result` event carries the
 *   original values.
 * - turn_end `message` / `toolResults` and agent_end `messages`: only when equal
 *   to the value derived from message_end events by createRunTracker.
 *
 * Every agent_end is preceded by {"type":"pi_babysit_agent_end","parked":bool}.
 *
 * createRpcEventRestorer() turns a compact log back into standard events.
 */
import { createHash } from "node:crypto";

export const STREAM_HEADER_TYPE = "pi_babysit_stream";
export const STREAM_VERSION = 1;
export const AGENT_END_MARKER_TYPE = "pi_babysit_agent_end";
export const TOOL_RESULT_EVENT_TYPE = "pi_babysit_tool_execution_result";
const BABYSIT_EVENT_PREFIX = "pi_babysit_";

export function streamHeader(profile) {
	return { type: STREAM_HEADER_TYPE, version: STREAM_VERSION, profile };
}

/** True when the agent run ended with a background process whose exit will resume it. */
export function isParkedMessages(messages) {
	if (!Array.isArray(messages)) return false;
	const terminalCounts = new Map();
	const addTerminal = (id) => terminalCounts.set(id, (terminalCounts.get(id) ?? 0) + 1);

	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "toolResult") continue;
		if (message.toolName === "babysit_wait") {
			const status = message.details?.status;
			if (
				status &&
				typeof status === "object" &&
				typeof status.id === "string" &&
				typeof status.state === "string" &&
				status.state !== "running"
			) {
				addTerminal(status.id);
			}
			for (const result of message.details?.results ?? []) {
				if (result.kind === "exited" && typeof result.id === "string") addTerminal(result.id);
			}
			const first = message.details?.first;
			if (first?.kind === "exited" && typeof first.id === "string") addTerminal(first.id);
			continue;
		}
		if (
			message.toolName === "babysit_kill" &&
			typeof message.details?.id === "string" &&
			["exited", "killed", "dead"].includes(String(message.details.status))
		) {
			addTerminal(message.details.id);
			continue;
		}
		if (message.toolName === "process") return true;
		if (message.toolName !== "babysit_run") continue;
		const text = Array.isArray(message.content)
			? message.content
					.filter((part) => part?.type === "text" && typeof part.text === "string")
					.map((part) => part.text)
					.join("")
			: typeof message.content === "string"
				? message.content
				: "";
		const textMatch = /^Process started \(id: ([^)]+)\)\. \[notify-on-exit\]\nLog: /.exec(text);
		const structuredStart =
			message.details?.kind === "process" && message.details.status === "started";
		if (!structuredStart && !textMatch) continue;
		const id = typeof message.details?.id === "string" ? message.details.id : textMatch?.[1];
		if (!id) return true;
		const count = terminalCounts.get(id) ?? 0;
		if (count === 0) return true;
		if (count === 1) terminalCounts.delete(id);
		else terminalCounts.set(id, count - 1);
	}
	return false;
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Derives turn_end and agent_end payloads from message_end events. The
 * compactor and the restorer must feed it the same event sequence; `project`
 * maps each message to the stored value (a hash in the compactor, the message
 * itself in the restorer).
 */
export function createRunTracker(project) {
	let run = null;
	let turn = [];
	return {
		observe(event) {
			switch (event?.type) {
				case "agent_start":
					run = [];
					turn = [];
					break;
				case "turn_start":
					turn = [];
					break;
				case "message_end":
					if (isObject(event.message)) {
						const value = project(event.message);
						run?.push(value);
						turn.push({ role: event.message.role, value });
					}
					break;
				case "agent_end":
					run = null;
					turn = [];
					break;
			}
		},
		/** `{ message, toolResults }` for the current turn, or null when not derivable. */
		turnEnd() {
			let index = turn.length - 1;
			while (index >= 0 && turn[index].role !== "assistant") index--;
			if (index < 0) return null;
			return {
				message: turn[index].value,
				toolResults: turn
					.slice(index + 1)
					.filter((entry) => entry.role === "toolResult")
					.map((entry) => entry.value),
			};
		},
		/** Messages of the current agent run, or null when no agent_start was observed. */
		agentEndMessages() {
			return run ? [...run] : null;
		},
	};
}

const hashOf = (value) => createHash("sha1").update(JSON.stringify(value) ?? "").digest("base64");
const sameList = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

/** Pick only the keys present on `source`, preserving JSON absent-vs-present. */
function pickPresent(source, keys) {
	const out = {};
	for (const key of keys) if (isObject(source) && key in source && source[key] !== undefined) out[key] = source[key];
	return out;
}

function withoutKeys(source, keys) {
	const out = { ...source };
	for (const key of keys) delete out[key];
	return out;
}

const PAYLOAD_KEYS = ["content", "details"];

/**
 * Old Pi releases repeat the cumulative assistant message on every
 * message_update. Pi >= 1.4 writes delta-only updates, which is the standard
 * wire form; normalize older streams to it.
 */
function normalizeMessageUpdate(event) {
	const { message: _cumulativeMessage, assistantMessageEvent, ...rest } = event;
	if (!isObject(assistantMessageEvent)) return rest;
	const { partial: _cumulativePartial, ...deltaEvent } = assistantMessageEvent;
	return { ...rest, assistantMessageEvent: deltaEvent };
}

function eventTypeOf(line) {
	return /^\{"type":"([^"\\]+)"/.exec(line)?.[1];
}

/**
 * Stateful line transformer for the proxy. `push(line)` returns the lines to
 * write (possibly none while a message_start is held); `end()` flushes.
 */
export function createRpcLogCompactor({ mode = "compact" } = {}) {
	const compact = mode === "compact";
	let headerSent = false;
	let heldStart = null; // { line, json, event }
	const pendingResults = new Map(); // toolCallId -> JSON of original { content, details }
	const tracker = createRunTracker(hashOf);

	const correctionLine = (toolCallId, originalJson) =>
		`{"type":${JSON.stringify(TOOL_RESULT_EVENT_TYPE)},"toolCallId":${JSON.stringify(toolCallId)},"result":${originalJson}}`;
	const flushPendingResults = (out) => {
		for (const [toolCallId, originalJson] of pendingResults) out.push(correctionLine(toolCallId, originalJson));
		pendingResults.clear();
	};
	const releaseHeld = (out) => {
		if (!heldStart) return;
		out.push(heldStart.line);
		heldStart = null;
	};

	function push(line) {
		const out = [];
		if (!headerSent) {
			out.push(JSON.stringify(streamHeader(compact ? "compact" : "standard")));
			headerSent = true;
		}
		if (!line.trimStart().startsWith("{")) {
			releaseHeld(out);
			out.push(line);
			return out;
		}
		const type = eventTypeOf(line);
		if (type !== "message_end") releaseHeld(out);
		// Delta-only message_update lines are the bulk of the stream; skip the
		// parse when there is nothing to strip. Inside JSON strings a quote is
		// escaped, so these key patterns cannot match text.
		if (type === "message_update" && !line.includes('"message":') && !line.includes('"partial":')) {
			out.push(line);
			return out;
		}
		if (type === undefined || (compact ? false : type !== "message_update")) {
			out.push(line);
			return out;
		}

		let event;
		try {
			event = JSON.parse(line);
		} catch {
			releaseHeld(out);
			out.push(line);
			return out;
		}
		if (event?.type === "message_update") {
			out.push(JSON.stringify(normalizeMessageUpdate(event)));
			return out;
		}

		switch (event?.type) {
			case "message_start": {
				const message = event.message;
				if (isObject(message) && message.role !== "assistant") {
					heldStart = { line, json: JSON.stringify(message), event };
					return out;
				}
				out.push(line);
				return out;
			}
			case "message_end": {
				const message = event.message;
				tracker.observe(event);
				if (message?.role === "toolResult" && pendingResults.has(message.toolCallId)) {
					const originalJson = pendingResults.get(message.toolCallId);
					pendingResults.delete(message.toolCallId);
					if (originalJson !== JSON.stringify(pickPresent(message, PAYLOAD_KEYS))) {
						out.push(correctionLine(message.toolCallId, originalJson));
					}
				}
				if (heldStart) {
					if (heldStart.json === JSON.stringify(message)) {
						const startMessage = withoutKeys(heldStart.event.message, PAYLOAD_KEYS);
						out.push(JSON.stringify({ ...heldStart.event, message: startMessage }));
					} else {
						out.push(heldStart.line);
					}
					heldStart = null;
				}
				out.push(line);
				return out;
			}
			case "tool_execution_end": {
				if (event.isError === true || !isObject(event.result) || typeof event.toolCallId !== "string") {
					out.push(line);
					return out;
				}
				pendingResults.set(event.toolCallId, JSON.stringify(pickPresent(event.result, PAYLOAD_KEYS)));
				out.push(JSON.stringify({ ...event, result: withoutKeys(event.result, PAYLOAD_KEYS) }));
				return out;
			}
			case "turn_end": {
				const derived = tracker.turnEnd();
				let compacted = event;
				if (derived && "message" in event && hashOf(event.message) === derived.message) {
					compacted = withoutKeys(compacted, ["message"]);
				}
				if (
					derived &&
					Array.isArray(event.toolResults) &&
					sameList(event.toolResults.map(hashOf), derived.toolResults)
				) {
					compacted = withoutKeys(compacted, ["toolResults"]);
				}
				out.push(compacted === event ? line : JSON.stringify(compacted));
				return out;
			}
			case "agent_end": {
				flushPendingResults(out);
				out.push(JSON.stringify({ type: AGENT_END_MARKER_TYPE, parked: isParkedMessages(event.messages) }));
				const derived = tracker.agentEndMessages();
				tracker.observe(event);
				if (derived && Array.isArray(event.messages) && sameList(event.messages.map(hashOf), derived)) {
					out.push(JSON.stringify(withoutKeys(event, ["messages"])));
				} else {
					out.push(line);
				}
				return out;
			}
			default:
				tracker.observe(event);
				out.push(line);
				return out;
		}
	}

	function end() {
		const out = [];
		releaseHeld(out);
		flushPendingResults(out);
		return out;
	}

	return { push, end };
}

/**
 * Turns a pi-babysit log back into standard Pi RPC events. Feed parsed JSON
 * events from the start of the log; `push` returns the restored events to
 * consume now and `end` flushes anything still held.
 *
 * Restoration is exact for content. Ordering is preserved except that a
 * compacted tool_execution_end is released together with the toolResult
 * message for the same toolCallId.
 */
export function createRpcEventRestorer() {
	let compact = false;
	let heldStart = null;
	const pendingEnds = new Map(); // toolCallId -> compacted tool_execution_end
	const tracker = createRunTracker((message) => message);

	const releasePendingEnd = (out, toolCallId, payload) => {
		const event = pendingEnds.get(toolCallId);
		if (!event) return;
		pendingEnds.delete(toolCallId);
		out.push({ ...event, result: { ...event.result, ...payload } });
	};
	const releaseHeld = (out) => {
		if (!heldStart) return;
		out.push(heldStart);
		heldStart = null;
	};
	const flushPendingEnds = (out) => {
		for (const event of pendingEnds.values()) out.push(event);
		pendingEnds.clear();
	};

	function push(event) {
		const out = [];
		const type = event?.type;
		if (type === STREAM_HEADER_TYPE) {
			compact = event.profile === "compact" && event.version === STREAM_VERSION;
			return out;
		}
		if (typeof type === "string" && type.startsWith(BABYSIT_EVENT_PREFIX)) {
			if (type === TOOL_RESULT_EVENT_TYPE && typeof event.toolCallId === "string") {
				releasePendingEnd(out, event.toolCallId, pickPresent(event.result, PAYLOAD_KEYS));
			}
			return out;
		}
		if (!compact) return [event];
		if (type !== "message_end") releaseHeld(out);

		switch (type) {
			case "message_start":
				if (isObject(event.message) && event.message.role !== "assistant" && !("content" in event.message)) {
					heldStart = event;
					return out;
				}
				out.push(event);
				return out;
			case "message_end": {
				tracker.observe(event);
				const message = event.message;
				if (message?.role === "toolResult") {
					releasePendingEnd(out, message.toolCallId, pickPresent(message, PAYLOAD_KEYS));
				}
				if (heldStart) {
					out.push({ ...heldStart, message: { ...heldStart.message, ...pickPresent(message, PAYLOAD_KEYS) } });
					heldStart = null;
				}
				out.push(event);
				return out;
			}
			case "tool_execution_end":
				if (
					event.isError !== true &&
					typeof event.toolCallId === "string" &&
					isObject(event.result) &&
					!("content" in event.result) &&
					!("details" in event.result)
				) {
					pendingEnds.set(event.toolCallId, event);
					return out;
				}
				out.push(event);
				return out;
			case "turn_end": {
				const derived = tracker.turnEnd();
				const restored = { ...event };
				if (!("message" in event) && derived) restored.message = derived.message;
				if (!("toolResults" in event) && derived) restored.toolResults = derived.toolResults;
				out.push(restored);
				return out;
			}
			case "agent_end": {
				flushPendingEnds(out);
				const derived = tracker.agentEndMessages();
				tracker.observe(event);
				out.push(!("messages" in event) && derived ? { ...event, messages: derived } : event);
				return out;
			}
			default:
				tracker.observe(event);
				out.push(event);
				return out;
		}
	}

	function end() {
		const out = [];
		releaseHeld(out);
		flushPendingEnds(out);
		return out;
	}

	return { push, end };
}
