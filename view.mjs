#!/usr/bin/env node
/**
 * view.mjs — live, read-only view of a pi-babysit subagent rendered with Pi's
 * own TUI components.
 *
 *   node view.mjs <session-id | session dir | output.log> [--print] [--cwd DIR]
 *
 * The subagent log (rpc-stream-format.mjs) is restored to standard Pi RPC
 * events and replayed into transcript-view.mjs. Follow mode tails the log until
 * you quit (q / Ctrl-C). --print renders the current transcript once to stdout.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { applyTerminalSettings, initPiTheme, loadPiEnvironment } from "./pi-environment.mjs";
import { loadPiRuntime } from "./pi-runtime.mjs";
import { createRpcEventRestorer } from "./rpc-stream-format.mjs";
import { createTranscriptView } from "./transcript-view.mjs";

const USAGE = "Usage: node view.mjs <session-id | session dir | output.log> [--print] [--cwd DIR]";

export function parseArgs(argv) {
	const options = { print: false, cwd: undefined, target: undefined };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--print") options.print = true;
		else if (arg === "--cwd") options.cwd = argv[++index];
		else if (arg === "-h" || arg === "--help") options.help = true;
		else if (!options.target) options.target = arg;
		else throw new Error(`Unexpected argument: ${arg}`);
	}
	return options;
}

/** Resolve a session id, session directory, or log path to the log file. */
export function resolveLogPath(target, rootBase = process.env.PI_BABYSIT_DIR ?? path.join(os.homedir(), ".pi-babysit")) {
	if (fs.existsSync(target)) {
		const stat = fs.statSync(target);
		return stat.isDirectory() ? path.join(target, "output.log") : target;
	}
	let best;
	for (const root of fs.existsSync(rootBase) ? fs.readdirSync(rootBase) : []) {
		const log = path.join(rootBase, root, "sessions", target, "output.log");
		try {
			const mtime = fs.statSync(log).mtimeMs;
			if (!best || mtime > best.mtime) best = { log, mtime };
		} catch {
			/* not in this root */
		}
	}
	if (!best) throw new Error(`No babysit session log found for ${target} under ${rootBase}`);
	return best.log;
}

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

/** pi-babysit's own metadata for a session log (<root>/meta/<id>.json). */
function sessionInfo(logPath) {
	const sessionDir = path.dirname(logPath);
	const id = path.basename(sessionDir);
	const root = path.dirname(path.dirname(sessionDir));
	return {
		id,
		meta: readJson(path.join(root, "meta", `${id}.json`)),
		statusFile: path.join(sessionDir, "status.json"),
	};
}

/** Incremental JSONL reader: feed bytes, get complete event objects. */
export function createLogReader(onEvent) {
	const restorer = createRpcEventRestorer();
	let pending = "";
	const line = (raw) => {
		const text = raw.replace(/\r$/, "").trim();
		if (!text.startsWith("{")) return;
		let event;
		try {
			event = JSON.parse(text);
		} catch {
			return;
		}
		for (const restored of restorer.push(event)) onEvent(restored);
	};
	return {
		push(chunk) {
			pending += chunk;
			let newline;
			while ((newline = pending.indexOf("\n")) >= 0) {
				line(pending.slice(0, newline));
				pending = pending.slice(newline + 1);
			}
		},
		end() {
			if (pending) line(pending);
			pending = "";
			for (const restored of restorer.end()) onEvent(restored);
		},
	};
}

function readFrom(file, offset) {
	const size = fs.statSync(file).size;
	if (size <= offset) return { text: "", offset: size < offset ? 0 : offset, truncated: size < offset };
	const buffer = Buffer.alloc(size - offset);
	const fd = fs.openSync(file, "r");
	try {
		fs.readSync(fd, buffer, 0, buffer.length, offset);
	} finally {
		fs.closeSync(fd);
	}
	return { text: buffer, offset: size, truncated: false };
}

export function createViewerInputListener({ tui, getView, quit, onChange }) {
	const key = (data, name) => tui.matchesKey?.(data, name) ?? false;
	return (data) => {
		// Input listeners run before Pi's focused-component key-release filter.
		// Toggle once per press, not again on release or while holding the key.
		if (tui.isKeyRelease?.(data) || tui.isKeyRepeat?.(data)) return { consume: true };
		if (key(data, "q") || key(data, "ctrl+c") || data === "q" || data === "\x03") quit();
		else if (key(data, "ctrl+o") || data === "\x0f") {
			const view = getView();
			view.setToolsExpanded(!view.expanded);
		} else if (key(data, "t") || data === "t") getView().toggleThinking();
		else return { consume: true };
		onChange();
		return { consume: true };
	};
}

export async function main(argv = process.argv.slice(2)) {
	const options = parseArgs(argv);
	if (options.help || !options.target) {
		console.log(USAGE);
		return options.help ? 0 : 2;
	}
	const logPath = resolveLogPath(options.target);
	const info = sessionInfo(logPath);
	const cwd = options.cwd ?? info.meta?.cwd ?? process.cwd();
	const runtime = await loadPiRuntime();
	// The worker's settings, themes and extension renderers, as Pi loads them for its cwd.
	const environment = await loadPiEnvironment(runtime, { cwd });
	applyTerminalSettings(runtime, environment);
	const newView = (tui) => createTranscriptView({ runtime, tui, cwd, render: environment.render });

	const decoder = new TextDecoder();
	if (options.print) {
		initPiTheme(runtime, environment);
		for (const message of environment.diagnostics) process.stderr.write(`${message}\n`);
		const view = newView({ requestRender() {} });
		const reader = createLogReader((event) => view.apply(event));
		reader.push(decoder.decode(fs.readFileSync(logPath)));
		reader.end();
		const width = process.stdout.columns || 120;
		await new Promise((resolve) => process.stdout.write(`${view.container.render(width).join("\n")}\n`, resolve));
		return 0;
	}

	const { Container, ProcessTerminal, Spacer, Text } = runtime.tui;
	// Pi >= 1.5 renders regular (scrollback) mode with TuiMainScreen; older
	// pi-tui releases export the TUI class itself.
	const Screen = runtime.tui.TuiMainScreen ?? runtime.tui.TUI;
	if (typeof Screen !== "function") throw new Error("Unsupported pi-tui: no TuiMainScreen or TUI export");
	const settingsManager = environment.settingsManager;
	const ui = new Screen(
		new ProcessTerminal(),
		settingsManager?.getShowHardwareCursor?.(),
		runtime.agent.getAgentDir?.(),
	);
	if (settingsManager?.getClearOnShrink) ui.setClearOnShrink?.(settingsManager.getClearOnShrink());
	const theme = initPiTheme(runtime, environment, ui);
	if (environment.diagnostics.length > 0) {
		const diagnostics = new Container();
		for (const message of environment.diagnostics) diagnostics.addChild(new Text(`\x1b[31m${message}\x1b[0m`, 1, 0));
		diagnostics.addChild(new Spacer(1));
		ui.addChild(diagnostics);
	}
	let view = newView(ui);
	let reader = createLogReader((event) => view.apply(event));
	const status = new Text("", 1, 0);
	const statusLine = () => {
		const state = readJson(info.statusFile)?.state ?? "unknown";
		const label = info.meta?.name && info.meta.name !== info.id ? `${info.id} (${info.meta.name})` : info.id;
		status.setText(
			`\x1b[2m${label} · ${state} · q quit · ctrl+o ${view.expanded ? "collapse" : "expand"} tools · t thinking\x1b[0m`,
		);
	};
	ui.addChild(view.container);
	ui.addChild(status);

	let offset = 0;
	const poll = () => {
		const chunk = readFrom(logPath, offset);
		if (chunk.truncated) {
			// The log was replaced; start over.
			const index = ui.children.indexOf(view.container);
			view = newView(ui);
			reader = createLogReader((event) => view.apply(event));
			ui.children.splice(index, 1, view.container);
		}
		offset = chunk.offset;
		if (chunk.text.length) reader.push(decoder.decode(chunk.text, { stream: true }));
		statusLine();
		ui.requestRender();
	};

	const quit = () => {
		clearInterval(timer);
		ui.stop();
		process.exit(0);
	};
	ui.addInputListener(createViewerInputListener({
		tui: runtime.tui,
		getView: () => view,
		quit,
		onChange() {
			statusLine();
			ui.requestRender();
		},
	}));

	poll();
	ui.start();
	theme.start();
	const timer = setInterval(poll, 200);
	return undefined;
}

const entry = process.argv[1] ? pathToFileURL(fs.realpathSync(process.argv[1])).href : undefined;
if (entry === import.meta.url) {
	main().then(
		(code) => {
			// Loaded extensions may keep timers alive; a finished one-shot run exits.
			if (typeof code === "number") process.exit(code);
		},
		(error) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		},
	);
}
