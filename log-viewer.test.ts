import { describe, test, expect } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
	visibleWidth,
	Container,
	stripTerminalSequences,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import {
	dispatchMouseEvent,
	retargetMouseEvent,
} from "@earendil-works/pi-tui/dist/tui.js";
import { createLogViewer } from "./log-viewer";

import { theme } from "./node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

initTheme("dark");
function setup() {
	let height = 8,
		closed = 0;
	const viewer = createLogViewer({
		getHeight: () => height,
		getTheme: () => theme,
		requestRender() {},
		onClose() {
			closed++;
		},
	});
	return {
		viewer,
		resize: (n: number) => {
			height = n;
		},
		closed: () => closed,
	};
}
const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");
describe("stock Container log viewer", () => {
	function host(viewer: ReturnType<typeof createLogViewer>, width = 30) {
		const container = new Container();
		container.addChild(viewer);
		const render = () => container.render(width);
		render();
		const mouse = (
			type: TuiMouseEvent["type"],
			x: number,
			y: number,
			wheelDelta = 0,
		) =>
			container.handleMouse({
				type,
				button: "left",
				x,
				y,
				screenX: x,
				screenY: y,
				width,
				height: render().length,
				shift: false,
				alt: false,
				ctrl: false,
				wheelDelta,
			});
		return { container, render, mouse };
	}
	test("plain host renders scrollbar, wheel consumes boundaries, follow and resize persist", () => {
		const { viewer, resize } = setup();
		const log = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
		viewer.update("process", log, false);
		const h = host(viewer);
		expect(h.render()).toHaveLength(8);
		expect(plain(h.render())).toContain("line 39");
		expect(plain(h.render())).toContain("│");
		expect(plain(h.render())).toContain("┃");
		expect(h.mouse("wheel", 2, 2, 100)?.handled).toBe(true);
		viewer.update("process", log + "\nline 40", false);
		expect(plain(h.render())).toContain("line 40");
		expect(h.mouse("wheel", 2, 2, -100)?.handled).toBe(true);
		expect(viewer.scrollView.scrollTop).toBe(0);
		expect(h.mouse("wheel", 2, 2, -1)?.handled).toBe(true);
		viewer.update("new header", log + "\nline 41", false);
		h.render();
		expect(viewer.scrollView.scrollTop).toBe(0);
		expect(viewer.scrollView.isFollowingEnd).toBe(false);
		resize(5);
		viewer.invalidate();
		h.render();
		expect(viewer.scrollView.viewportHeight).toBe(3);
		expect(viewer.handleKey("\x1b[B")).toBe(true);
		expect(viewer.scrollView.scrollTop).toBe(1);
		expect(viewer.handleKey("\x1b[A")).toBe(true);
		for (const key of ["x", "\x1b[H", "\x1b[F", "\x1b[5~", "\x1b[6~"])
			expect(viewer.handleKey(key)).toBe(false);
	});
	test("track pages and thumb captures drag/release outside stock host", () => {
		const { viewer } = setup();
		viewer.update(
			"process",
			Array.from({ length: 40 }, (_, i) => `${i}`).join("\n"),
			false,
		);
		const h = host(viewer);
		expect(h.mouse("press", 29, 1)?.handled).toBe(true);
		expect(viewer.scrollView.scrollTop).toBe(28);
		h.mouse("wheel", 1, 2, -100);
		const captured = h.mouse("press", 29, 1)!;
		expect(captured.capture).toBe(true);
		expect(plain(h.render())).toContain("█");
		const outside = {
			type: "drag",
			button: "left",
			x: 50,
			y: 50,
			screenX: 50,
			screenY: 50,
			width: 30,
			height: 8,
			shift: false,
			alt: false,
			ctrl: false,
		} as TuiMouseEvent;
		expect(
			dispatchMouseEvent(
				captured.target.component,
				retargetMouseEvent(outside, captured.target),
			)?.render,
		).toBe(true);
		expect(viewer.scrollView.scrollTop).toBe(34);
		expect(
			dispatchMouseEvent(
				captured.target.component,
				retargetMouseEvent({ ...outside, type: "release" }, captured.target),
			)?.handled,
		).toBe(true);
		expect(plain(h.render())).not.toContain("█");
	});
	test("Close press fires once, click consumed, narrow Close and Esc", () => {
		const { viewer, closed } = setup();
		const h = host(viewer, 4);
		expect(h.mouse("press", 3, 0)?.handled).toBe(true);
		expect(h.mouse("click", 3, 0)?.handled).toBe(true);
		expect(closed()).toBe(1);
		expect(viewer.handleKey("\x1b")).toBe(true);
		expect(closed()).toBe(2);
	});
	test("zero/one body rows and narrow widths stay bounded", () => {
		const { viewer, resize } = setup();
		viewer.update("title", "界😀\nmore", false);
		for (const height of [2, 3, 8]) {
			resize(height);
			for (const width of [0, 1, 2]) {
				const h = host(viewer, width);
				expect(h.render().every((line) => visibleWidth(line) <= width)).toBe(
					true,
				);
				expect(h.render()).toHaveLength(height);
			}
		}
	});
	test("Unicode and control safety, safe SGR retained", () => {
		const { viewer } = setup();
		viewer.update(
			"日本語\x1b[2J",
			"界😀\x1b[31mred\x1b[0m\x1b[2J\x1b]52;c;danger\x07\x00",
			false,
		);
		const lines = viewer.render(12);
		expect(lines.every((l) => visibleWidth(l) <= 12)).toBe(true);
		expect(lines.join("\n")).toContain("\x1b[31m");
		expect(lines.join("\n")).not.toContain("\x1b[2J");
		expect(lines.join("\n")).not.toContain("danger");
		expect(lines.join("\n")).not.toContain("\x00");
	});
	test("assistant deltas dedup finalized snapshot, tool results and errors, partial ignored", () => {
		const { viewer, resize } = setup();
		resize(30);
		const events = [
			{ type: "agent_start" },
			{
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "Hello " },
			},
			{
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "world" },
			},
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Hello world" }],
				},
			},
			{ type: "tool_execution_start", toolName: "read", args: { path: "a" } },
			{
				type: "tool_execution_end",
				toolCallId: "t",
				result: { content: [{ type: "text", text: "result text" }] },
			},
			{
				type: "message_end",
				message: {
					role: "toolResult",
					toolCallId: "t",
					content: [{ type: "text", text: "result text" }],
				},
			},
			{ type: "error", message: "failure" },
		];
		viewer.update(
			"agent",
			events.map((e) => JSON.stringify(e)).join("\n") + '\n{"type":',
			true,
		);
		const text = plain(viewer.render(60));
		expect(text.match(/Hello world/g)).toHaveLength(1);
		expect(text.match(/result text/g)).toHaveLength(1);
		expect(text).toContain("[assistant]");
		expect(text).toContain("[tool]");
		expect(text).toContain("[error]");
		expect(text).not.toContain("agent_start");
	});
	test("separate turns and results without IDs are not overwritten", () => {
		const { viewer, resize } = setup();
		resize(24);
		const events = [
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "First turn" }],
				},
			},
			{
				type: "message_end",
				message: {
					role: "toolResult",
					content: [{ type: "text", text: "First result" }],
				},
			},
			{
				type: "message_end",
				message: {
					role: "toolResult",
					content: [{ type: "text", text: "Second result" }],
				},
			},
			{
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "Next turn" },
			},
		];
		viewer.update(
			"agent",
			events.map((e) => JSON.stringify(e)).join("\n"),
			true,
		);
		const text = plain(viewer.render(60));
		for (const expected of [
			"First turn",
			"First result",
			"Second result",
			"Next turn",
		])
			expect(text).toContain(expected);
	});
	test("full task or command remains readable even without output", () => {
		const { viewer, resize } = setup();
		resize(20);
		for (const agent of [false, true]) {
			viewer.update(
				"session",
				"",
				agent,
				"complete context " + "日本語 ".repeat(8),
			);
			const text = plain(viewer.render(30));
			expect(text).toContain(agent ? "[task]" : "[command]");
			expect(text).toContain("complete context");
			expect(text).toContain("(no output available)");
		}
	});
	test("empty process and agent logs show a placeholder", () => {
		const { viewer } = setup();
		for (const agent of [false, true]) {
			viewer.update("empty", "", agent);
			expect(plain(viewer.render(40))).toContain("(no output available)");
		}
	});
	test("display clipping explicitly reported", () => {
		const { viewer } = setup();
		viewer.update(
			"large",
			Array.from({ length: 2100 }, (_, i) => String(i)).join("\n"),
			false,
		);
		viewer.render(30);
		viewer.scrollView.scrollToStart();
		expect(plain(viewer.render(30))).toContain("Earlier log lines clipped");
	});
});
