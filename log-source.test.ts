import { test, expect, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { FileLogSource } from "./log-source";
import { createLogViewer } from "./log-viewer";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "./node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
initTheme("dark");
function fixture(run: (file: string) => void) {
	const dir = mkdtempSync(path.join(tmpdir(), "paged-log-"));
	try { run(path.join(dir, "output.log")); } finally { rmSync(dir, { recursive: true, force: true }); }
}
function viewerFor(source: FileLogSource) {
	let height = 8;
	const viewer = createLogViewer({ getHeight: () => height, getTheme: () => theme, requestRender() {}, onClose() {} });
	viewer.updateSource("session", source, "command");
	return { viewer, resize: (n: number) => { height = n; }, text: () => viewer.render(100).map(stripTerminalSequences).join("\n") };
}
test("bidirectional >1 MiB paging preserves all UTF-8, CRLF and CR records with soft bounded pages", () => fixture(file => {
	const raw = Array.from({ length: 40000 }, (_, i) => `row-${i} 世界 ${"x".repeat(20)}${i % 2 ? "\r\n" : "\r"}`).join("");
	writeFileSync(file, raw);
	const source = new FileLogSource(file); source.refresh();
	let cursor = source.size, pages: string[] = [];
	while (cursor > 0) { const p = source.before(cursor); expect(p.start).toBeLessThan(cursor); expect(p.end - p.start).toBeLessThan(65536 + 100); pages.unshift(p.text); cursor = p.start; }
	expect(pages.join("")).toBe(raw);
	cursor = 0; pages = [];
	while (cursor < source.size) { const p = source.after(cursor); expect(p.end).toBeGreaterThan(cursor); expect(p.text).not.toContain("�"); pages.push(p.text); cursor = p.end; }
	expect(pages.join("")).toBe(raw);
}));
test("giant records are never cut or dropped", () => fixture(file => {
	const giant = "世界".repeat(200000);
	writeFileSync(file, `first\n${giant}\r\nlast`);
	const source = new FileLogSource(file, false, 16); source.refresh();
	const tail = source.before(); const prior = source.before(tail.start);
	expect(prior.text + tail.text).toBe(`first\n${giant}\r\nlast`);
	expect(source.after(6).text).toBe(giant + "\r\n");
}));
test("agent pages preserve entire logical turns, streaming and duplicate results", () => fixture(file => {
	const turn = (n: number) => [
		{ type: "agent_start" },
		{ type: "message_start", message: { role: "assistant", content: [] } },
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "stream" } },
		{ type: "message_end", message: { role: "assistant", content: `final-${n}` } },
		{ type: "tool_execution_end", toolCallId: `id-${n}`, result: { content: `result-${n}` } },
		{ type: "message_end", message: { role: "toolResult", toolCallId: `id-${n}`, content: `result-${n}` } },
		{ type: "agent_end" },
	].map(e => JSON.stringify(e)).join("\r\n") + "\r\n";
	const raw = Array.from({ length: 10 }, (_, n) => turn(n)).join(""); writeFileSync(file, raw);
	const source = new FileLogSource(file, true, 30); source.refresh();
	let end = source.size, total = "";
	while (end > 0) { const p = source.before(end); expect(["agent_start", "message_start"]).toContain(JSON.parse(p.text.split(/\r?\n/)[0]).type); total = p.text + total; end = p.start; }
	expect(total).toBe(raw);
	let start = 0; total = "";
	while (start < source.size) { const p = source.after(start); expect(p.end).toBeGreaterThan(start); total += p.text; start = p.end; }
	expect(total).toBe(raw);
	const { viewer, text } = viewerFor(source);
	expect(text()).toContain("final-9"); expect(text()).not.toContain("stream");
	expect(text().match(/result-9/g)?.length).toBe(1);
	viewer.dispose();
}));
test("timestamp sidecars seek old offsets, including sidecars >1 MiB", () => fixture(file => {
	const rows = Array.from({ length: 60000 }, (_, i) => `row-${i}\n`); writeFileSync(file, rows.join(""));
	let offset = 0;
	writeFileSync(path.join(path.dirname(file), "output.timestamps.jsonl"), rows.map((row, i) => {
		const entry = JSON.stringify([offset, Buffer.byteLength(row), 1000 + i]); offset += Buffer.byteLength(row); return entry;
	}).join("\n") + "\n");
	const source = new FileLogSource(file, false, 100); source.refresh();
	expect(source.after(0).lineTimestamps.slice(0, 3)).toEqual([1000, 1001, 1002]);
	const tail = source.before(); expect(tail.lineTimestamps.at(-2)).toBe(60999);
}));
test("viewer traverses in both directions, keeps prepended anchor, paused append and follows EOF", () => fixture(file => {
	const raw = Array.from({ length: 4000 }, (_, i) => `line-${i}\n`).join(""); writeFileSync(file, raw);
	const source = new FileLogSource(file, false, 256);
	const { viewer, text, resize } = viewerFor(source);
	expect(text()).toContain("line-3999");
	let iterations = 0;
	while (!text().includes("bytes 0–") && iterations++ < 200) {
		const previousStart = Number(text().match(/bytes (\d+)–/)![1]);
		viewer.scrollView.scrollToStart();
		const before = text();
		const range = before.match(/bytes (\d+)–(\d+)\//)!;
		expect(Number(range[2]) - Number(range[1])).toBeLessThan(4 * 256 + 100);
		const first = before.split("\n")[1].replace(/[\s┃│]+$/, "");
		expect(first).toBe(raw.slice(previousStart).split("\n")[0]);
	}
	expect(iterations).toBeLessThan(200);
	viewer.scrollView.scrollToStart(); expect(text()).toContain("[command]");
	viewer.scrollView.scrollBy(5); const paused = text().split("\n").slice(1, 7).join("\n");
	appendFileSync(file, "APPENDED\n"); viewer.updateSource("session", source, "command");
	expect(text().split("\n").slice(1, 7).join("\n")).toBe(paused);
	iterations = 0;
	while (!text().includes("APPENDED") && iterations++ < 200) { viewer.scrollView.scrollToEnd(); text(); }
	expect(iterations).toBeLessThan(200); expect(text()).toContain("APPENDED");
	viewer.scrollView.scrollToEnd(); text(); appendFileSync(file, "FOLLOWED\n"); viewer.updateSource("session", source, "command"); expect(text()).toContain("FOLLOWED");
	resize(20); for (const width of [2, 12, 40]) expect(viewer.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
}));
test("late capture metadata refreshes an unchanged loaded window", () => fixture(file => {
	writeFileSync(file, "captured\n");
	const source = new FileLogSource(file); const { viewer, text } = viewerFor(source);
	expect(text()).not.toContain("1970-");
	writeFileSync(path.join(path.dirname(file), "output.timestamps.jsonl"), JSON.stringify([0, 9, 1000]));
	viewer.updateSource("session", source, "command"); expect(text()).toContain("1970-");
}));
test("normal page open and sidecar lookup use bounded reads, not full-file scans", () => fixture(file => {
	const rows = Array.from({ length: 60000 }, (_, i) => `row-${i}\n`); writeFileSync(file, rows.join(""));
	let offset = 0;
	writeFileSync(path.join(path.dirname(file), "output.timestamps.jsonl"), rows.map(row => {
		const r = JSON.stringify([offset, row.length, 1000]); offset += row.length; return r;
	}).join("\n") + "\n");
	const original = fs.readSync; let read = 0;
	const spy = spyOn(fs, "readSync").mockImplementation(((...args: any[]) => {
		const n = (original as any)(...args); read += n; return n;
	}) as any);
	try {
		const source = new FileLogSource(file); source.refresh(); source.before();
		expect(read).toBeLessThan(512 * 1024);
		read = 0; source.after(0); expect(read).toBeLessThan(512 * 1024);
	} finally { spy.mockRestore(); }
}));
test("paused partial records are reconciled before crossing an appended seam", () => fixture(file => {
	const streamed = Array.from({ length: 80 }, (_, i) => `stream-${i}`).join("\n");
	const events = [
		{ type: "agent_start" },
		{ type: "message_start", message: { role: "assistant", content: [] } },
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: streamed } },
	].map(e => JSON.stringify(e)).join("\n") + "\n";
	writeFileSync(file, events + '{"type":"message_end",');
	const source = new FileLogSource(file, true, 100);
	const { viewer, text } = viewerFor(source); text(); viewer.scrollView.scrollToStart(); text();
	viewer.scrollView.scrollBy(10); const paused = text();
	appendFileSync(file, JSON.stringify({ message: { role: "assistant", content: streamed + "\nFINAL" } }).slice(1) + "\n");
	viewer.updateSource("session", source, "command"); expect(text()).toBe(paused.replace(/\/\d+ \(window\)/, `/${source.size} (window)`));
	viewer.scrollView.scrollToEnd(); text(); viewer.scrollView.scrollToEnd();
	expect(text()).toContain("FINAL");
}));
test("a single large agent task pages at assistant messages without task-sized reads", () => fixture(file => {
	const response = (n: number) => [
		{ type: "message_start", message: { role: "assistant", content: [] } },
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `stream-${n}` } },
		{ type: "message_end", message: { role: "assistant", content: `final-${n}` } },
		{ type: "tool_execution_end", toolCallId: `t-${n}`, result: { content: `result-${n}` } },
		{ type: "message_end", message: { role: "toolResult", toolCallId: `t-${n}`, content: `result-${n}` } },
	].map(e => JSON.stringify(e)).join("\n") + "\n";
	const raw = JSON.stringify({ type: "agent_start" }) + "\n" +
		Array.from({ length: 4000 }, (_, n) => response(n)).join("");
	expect(Buffer.byteLength(raw)).toBeGreaterThan(1024 * 1024);
	writeFileSync(file, raw);
	const agent = new FileLogSource(file, true);
	agent.refresh();
	const original = fs.readSync; let read = 0;
	const spy = spyOn(fs, "readSync").mockImplementation(((...args: any[]) => {
		const n = (original as any)(...args); read += n; return n;
	}) as any);
	try {
		const { viewer, text } = viewerFor(agent);
		expect(text()).toContain("final-3999");
		expect(text().match(/result-3999/g)).toHaveLength(1);
		expect(text()).not.toContain("stream-3999");
		expect(read).toBeLessThan(256 * 1024);
		read = 0;
		viewer.updateSource("session", agent, "command"); text();
		expect(read).toBe(0);
		viewer.dispose();
	} finally { spy.mockRestore(); }
	agent.refresh();
	let end = agent.size, reconstructed = "";
	while (end > 0) {
		const page = agent.before(end);
		expect(page.end - page.start).toBeLessThan(agent.pageBytes + 1000);
		reconstructed = page.text + reconstructed; end = page.start;
	}
	expect(reconstructed).toBe(raw);
	let start = 0; reconstructed = "";
	while (start < agent.size) {
		const page = agent.after(start);
		reconstructed += page.text; start = page.end;
	}
	expect(reconstructed).toBe(raw);
}));
test("truncation, replacement and missing logs safely reset cursors", () => fixture(file => {
	writeFileSync(file, "original\n".repeat(100)); const source = new FileLogSource(file, false, 30);
	const { viewer, text } = viewerFor(source); text();
	writeFileSync(file, "short\n"); viewer.updateSource("session", source); expect(text()).toContain("short");
	writeFileSync(file + ".new", "replacement\n"); renameSync(file + ".new", file); viewer.updateSource("session", source); expect(text()).toContain("replacement");
	rmSync(file); viewer.updateSource("session", source); expect(text()).toContain("no output available");
}));
