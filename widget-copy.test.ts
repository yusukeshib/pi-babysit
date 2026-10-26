import { expect, test } from "bun:test";
import { Container, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { createWidgetComponent } from "./index.ts";

function fixture() {
	const copied: string[] = [];
	const rows = Array.from({ length: 12 }, (_, i) => ({
		id: `job-${i}`, header: `\x1b[32m日本語 job-${i} AGENT IDLE\x1b[0m`, description: "Review changes ".repeat(8),
	}));
	const widget = createWidgetComponent(["RUNNING", "IDLE"], rows, (id) => { copied.push(id); });
	const host = new Container();
	host.addChild(widget);
	let width = 40;
	const render = (nextWidth = width) => { width = nextWidth; return host.render(width); };
	const mouse = (event: Partial<TuiMouseEvent>) => host.handleMouse({
		type: "press", button: "left", x: width - 1, y: 2,
		screenX: width - 1, screenY: 2, width, height: rows.length + 2,
		shift: false, alt: false, ctrl: false, ...event,
	});
	return { widget, copied, rows, render, mouse };
}

test("single copy icon stays at the right edge and copies only the selected row once", () => {
	const { widget, copied, rows, render, mouse } = fixture();
	const lines = render();
	expect(lines).toHaveLength(rows.length + 2);
	for (const line of lines.slice(2)) {
		expect(visibleWidth(line)).toBe(40);
		expect(line.endsWith("⧉")).toBe(true);
		expect(line.match(/⧉/g)).toHaveLength(1);
		expect(line).not.toContain("copy log");
	}
	expect(mouse({ y: 13 })?.handled).toBe(true);
	mouse({ type: "release", y: 13 });
	mouse({ type: "click", y: 13 });
	expect(copied).toEqual(["job-11"]);
	expect(render().slice(0, 13)).toEqual(lines.slice(0, 13));
	expect(render()[13].endsWith("…")).toBe(true);
	widget.dispose();
});

test("row text, summary, modifiers, non-left buttons and wheel remain unhandled", () => {
	const { copied, render, mouse } = fixture();
	render();
	for (const event of [
		{ x: 0 }, { x: 38 }, { y: 0 }, { y: 1 }, { y: 14 }, { x: 40 },
		{ button: "right" }, { button: "middle" }, { shift: true }, { ctrl: true }, { alt: true },
		{ type: "wheel", button: "none", wheelDelta: -1 }, { type: "drag" }, { width: 39 },
	] as Partial<TuiMouseEvent>[]) expect(mouse(event)).toBeUndefined();
	expect(copied).toEqual([]);
});

test("resize and invalidation discard stale icon targets; narrow rows stay bounded", () => {
	const { widget, copied, render, mouse } = fixture();
	render();
	render(12);
	expect(mouse({ x: 39 })).toBeUndefined();
	mouse({ x: 11, y: 3 });
	expect(copied).toEqual(["job-1"]);
	widget.invalidate();
	expect(mouse({ x: 11, y: 3 })).toBeUndefined();
	for (const width of [0, 1, 2, 3, 4, 9, 80]) {
		const lines = render(width);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		if (width < 3) {
			expect(lines.join("")).not.toContain("⧉");
			expect(mouse({})).toBeUndefined();
		} else expect(lines.slice(2).every((line) => /[⧉…✓!]$/.test(line))).toBe(true);
	}
});

test("non-interactive rendering omits copy controls and never consumes mouse input", () => {
	const widget = createWidgetComponent([], [{ id: "process", header: "PROCESS RUNNING" }]);
	expect(widget.render(80)).toEqual(["PROCESS RUNNING"]);
	expect(widget.handleMouse({ type: "press", button: "left", x: 79, y: 0, width: 80 } as TuiMouseEvent)).toBeUndefined();
	expect(createWidgetComponent([], [], () => {}).render(80)).toEqual([]);
	expect("handleInput" in widget).toBe(false);
	expect("open" in widget).toBe(false);
});
