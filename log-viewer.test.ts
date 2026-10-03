import { describe, test, expect } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
	visibleWidth,
	ScrollView,
	Text,
	VStack,
	stripTerminalSequences,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import {
	renderLayoutFrame,
	getScrollViewBox,
	getLayoutBoxesAt,
	getScrollbarGeometry,
} from "@earendil-works/pi-tui/dist/layout.js";
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
describe("native log viewer", () => {
	test("open viewer becomes the core navigation target after the transcript", () => {
		const { viewer } = setup();
		const transcript = new ScrollView(new Text("chat", 0, 0), {
			primary: true,
		});
		const root = new VStack([
			{ component: transcript, basis: 2 },
			{ component: viewer, basis: 8 },
		]);
		const frame = renderLayoutFrame(root, 40, 10, () => {});
		expect(frame.primaryScrollView).toBe(viewer.scrollView);
		root.removeChild(viewer);
		expect(renderLayoutFrame(root, 40, 10, () => {}).primaryScrollView).toBe(
			transcript,
		);
	});
	test("native frame exposes scrollbar and preserves follow/offset over update and resize", () => {
		const { viewer, resize } = setup();
		const log = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
		viewer.update("process", log, false);
		expect(viewer.render(30)).toHaveLength(8);
		const frame = renderLayoutFrame(viewer, 30, 8, () => {});
		const box = getScrollViewBox(frame, viewer.scrollView)!;
		expect(box.rect.height).toBe(6);
		expect(getScrollbarGeometry(box)).toBeDefined();
		expect(viewer.scrollView.isFollowingEnd).toBe(true);
		expect(plain(frame.lines)).toContain("line 39");
		viewer.handleKey("\x1b[H");
		viewer.update("new header", log + "\nline 40", false);
		viewer.render(30);
		expect(viewer.scrollView.scrollTop).toBe(0);
		expect(viewer.scrollView.isFollowingEnd).toBe(false);
		resize(5);
		viewer.invalidate();
		viewer.render(15);
		expect(viewer.scrollView.viewportHeight).toBe(3);
		viewer.handleKey("\x1b[F");
		viewer.render(15);
		expect(viewer.scrollView.isFollowingEnd).toBe(true);
		for (const key of ["\x1b[A", "\x1b[B", "\x1b[5~", "\x1b[6~"])
			expect(viewer.handleKey(key)).toBe(true);
		viewer.invalidate();
		viewer.render(9);
		expect(viewer.scrollView).toBe(frame.root.children[1].scrollView!);
		expect(viewer.handleKey("x")).toBe(false);
	});
	test("Close press fires once, click consumed, narrow Close and Esc", () => {
		const { viewer, closed } = setup();
		const frame = renderLayoutFrame(viewer, 4, 8, () => {});
		const target = getLayoutBoxesAt(frame, 3, 0).find(
			(b) => b.component.handleMouse,
		)!;
		const event = {
			type: "press",
			button: "left",
			x: 3,
			y: 0,
			screenX: 3,
			screenY: 0,
			width: 4,
			height: 1,
			shift: false,
			alt: false,
			ctrl: false,
		} as TuiMouseEvent;
		expect(target.component.handleMouse!(event)?.handled).toBe(true);
		expect(
			target.component.handleMouse!({ ...event, type: "click" })?.handled,
		).toBe(true);
		expect(closed()).toBe(1);
		expect(viewer.handleKey("\x1b")).toBe(true);
		expect(closed()).toBe(2);
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
		viewer.handleKey("\x1b[H");
		expect(plain(viewer.render(30))).toContain("Earlier log lines clipped");
	});
});
