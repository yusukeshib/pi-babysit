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
 * Internal (non-exported) modules of pi-coding-agent that interactive mode
 * uses to set up its chat. Each is optional: a pi release that moved or lacks
 * one degrades to the closest public behavior instead of failing.
 */
const INTERNAL_MODULES = {
	renderers: "dist/core/tools/renderers/index.js",
	builtInExtensions: "dist/extensions/index.js",
	trust: "dist/core/trust-manager.js",
	keybindings: "dist/core/keybindings.js",
	theme: "dist/modes/interactive/theme/theme.js",
	themeController: "dist/modes/interactive/theme/theme-controller.js",
	mermaid: "dist/modes/interactive/components/mermaid.js",
};

async function importInternal(packageDir, relativePath) {
	const file = path.join(packageDir, relativePath);
	if (!fs.existsSync(file)) return undefined;
	try {
		return await import(pathToFileURL(file).href);
	} catch {
		return undefined;
	}
}

/**
 * Load { agent, tui, withBuiltInRenderers, internal, packageDir, version }.
 * `internal` holds the optional internal modules (see INTERNAL_MODULES); they
 * resolve to the same module instances the public entry point uses, so module
 * state such as registered themes is shared.
 */
export async function loadPiRuntime() {
	const packageDir = findPiPackageDir();
	let agent;
	let tui;
	let version;
	const internal = {};
	if (packageDir) {
		const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
		version = pkg.version;
		agent = await import(pathToFileURL(path.join(packageDir, pkg.exports?.["."]?.import ?? "dist/index.js")).href);
		const tuiEntry = siblingPackageEntry(packageDir, "pi-tui");
		tui = await import(tuiEntry ?? "@earendil-works/pi-tui");
		for (const [key, relativePath] of Object.entries(INTERNAL_MODULES)) {
			internal[key] = await importInternal(packageDir, relativePath);
		}
	} else {
		agent = await import(AGENT_PACKAGE);
		tui = await import("@earendil-works/pi-tui");
	}
	return { agent, tui, withBuiltInRenderers: internal.renderers?.withBuiltInRenderers, internal, packageDir, version };
}
