import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findPiPackageDir } from "@yusukeshib/pi-tail";
import { parseArgs, resolveLogPath } from "./view.mjs";

test("viewer resolves session ids to the newest log and parses options", () => {
	const base = mkdtempSync(path.join(os.tmpdir(), "pi-babysit-view-"));
	try {
		for (const [root, mtime] of [["old", 1_000], ["new", 2_000]] as const) {
			const dir = path.join(base, root, "sessions", "worker");
			mkdirSync(dir, { recursive: true });
			const log = path.join(dir, "output.log");
			writeFileSync(log, "");
			utimesSync(log, mtime, mtime);
		}
		expect(resolveLogPath("worker", base)).toBe(path.join(base, "new", "sessions", "worker", "output.log"));
		expect(resolveLogPath(path.join(base, "old", "sessions", "worker"), base)).toBe(
			path.join(base, "old", "sessions", "worker", "output.log"),
		);
		expect(() => resolveLogPath("missing", base)).toThrow("No babysit session log");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
	expect(parseArgs(["w", "--print", "--cwd", "/x"])).toEqual({ target: "w", print: true, cwd: "/x" });
});

test("a subagent log (Pi's RPC stream) prints through pi-tail", () => {
	const base = mkdtempSync(path.join(os.tmpdir(), "pi-babysit-view-print-"));
	try {
		const dir = path.join(base, "root", "sessions", "worker");
		mkdirSync(dir, { recursive: true });
		const user = { role: "user", content: "Say hi", timestamp: 1 };
		const answer = { role: "assistant", content: [{ type: "text", text: "Hi **there**." }], stopReason: "stop", timestamp: 2 };
		const events = [
			{ type: "agent_start" },
			{ type: "message_start", message: user },
			{ type: "message_end", message: user },
			{ type: "message_start", message: { ...answer, content: [] } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi **there**." } },
			{ type: "message_end", message: answer },
			{ type: "agent_end", messages: [user, answer] },
			{ type: "agent_settled" },
		];
		// A PTY records CRLF line endings.
		writeFileSync(path.join(dir, "output.log"), `${events.map((event) => JSON.stringify(event)).join("\r\n")}\r\n`);
		const result = spawnSync(process.execPath, [path.join(import.meta.dir, "view.mjs"), path.join(dir, "output.log"), "--print", "--cwd", base], {
			encoding: "utf8",
			// The installed Pi, with an empty agent dir so user extensions stay out.
			env: { ...process.env, PI_TAIL_PI_PACKAGE_DIR: findPiPackageDir(), PI_CODING_AGENT_DIR: path.join(base, "agent") },
		});
		expect(result.status, result.stderr).toBe(0);
		const plain = result.stdout.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
		expect(plain).toContain("Say hi");
		expect(plain).toContain("Hi there.");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});
