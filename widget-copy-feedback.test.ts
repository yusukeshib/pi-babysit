import { expect, test } from "bun:test";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { createWidgetComponent } from "./index.ts";

const rows = [
	{ id: "one", header: "one PROCESS RUNNING" },
	{ id: "two", header: "two AGENT IDLE" },
];
const press = { type: "press", button: "left", x: 39, y: 1, width: 40 } as TuiMouseEvent;
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("copy feedback shows pending, success and reset at the clicked icon across list refreshes", async () => {
	let resolve!: () => void;
	let calls = 0, renders = 0;
	const widget = createWidgetComponent(["RUNNING"], rows, () => {
		calls++;
		return new Promise<void>((done) => { resolve = done; });
	}, () => { renders++; });
	try {
		const initial = widget.render(40);
		widget.handleMouse(press);
		expect(widget.render(40)[1].endsWith("…")).toBe(true);
		expect(widget.render(40)[2]).toBe(initial[2]);
		widget.handleMouse(press);
		expect(calls).toBe(1);
		resolve();
		await settle();
		expect(widget.render(40)[1].endsWith("✓")).toBe(true);
		widget.update(["IDLE"], [...rows].reverse());
		expect(widget.render(40)[2].endsWith("✓")).toBe(true);
		expect(widget.render(40)[1].endsWith("⧉")).toBe(true);
		await Bun.sleep(2100);
		expect(widget.render(40)[2].endsWith("⧉")).toBe(true);
		expect(renders).toBeGreaterThanOrEqual(4);
	} finally { widget.dispose(); }
});

test("failed copies show a local failure icon and can be retried", async () => {
	let fails = true;
	const widget = createWidgetComponent(["RUNNING"], rows, async () => {
		if (fails) throw new Error("clipboard denied");
	});
	try {
		widget.render(40);
		widget.handleMouse(press);
		await settle();
		expect(widget.render(40)[1].endsWith("!")).toBe(true);
		fails = false;
		widget.handleMouse(press);
		await settle();
		expect(widget.render(40)[1].endsWith("✓")).toBe(true);
	} finally { widget.dispose(); }
});

test("removed rows and disposed widgets discard late copy results", async () => {
	let resolve!: () => void;
	let renders = 0;
	const widget = createWidgetComponent(["RUNNING"], rows,
		() => new Promise<void>((done) => { resolve = done; }), () => { renders++; });
	widget.render(40);
	widget.handleMouse(press);
	widget.update(["RUNNING"], rows.slice(1));
	const before = renders;
	resolve();
	await settle();
	expect(renders).toBe(before);
	expect(widget.render(40)[1].endsWith("⧉")).toBe(true);
	widget.handleMouse(press);
	widget.dispose();
	const disposedRenders = renders;
	resolve();
	await settle();
	expect(renders).toBe(disposedRenders);
	expect(widget.handleMouse(press)).toBeUndefined();
});
