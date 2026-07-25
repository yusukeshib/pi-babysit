#!/usr/bin/env node
/**
 * Transparent stdin/stdout proxy for `pi --mode rpc`.
 *
 * Pi's `message_update` events repeat the entire growing assistant message and
 * `assistantMessageEvent.partial` on every token. Those cumulative snapshots
 * are useful only while streaming; `message_end` is the authoritative final
 * message. Persisting every snapshot makes babysit logs grow quadratically.
 *
 * This proxy forwards stdin byte-for-byte. `message_update` snapshots are
 * always compacted. In opt-in `compact` log mode, redundant payloads on
 * lifecycle/tool events are also removed while authoritative `message_end`,
 * response, and error events remain intact. Set PI_BABYSIT_RPC_LOG_MODE=standard
 * to retain the legacy lifecycle payloads.
 */
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";

function isParkedMessages(messages) {
	if (!Array.isArray(messages)) return false;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "toolResult") continue;
		if (message.toolName === "process") return true;
		if (message.toolName !== "babysit_run") continue;
		if (message.details?.kind === "process" && message.details.status === "started") {
			return true;
		}
		const text = Array.isArray(message.content)
			? message.content
					.filter((part) => part?.type === "text" && typeof part.text === "string")
					.map((part) => part.text)
					.join("")
			: typeof message.content === "string"
				? message.content
				: "";
		if (/^Process started \(id: [^)]+\)\. \[notify-on-exit\]\nLog: /.test(text)) {
			return true;
		}
	}
	return false;
}

export function compactRpcLine(
	line,
	mode = process.env.PI_BABYSIT_RPC_LOG_MODE ?? "standard",
) {
	if (!line.trimStart().startsWith("{")) return line;

	let event;
	try {
		event = JSON.parse(line);
	} catch {
		return line;
	}

	if (event?.type === "message_update") {
		const { message: _cumulativeMessage, assistantMessageEvent, ...rest } = event;
		if (!assistantMessageEvent || typeof assistantMessageEvent !== "object") {
			return JSON.stringify(rest);
		}
		const { partial: _cumulativePartial, ...deltaEvent } = assistantMessageEvent;
		return JSON.stringify({ ...rest, assistantMessageEvent: deltaEvent });
	}
	if (mode !== "compact") return line;

	switch (event?.type) {
		case "message_start": {
			const { message, ...rest } = event;
			return JSON.stringify({
				...rest,
				message:
					message && typeof message === "object"
						? { role: message.role, toolName: message.toolName, toolCallId: message.toolCallId }
						: message,
			});
		}
		case "turn_end": {
			const { message: _message, toolResults: _toolResults, ...rest } = event;
			return JSON.stringify(rest);
		}
		case "agent_end": {
			const { messages, ...rest } = event;
			return JSON.stringify({ ...rest, piBabysitParked: isParkedMessages(messages) });
		}
		case "tool_execution_end": {
			if (event.isError) return line;
			const { result: _result, ...rest } = event;
			return JSON.stringify(rest);
		}
		default:
			return line;
	}
}

function transformRpcOutput(input, output) {
	return new Promise((resolve, reject) => {
		const decoder = new StringDecoder("utf8");
		let buffered = "";

		const write = (value) => {
			if (!output.write(value)) input.pause();
		};
		output.on("drain", () => input.resume());
		input.on("error", reject);
		input.on("data", (chunk) => {
			buffered += decoder.write(chunk);
			for (;;) {
				const newline = buffered.indexOf("\n");
				if (newline < 0) break;
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				write(`${compactRpcLine(line)}\n`);
			}
		});
		input.on("end", () => {
			buffered += decoder.end();
			if (buffered) write(compactRpcLine(buffered));
			if (output.writableNeedDrain) output.once("drain", resolve);
			else resolve();
		});
	});
}

function waitForDrain(stream) {
	return stream.writableNeedDrain
		? new Promise((resolve) => stream.once("drain", resolve))
		: Promise.resolve();
}

export function runRpcProxy(argv = process.argv.slice(2)) {
	const separator = argv.indexOf("--");
	const command = separator >= 0 ? argv[separator + 1] : argv[0];
	const args = separator >= 0 ? argv.slice(separator + 2) : argv.slice(1);
	if (!command) {
		console.error("Usage: rpc-stream-proxy.mjs -- <command> [args...]");
		process.exitCode = 2;
		return;
	}

	const child = spawn(command, args, {
		cwd: process.cwd(),
		env: process.env,
		stdio: ["pipe", "pipe", "pipe"],
	});

	let transportFailed = false;
	process.stdin.pipe(child.stdin);
	// The RPC worker can exit or self-reap while a command is still arriving.
	// Ignore the resulting pipe-close race so the proxy preserves the worker's
	// actual exit code/signal instead of crashing with an unhandled EPIPE.
	child.stdin.on("error", (error) => {
		if (error?.code === "EPIPE" || error?.code === "ERR_STREAM_DESTROYED") return;
		transportFailed = true;
		console.error(`rpc stream proxy stdin failed: ${error.message}`);
	});
	const outputFlushed = transformRpcOutput(child.stdout, process.stdout);
	child.stderr.pipe(process.stderr);

	const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
	const signalHandlers = new Map(
		forwardedSignals.map((signal) => [signal, () => child.kill(signal)]),
	);
	for (const [signal, handler] of signalHandlers) process.on(signal, handler);
	let spawnFailed = false;
	child.on("error", (error) => {
		spawnFailed = true;
		console.error(`rpc stream proxy failed to start ${command}: ${error.message}`);
	});
	child.on("close", async (code, signal) => {
		try {
			await outputFlushed;
			await Promise.all([waitForDrain(process.stdout), waitForDrain(process.stderr)]);
		} catch (error) {
			console.error(`rpc stream proxy output failed: ${error.message}`);
			process.exitCode = 1;
			return;
		}
		if (transportFailed) {
			process.exitCode = 1;
			return;
		}
		if (signal) {
			for (const [forwarded, handler] of signalHandlers) process.off(forwarded, handler);
			process.kill(process.pid, signal);
			return;
		}
		process.exitCode = spawnFailed ? 1 : (code ?? 1);
	});
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entry === import.meta.url) runRpcProxy();
