/**
 * Resolve the Pi packages of the INSTALLED pi, so a standalone viewer renders
 * with the same components as the pi that produced the log (not a copy that
 * happens to sit in pi-babysit's own node_modules).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const AGENT_PACKAGE = "@earendil-works/pi-coding-agent";

function packageName(dir) {
	try {
		return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name;
	} catch {
		return undefined;
	}
}

function managedInstallDir() {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
	try {
		const version = fs.readFileSync(path.join(agentDir, "install", "current-version"), "utf8").trim();
		if (!version) return undefined;
		return path.join(agentDir, "install", "releases", version, "node_modules", AGENT_PACKAGE);
	} catch {
		return undefined;
	}
}

function packageDirFromBinary() {
	try {
		const bin = execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		if (!bin) return undefined;
		let dir = path.dirname(fs.realpathSync(bin));
		for (;;) {
			if (packageName(dir) === AGENT_PACKAGE) return dir;
			const parent = path.dirname(dir);
			if (parent === dir) return undefined;
			dir = parent;
		}
	} catch {
		return undefined;
	}
}

/** Directory of the installed pi-coding-agent package, or undefined. */
export function findPiPackageDir() {
	const candidates = [process.env.PI_BABYSIT_PI_PACKAGE_DIR, managedInstallDir(), packageDirFromBinary()];
	return candidates.find((dir) => dir && packageName(dir) === AGENT_PACKAGE);
}

function siblingPackageEntry(agentDir, name) {
	for (const dir of [
		path.join(path.dirname(agentDir), name),
		path.join(agentDir, "node_modules", "@earendil-works", name),
	]) {
		if (packageName(dir) === `@earendil-works/${name}`) {
			const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
			const entry = pkg.exports?.["."]?.import ?? pkg.exports?.["."]?.default ?? pkg.module ?? pkg.main ?? "index.js";
			return pathToFileURL(path.join(dir, entry)).href;
		}
	}
	return undefined;
}

/**
 * Load { agent, tui, withBuiltInRenderers, packageDir, version }.
 * withBuiltInRenderers is optional (an internal module of pi-coding-agent).
 */
export async function loadPiRuntime() {
	const packageDir = findPiPackageDir();
	let agent;
	let tui;
	let withBuiltInRenderers;
	let version;
	if (packageDir) {
		const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
		version = pkg.version;
		agent = await import(pathToFileURL(path.join(packageDir, pkg.exports?.["."]?.import ?? "dist/index.js")).href);
		const tuiEntry = siblingPackageEntry(packageDir, "pi-tui");
		tui = await import(tuiEntry ?? "@earendil-works/pi-tui");
		try {
			const renderers = await import(
				pathToFileURL(path.join(packageDir, "dist", "core", "tools", "renderers", "index.js")).href
			);
			withBuiltInRenderers = renderers.withBuiltInRenderers;
		} catch {
			/* generic tool rendering */
		}
	} else {
		agent = await import(AGENT_PACKAGE);
		tui = await import("@earendil-works/pi-tui");
	}
	return { agent, tui, withBuiltInRenderers, packageDir, version };
}
