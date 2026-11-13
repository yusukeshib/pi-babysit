#!/usr/bin/env node
/**
 * Transparent stdin/stdout proxy for `pi --mode rpc`.
 *
 * stdin is forwarded byte-for-byte. stdout is rewritten line by line into
 * pi-babysit's subagent log format (see rpc-stream-format.mjs): a subset of
 * Pi's standard RPC event stream that only omits exactly reproducible
 * duplicate payloads, plus separate `pi_babysit_*` events. Compact is the
 * default profile; PI_BABYSIT_RPC_LOG_MODE=standard keeps Pi's events intact.
 */
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { createRpcLogCompactor } from "./rpc-stream-format.mjs";

export function rpcLogMode(value = process.env.PI_BABYSIT_RPC_LOG_MODE) {
	return value === "standard" ? "standard" : "compact";
}

function transformRpcOutput(input, output) {
	return new Promise((resolve, reject) => {
		const decoder = new StringDecoder("utf8");
		const compactor = createRpcLogCompactor({ mode: rpcLogMode() });
		let buffered = "";

		const write = (lines, terminated = true) => {
			if (lines.length === 0) return;
			if (!output.write(lines.join("\n") + (terminated ? "\n" : ""))) input.pause();
		};
		output.on("drain", () => input.resume());
		input.on("error", reject);
		input.on("data", (chunk) => {
			buffered += decoder.write(chunk);
			const lines = [];
			for (;;) {
				const newline = buffered.indexOf("\n");
				if (newline < 0) break;
				lines.push(...compactor.push(buffered.slice(0, newline)));
				buffered = buffered.slice(newline + 1);
			}
			write(lines);
		});
		input.on("end", () => {
			buffered += decoder.end();
			const lines = buffered ? compactor.push(buffered) : [];
			lines.push(...compactor.end());
			// Keep an unterminated final record unterminated.
			write(lines, !buffered);
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
