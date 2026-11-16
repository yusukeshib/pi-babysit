#!/usr/bin/env node
/**
 * view.mjs — live, read-only view of a pi-babysit subagent, rendered by
 * @yusukeshib/pi-tail with Pi's own TUI components.
 *
 *   node view.mjs <session-id | session dir | output.log> [--print] [--cwd DIR]
 *
 * A subagent log is Pi's `pi --mode rpc` event stream. This wrapper resolves
 * the session, uses the worker's directory, and shows the session state.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, runCli, runViewer } from "@yusukeshib/pi-tail";

export { parseArgs };

const USAGE = "Usage: node view.mjs <session-id | session dir | output.log> [--print] [--cwd DIR]";

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

export async function main(argv = process.argv.slice(2)) {
	const options = parseArgs(argv);
	if (options.help || !options.target) {
		console.log(USAGE);
		return options.help ? 0 : 2;
	}
	const file = resolveLogPath(options.target);
	const info = sessionInfo(file);
	const label = info.meta?.name && info.meta.name !== info.id ? `${info.id} (${info.meta.name})` : info.id;
	return runViewer({
		file,
		cwd: options.cwd ?? info.meta?.cwd ?? process.cwd(),
		print: options.print,
		status: () => `${label} · ${readJson(info.statusFile)?.state ?? "unknown"}`,
	});
}

const entry = process.argv[1] ? pathToFileURL(fs.realpathSync(process.argv[1])).href : undefined;
if (entry === import.meta.url) runCli(main);
