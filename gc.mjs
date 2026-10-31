#!/usr/bin/env node
// Garbage collection for old pi-babysit roots (one root per Pi session).
//
// The collector walks every file under every root, which takes hundreds of
// milliseconds on a large ~/.pi-babysit. index.ts imports this module for the
// shared lease/lock protocol and runs collections in a child process
// (`node gc.mjs '<json options>'`) so the Pi event loop never blocks on it.
// All coordination is cross-process (lease files + lock file + revalidation),
// so running in a child preserves the safety argument unchanged.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** @typedef {{ candidates: string[]; deleted: string[]; bytes: number; skippedLive: string[] }} BabysitGcResult */
/** @typedef {{ rootBase: string; currentRoot: string; olderThanMs: number; dryRun?: boolean; now?: number }} BabysitGcOptions */

export const GC_LOCK_FILE = ".pi-babysit-gc.lock";
export const GC_STAMP_FILE = ".pi-babysit-gc.last";
export const AUTOMATIC_GC_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const ACTIVE_LEASE_PREFIX = ".pi-babysit-active-";

/** @param {string} state */
export function isConfirmedTerminalState(state) {
	return state === "killed" || state === "exited";
}

/** @param {number} pid */
export function processIsAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM";
	}
}

/**
 * @param {string} root
 * @param {number} [rootMtimeMs]
 * @returns {{ bytes: number; newestMtimeMs: number }}
 */
function scanTreeStats(root, rootMtimeMs) {
	let bytes = 0;
	let newestMtimeMs;
	try {
		// The collector's own lock file updates the root mtime; use the
		// pre-lock age when rescanning, but still include fresh descendants.
		newestMtimeMs = rootMtimeMs ?? fs.lstatSync(root).mtimeMs;
	} catch {
		return { bytes: 0, newestMtimeMs: Infinity };
	}
	const pending = [root];
	while (pending.length > 0) {
		const current = /** @type {string} */ (pending.pop());
		let entries;
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.name === GC_LOCK_FILE) continue;
			const fullPath = path.join(current, entry.name);
			try {
				const stat = fs.lstatSync(fullPath);
				newestMtimeMs = Math.max(newestMtimeMs, stat.mtimeMs);
				if (entry.isDirectory()) pending.push(fullPath);
				else if (entry.isFile()) bytes += stat.size;
			} catch {
				/* raced with cleanup */
			}
		}
	}
	return { bytes, newestMtimeMs };
}

/** @param {string} root */
function gcRootIsSafe(root) {
	let rootEntries;
	try {
		rootEntries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return false;
	}
	for (const entry of rootEntries) {
		if (!entry.isFile() || !entry.name.startsWith(ACTIVE_LEASE_PREFIX)) continue;
		try {
			const lease = JSON.parse(fs.readFileSync(path.join(root, entry.name), "utf8"));
			if (!Number.isSafeInteger(lease.pid) || lease.pid <= 0) return false;
			if (processIsAlive(lease.pid)) return false;
		} catch {
			return false;
		}
	}

	// Remote PIDs are meaningless locally. Retain unresolved remote references;
	// terminal observations are persisted by listSessions, never prune remote data.
	try {
		for (const file of fs.readdirSync(path.join(root, "meta"))) {
			if (!file.endsWith(".json")) continue;
			const meta = JSON.parse(fs.readFileSync(path.join(root, "meta", file), "utf8"));
			if (meta.host && (!meta.remoteTerminalState || !isConfirmedTerminalState(meta.remoteTerminalState))) return false;
		}
	} catch (error) {
		if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") return false;
	}
	const sessionsDir = path.join(root, "sessions");
	let sessionDirs;
	try {
		sessionDirs = fs.readdirSync(sessionsDir, { withFileTypes: true });
	} catch (error) {
		// session_start acquires a lease before the first worker exists. Once that
		// lease is gone, an old root with no sessions is safe to collect.
		return /** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT";
	}
	if (!sessionDirs.some((entry) => entry.isDirectory())) return true;
	let sawStatus = false;
	for (const sessionEntry of sessionDirs) {
		if (!sessionEntry.isDirectory()) continue;
		const sessionDir = path.join(sessionsDir, sessionEntry.name);
		try {
			const status = JSON.parse(fs.readFileSync(path.join(sessionDir, "status.json"), "utf8"));
			sawStatus = true;
			if (status.state !== "running") {
				if (!status.state || (!isConfirmedTerminalState(status.state) && status.state !== "dead")) {
					return false;
				}
				continue;
			}
			const supervisorPid = Number(
				JSON.parse(fs.readFileSync(path.join(sessionDir, "meta.json"), "utf8")).babysit_pid,
			);
			const childPid = Number(status.child_pid);
			if (
				!Number.isSafeInteger(supervisorPid) ||
				supervisorPid <= 0 ||
				processIsAlive(supervisorPid) ||
				(Number.isSafeInteger(childPid) && childPid > 0 && processIsAlive(childPid))
			) {
				return false;
			}
		} catch {
			return false;
		}
	}
	return sawStatus;
}

/**
 * @param {BabysitGcOptions} options
 * @returns {BabysitGcResult}
 */
export function gcBabysitRoots(options) {
	const now = options.now ?? Date.now();
	const current = path.resolve(options.currentRoot);
	/** @type {BabysitGcResult} */
	const result = { candidates: [], deleted: [], bytes: 0, skippedLive: [] };
	let roots;
	try {
		roots = fs.readdirSync(options.rootBase, { withFileTypes: true });
	} catch {
		return result;
	}

	for (const entry of roots) {
		if (!entry.isDirectory() || entry.name.startsWith(".pi-babysit-gc-")) continue;
		const root = path.join(options.rootBase, entry.name);
		if (path.resolve(root) === current) continue;
		if (!gcRootIsSafe(root)) {
			result.skippedLive.push(entry.name);
			continue;
		}
		const stats = scanTreeStats(root);
		if (now - stats.newestMtimeMs < options.olderThanMs) continue;
		result.candidates.push(entry.name);
		if (options.dryRun !== false) {
			result.bytes += stats.bytes;
			continue;
		}

		const lockPath = path.join(root, GC_LOCK_FILE);
		let lockFd;
		let tombstone;
		try {
			lockFd = fs.openSync(lockPath, "wx");
			// Compatible Pi processes acquire an active lease around this same lock.
			// Revalidate after locking, then atomically rename the root so a resume
			// racing deletion creates a fresh namespace instead of writing into rmSync.
			if (!gcRootIsSafe(root)) {
				result.skippedLive.push(entry.name);
				continue;
			}
			const refreshedStats = scanTreeStats(root, stats.newestMtimeMs);
			if (now - refreshedStats.newestMtimeMs < options.olderThanMs) continue;
			tombstone = path.join(options.rootBase, `.pi-babysit-gc-${entry.name}-${process.pid}-${Date.now()}`);
			fs.closeSync(lockFd);
			lockFd = undefined;
			fs.renameSync(root, tombstone);
			fs.rmSync(tombstone, { recursive: true, force: true });
			result.deleted.push(entry.name);
			result.bytes += refreshedStats.bytes;
		} catch {
			/* report only roots whose atomic removal completed */
		} finally {
			if (lockFd != null) {
				try {
					fs.closeSync(lockFd);
				} catch {
					/* best-effort */
				}
			}
			try {
				fs.rmSync(lockPath, { force: true });
			} catch {
				/* root may already have been atomically renamed */
			}
		}
	}
	return result;
}

// CLI entry: `node gc.mjs '<BabysitGcOptions JSON>'` prints the result as JSON.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const options = JSON.parse(process.argv[2] ?? "");
		process.stdout.write(JSON.stringify(gcBabysitRoots(options)));
	} catch (error) {
		process.stderr.write(String(error instanceof Error ? error.message : error));
		process.exitCode = 1;
	}
}
