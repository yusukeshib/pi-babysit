#!/usr/bin/env node
/**
 * format-stream.mjs — human-readable view for a `pi --mode rpc` event stream.
 *
 * This filter sits on the interactive attach path via `babysit run --view-cmd`.
 * It accepts both Pi's raw cumulative updates and pi-babysit's compact deltas,
 * then prints a colored, incrementally streamed transcript so a human sees
 * turns, thinking, tool calls and answers instead of a JSON firehose.
 */
import * as readline from "node:readline";

const C = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	bold: "\x1b[1m",
	gray: "\x1b[90m",
	cyan: "\x1b[36m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
	blue: "\x1b[34m",
};
// The attach client terminal is in raw mode (OPOST off), so a bare "\n"
// moves down without returning to column 0 and the transcript stair-steps.
// Normalize every newline (including ones inside model text) to "\r\n".
const out = (s) => process.stdout.write(String(s).replace(/\r?\n/g, "\r\n"));
const trunc = (s, n = 72) => {
	s = String(s ?? "");
	return s.length > n ? `${s.slice(0, n - 1)}\u2026` : s;
};

function summarizeTool(name, a = {}) {
	switch (name) {
		case "bash":
			return `$ ${trunc(a.command)}`;
		case "read":
			return `read ${trunc(a.file_path ?? a.path)}`;
		case "write":
			return `write ${trunc(a.file_path ?? a.path)}`;
		case "edit":
			return `edit ${trunc(a.file_path ?? a.path)}`;
		case "grep":
			return `grep /${trunc(a.pattern, 40)}/`;
		case "find":
			return `find ${trunc(a.pattern ?? a.path, 40)}`;
		case "ls":
			return `ls ${trunc(a.path)}`;
		default:
			return trunc(JSON.stringify(a), 48);
	}
}

// Join the text of a given block kind ("text" or "thinking") in a message's
// content array. Unfiltered RPC streams repeat the whole growing message;
// pi-babysit's compact stream instead retains only assistantMessageEvent.delta.
function blockText(content, kind) {
	if (!Array.isArray(content)) return "";
	let s = "";
	for (const c of content) {
		if (kind === "text" && c.type === "text" && c.text) s += c.text;
		if (kind === "thinking" && c.type === "thinking") s += c.thinking ?? c.text ?? "";
	}
	return s;
}

const emitted = new Map(); // id -> {think, text, hThink, hText}
let turn = 0;

// Every visual unit (thinking, answer, tool call, error) is a "block": it
// starts with a marker glyph on its own line. openBlock() is the single
// place that emits the line break, so spacing stays consistent no matter
// the event order — one block per line group, no blank lines in between.
const openBlock = () => {
	out("\n");
};

function messageState(id = `t${turn}`, fresh = false) {
	if (fresh) emitted.delete(id);
	let st = emitted.get(id);
	if (!st) {
		st = { think: 0, text: 0, hThink: false, hText: false };
		emitted.set(id, st);
	}
	return st;
}

function streamMessage(msg, fresh = false) {
	if (!msg || msg.role !== "assistant") return;
	const id = msg.id ?? `t${turn}`;
	const st = messageState(id, fresh);
	const think = blockText(msg.content, "thinking");
	if (think.length > st.think) {
		if (!st.hThink) {
			openBlock();
			out(`${C.gray}[think] `);
			st.hThink = true;
		}
		out(C.gray + think.slice(st.think) + C.reset);
		st.think = think.length;
	}
	const text = blockText(msg.content, "text");
	if (text.length > st.text) {
		if (!st.hText) {
			openBlock();
			out(`${C.green}[text]${C.reset} `);
			st.hText = true;
		}
		out(text.slice(st.text));
		st.text = text.length;
	}
}

function streamDelta(event) {
	if (!event || typeof event.delta !== "string" || !event.delta) return;
	const st = messageState();
	if (event.type === "thinking_delta") {
		if (!st.hThink) {
			openBlock();
			out(`${C.gray}[think] `);
			st.hThink = true;
		}
		out(C.gray + event.delta + C.reset);
		st.think += event.delta.length;
	} else if (event.type === "text_delta") {
		if (!st.hText) {
			openBlock();
			out(`${C.green}[text]${C.reset} `);
			st.hText = true;
		}
		out(event.delta);
		st.text += event.delta.length;
	}
}

function usageLine(msg) {
	const u = msg?.usage;
	if (!u) return;
	const tok = u.totalTokens ?? u.total_tokens;
	const cost = u.cost?.total;
	const bits = [];
	if (tok != null) bits.push(`${tok} tok`);
	if (cost != null) bits.push(`$${Number(cost).toFixed(4)}`);
	if (msg.stopReason && msg.stopReason !== "stop") bits.push(msg.stopReason);
	if (bits.length) out(`\n${C.gray}${C.dim}[usage] ${bits.join(" \u00b7 ")}${C.reset}`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
	line = line.trim();
	if (!line.startsWith("{")) return;
	let ev;
	try {
		ev = JSON.parse(line);
	} catch {
		return;
	}
	switch (ev.type) {
		case "turn_start":
			// Turn separators are noise in the attach view; message/tool blocks
			// already delimit the flow. `turn` still feeds streamMessage's id fallback.
			turn++;
			break;
		case "message_start":
			streamMessage(ev.message, true);
			break;
		case "message_update":
			if (ev.message) streamMessage(ev.message);
			else streamDelta(ev.assistantMessageEvent);
			break;
		case "message_end":
			streamMessage(ev.message);
			usageLine(ev.message);
			break;
		case "tool_execution_start":
			openBlock();
			out(
				`${C.cyan}[tool]${C.reset} ${ev.toolName} ${C.dim}${summarizeTool(ev.toolName, ev.args ?? {})}${C.reset}`,
			);
			break;
		case "tool_execution_end": {
			const err = ev.isError || ev.error;
			if (err)
				out(`\n${C.red}[error] ${trunc(ev.error?.message ?? ev.error ?? "tool error", 80)}${C.reset}`);
			break;
		}
		case "error":
			openBlock();
			out(`${C.red}[error] ${trunc(ev.message ?? ev.error ?? JSON.stringify(ev), 120)}${C.reset}`);
			break;
		default:
			break; // session_start/info/shutdown/tree/user/compact: quietly ignored
	}
});
rl.on("close", () => out("\n"));
