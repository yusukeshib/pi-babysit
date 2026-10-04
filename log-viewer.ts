import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	Markdown,
	ScrollView,
	Text,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";

import { FileLogSource, type LogPage } from "./log-source";

export interface LogViewerOptions {
	getHeight: () => number;
	requestRender: () => void;
	getTheme: () => Theme;
	onClose: () => void;
}

/** Only numeric SGR escapes are allowed; never forward cursor, hyperlink or image controls. */
function sanitize(text: string, sgr = false): string {
	return text
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, "")
		.replace(/\x1b[P_^X][\s\S]*?(?:\x1b\\|$)/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/\t/g, "    ")
		.replace(
			/\x1b\[[0-?]*[ -/]*[@-~]|\x1b[^\[]?|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,
			(s) => (sgr && /^\x1b\[[\d;]*m$/.test(s) ? s : ""),
		);
}
type Block = { kind: "assistant" | "tool" | "result" | "error"; text: string; timestamp?: number };
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	return Array.isArray(content)
		? content
				.filter((c) => c?.type === "text")
				.map((c) => c.text ?? "")
				.join("")
		: "";
}
function agentBlocks(raw: string, timestamps?: (number | undefined)[]): Block[] {
	const blocks: Block[] = [];
	let current: Block | undefined;
	const toolResults = new Map<string, Block>();
	const assistant = (timestamp: number | undefined) => {
		current ??= (blocks.push({ kind: "assistant", text: "", timestamp }), blocks[blocks.length - 1]);
		current.timestamp ??= timestamp;
		return current;
	};
	for (const [index, line] of raw.split(/\r\n|\r|\n/).entries()) {
		const timestamp = timestamps?.[index];
		let e: any;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (!e || typeof e !== "object") continue;
		if (e.type === "agent_start") { current = undefined; toolResults.clear(); }
		if (e.type === "message_start" && e.message?.role === "assistant")
			current = undefined;
		if (["message_start", "message_update", "message_end"].includes(e.type)) {
			if (e.message?.role === "assistant") {
				const text = contentText(e.message.content);
				const b = assistant(timestamp);
				if (text) b.text = text; // cumulative/final snapshots replace streamed deltas
				if (e.message.errorMessage)
					blocks.push({ kind: "error", text: String(e.message.errorMessage), timestamp });
				if (e.type === "message_end") current = undefined;
			} else if (
				!e.message &&
				e.assistantMessageEvent?.type === "text_delta" &&
				typeof e.assistantMessageEvent.delta === "string"
			) {
				assistant(timestamp).text += e.assistantMessageEvent.delta;
			} else if (e.type === "message_end" && e.message?.role === "toolResult") {
				const id = e.message.toolCallId;
				const text = contentText(e.message.content);
				if (id && toolResults.has(id)) {
					const b = toolResults.get(id)!;
					b.text = text;
					b.timestamp ??= timestamp;
					b.kind = e.message.isError ? "error" : b.kind;
				} else {
					const b: Block = {
						kind: e.message.isError ? "error" : "result",
						text,
						timestamp,
					};
					blocks.push(b);
					if (id) toolResults.set(id, b);
				}
			}
		} else if (e.type === "tool_execution_start") {
			blocks.push({
				kind: "tool",
				text: `${e.toolName ?? "tool"} ${JSON.stringify(e.args ?? {})}`,
				timestamp,
			});
		} else if (e.type === "tool_execution_end") {
			const b: Block = {
				kind: e.isError ? "error" : "result",
				timestamp,
				text:
					contentText(e.result?.content) ||
					String(e.error?.message ?? e.error ?? ""),
			};
			if (b.text) {
				blocks.push(b);
				if (e.toolCallId) toolResults.set(e.toolCallId, b);
			}
		} else if (e.type === "error")
			blocks.push({
				kind: "error",
				timestamp,
				text: String(
					e.message ?? e.error?.message ?? e.error ?? "Unknown error",
				),
			});
	}
	return blocks
		.filter((b) => b.text)
		.map((b) => ({ ...b, text: sanitize(b.text) }));
}

function dateLabel(timestamp: number): string {
	const date = new Date(timestamp);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `[${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}]`;
}

export function createLogViewer(options: LogViewerOptions) {
	let header = "",
		raw = "",
		description = "",
		isAgent = false;
	let lineTimestamps: (number | undefined)[] | undefined;
	let source: FileLogSource | undefined;
	let pages: LogPage[] = [];
	let sourceSize = 0;
	let tailDirty = false;
	let metadataVersion = "";
	let adjacentPageStart: number | undefined;
	const setPages = () => {
		raw = pages.map((page) => page.text).join("");
		lineTimestamps = pages.flatMap((page, i) =>
			i < pages.length - 1 && /[\r\n]$/.test(page.text)
				? page.lineTimestamps.slice(0, -1) : page.lineTimestamps);
		body.invalidate();
	};
	let cache: string[] | undefined,
		cacheWidth = -1,
		cacheTheme: Theme | undefined;
	const body: Component = {
		invalidate() {
			cache = undefined;
		},
		render(width) {
			const theme = options.getTheme();
			if (cache && cacheWidth === width && cacheTheme === theme) return cache;
			const blocks = isAgent
				? agentBlocks(raw, lineTimestamps)
				: [{ kind: "result" as const, text: sanitize(raw, true) }];
			const lines: string[] = description && (!source || pages[0]?.start === 0)
				? [
						theme.fg("muted", isAgent ? "[task]" : "[command]"),
						...new Text(sanitize(description), 0, 0).render(width),
						"",
					]
				: [];
			for (const b of blocks) {
				if (!isAgent && lineTimestamps?.some((time) => time !== undefined)) {
					for (const [index, text] of raw.split(/\r\n|\r|\n/).entries()) {
						const time = lineTimestamps[index];
						const label = time === undefined ? "" : dateLabel(time);
						const indent = label ? visibleWidth(label) + 1 : 0;
						if (indent && width <= indent + 4) {
							lines.push(...new Text(theme.fg("muted", label), 0, 0).render(width));
							lines.push(...new Text(sanitize(text, true), 0, 0).render(width));
						} else {
							const wrapped = new Text(sanitize(text, true), 0, 0).render(width - indent);
							lines.push(...wrapped.map((line, row) =>
								(row === 0 && label ? theme.fg("muted", label) + " " : " ".repeat(indent)) + line));
						}
					}
					continue;
				}
				if (isAgent && b.timestamp !== undefined) {
					const date = theme.fg("muted", dateLabel(b.timestamp));
					const kind = theme.fg(b.kind === "error" ? "error" : b.kind === "assistant" ? "accent" : "toolTitle", `[${b.kind}]`);
					const indent = visibleWidth(date) + 1;
					const kindIndent = visibleWidth(kind) + 1;
					if (width <= indent + kindIndent + 4) {
						lines.push(...new Text(date, 0, 0).render(width));
						lines.push(...new Text(`${kind} ${b.text}`, 0, 0).render(width));
					} else {
						const contentWidth = width - indent - kindIndent;
						const rendered = b.kind === "assistant"
							? new Markdown(b.text, 0, 0, getMarkdownTheme()).render(contentWidth)
							: new Text(b.text, 0, 0).render(contentWidth);
						lines.push(...rendered.map((line, row) =>
							`${date} ${row === 0 ? kind + " " : " ".repeat(kindIndent)}${line}`));
					}
					continue;
				}
				if (isAgent) {
					lines.push(
						theme.fg(
							b.kind === "error"
								? "error"
								: b.kind === "assistant"
									? "accent"
									: "toolTitle",
							`[${b.kind}]`,
						),
					);
				}
				lines.push(
					...(b.kind === "assistant"
						? new Markdown(b.text, 0, 0, getMarkdownTheme()).render(width)
						: new Text(b.text, 0, 0).render(width)),
				);
			}
			if (!blocks.some((block) => block.text.trim()))
				lines.push(theme.fg("muted", "(no output available)"));
			cache = lines;
			cacheWidth = width;
			cacheTheme = theme;
			return cache;
		},
	};
	const scrollView = new ScrollView(body, {
		follow: "end",
		overscroll: "contain",
		scrollbar: "always",
		scrollbarTrackStyle: (s) => options.getTheme().fg("scrollbarTrack", s),
		scrollbarThumbStyle: (s) => options.getTheme().fg("scrollbarThumb", s),
	});
	const heading = {
		invalidate() {},
		render(width: number) {
			const close = truncateToWidth("[Close]", width);
			const room = Math.max(0, width - visibleWidth(close) - 1);
			const title = truncateToWidth(sanitize(header).replace(/\n/g, " "), room);
			return [
				options.getTheme().fg("accent", title) +
					" ".repeat(
						Math.max(0, width - visibleWidth(title) - visibleWidth(close)),
					) +
					options.getTheme().fg("muted", close),
			];
		},
		handleMouse(e: TuiMouseEvent) {
			if (
				e.button !== "left" ||
				e.x < Math.max(0, e.width - 7) ||
				e.x >= e.width
			)
				return;
			if (e.type === "press") {
				options.onClose();
				return { handled: true };
			}
			if (e.type === "click" || e.type === "release") return { handled: true };
		},
	};
	const footer: Component = {
		invalidate() {},
		render: (width) => [
			options.getTheme().fg("dim", truncateToWidth(source ? `↑↓ · bytes ${pages[0]?.start ?? 0}–${pages.at(-1)?.end ?? 0}/${source.size} (window) · Esc close` : "↑↓ · Esc close", width)),
		],
	};
	let geometry = {
		width: 0,
		height: 0,
		thumbTop: 0,
		thumbHeight: 0,
		maxTop: 0,
	};
	let dragOffset: number | undefined;
	// Stock widget Containers are opaque to native layout. Draw and route this
	// viewport locally, retaining the public ScrollView's follow/scroll state.
	return {
		scrollView,
		render(width: number) {
			width = Math.max(0, Math.floor(width));
			const height = Math.max(0, Math.floor(options.getHeight()) - 2);
			const contentWidth = Math.max(0, width - 1);
			const renderWidth = Math.max(1, contentWidth);
			let lines = body.render(renderWidth);
			scrollView.updateLayout(lines.length, height, options.requestRender);
			const followAtEof = source && pages.at(-1)?.end === source.size && scrollView.isFollowingEnd;
			if (source && tailDirty && scrollView.scrollTop + height >= lines.length) {
				const anchor = scrollView.scrollTop;
				pages[pages.length - 1] = source.after(pages.at(-1)!.start);
				tailDirty = false; setPages(); lines = body.render(renderWidth);
				scrollView.updateLayout(lines.length, height, options.requestRender);
				scrollView.scrollTo(anchor, { disableFollow: true });
			}
			if (source && pages.length && height > 0) {
				const top = scrollView.scrollTop;
				const first = pages[0], last = pages[pages.length - 1];
				if (top === 0 && first.start > 0) {
					const page = source.before(first.start);
					if (page.start < first.start) {
						adjacentPageStart = page.start;
						pages.unshift(page); setPages();
						const anchor = top + body.render(renderWidth).length - lines.length;
						lines = body.render(renderWidth);
						scrollView.updateLayout(lines.length, height, options.requestRender);
						if (followAtEof) scrollView.scrollToEnd();
						else scrollView.scrollTo(anchor, { disableFollow: true });
					}
				} else if (top + height >= lines.length && last.end < source.size) {
					const page = source.after(last.end);
					if (page.end > last.end) {
						adjacentPageStart = page.start;
						pages.push(page); setPages();
						const anchor = top;
						lines = body.render(renderWidth);
						scrollView.updateLayout(lines.length, height, options.requestRender);
						scrollView.scrollTo(anchor, { disableFollow: true });
					}
				}
			}
			// A resize may make formerly visible pages evictable. Keep only the
			// small window plus pages that actually intersect the viewport.
			while (source && pages.length > 3) {
				const top = scrollView.scrollTop;
				const first = pages.shift()!; setPages();
				let next = body.render(renderWidth);
				const delta = lines.length - next.length;
				if (top >= delta && first.start !== adjacentPageStart) {
					lines = next;
					scrollView.updateLayout(lines.length, height, options.requestRender);
					if (followAtEof) scrollView.scrollToEnd();
					else scrollView.scrollTo(top - delta, { disableFollow: true });
					continue;
				}
				pages.unshift(first);
				const last = pages.pop()!; setPages(); next = body.render(renderWidth);
				if (top + height <= next.length && last.start !== adjacentPageStart) {
					lines = next;
					scrollView.updateLayout(lines.length, height, options.requestRender);
					if (followAtEof) scrollView.scrollToEnd();
					else scrollView.scrollTo(top, { disableFollow: true });
					continue;
				}
				pages.push(last); setPages(); lines = body.render(renderWidth);
				break;
			}
			if (source && source.size === 0 && raw) {
				pages = [source.before()]; tailDirty = false; setPages();
				lines = body.render(renderWidth);
				scrollView.updateLayout(lines.length, height, options.requestRender);
			}
			const visible = lines.slice(
				scrollView.scrollTop,
				scrollView.scrollTop + height,
			);
			const thumbHeight =
				height === 0
					? 0
					: Math.max(
							1,
							Math.min(
								height,
								Math.round((height * height) / Math.max(1, lines.length)),
							),
						);
			const maxTop = Math.max(0, lines.length - height);
			const thumbTop =
				maxTop === 0
					? 0
					: Math.round(
							(scrollView.scrollTop / maxTop) * (height - thumbHeight),
						);
			geometry = { width, height, thumbTop, thumbHeight, maxTop };
			return [
				...heading.render(width),
				...Array.from({ length: height }, (_, row) => {
					if (width === 0) return "";
					const text = truncateToWidth(visible[row] ?? "", contentWidth);
					const thumb = row >= thumbTop && row < thumbTop + thumbHeight;
					return (
						text +
						" ".repeat(Math.max(0, contentWidth - visibleWidth(text))) +
						options
							.getTheme()
							.fg(
								thumb ? "scrollbarThumb" : "scrollbarTrack",
								thumb ? (dragOffset === undefined ? "┃" : "█") : "│",
							)
					);
				}),
				...footer.render(width),
			];
		},
		handleMouse(e: TuiMouseEvent) {
			if (dragOffset !== undefined) {
				if (e.type === "release") {
					dragOffset = undefined;
					return { handled: true, render: true };
				}
				if (e.type === "drag" || e.type === "move") {
					const travel = geometry.height - geometry.thumbHeight;
					const offset = Math.max(0, Math.min(travel, e.y - 1 - dragOffset));
					scrollView.scrollTo(
						travel > 0
							? Math.round((offset / travel) * geometry.maxTop)
							: scrollView.scrollTop,
					);
					return { handled: true, render: true };
				}
			}
			if (e.y === 0) return heading.handleMouse(e);
			if (e.y < 1 || e.y > geometry.height || e.x < 0 || e.x >= geometry.width)
				return;
			if (e.type === "wheel") {
				scrollView.scrollBy(e.wheelDelta ?? 0);
				return { handled: true, render: true };
			}
			if (e.x === geometry.width - 1 && e.button === "left") {
				if (e.type === "press") {
					const row = e.y - 1;
					if (
						row >= geometry.thumbTop &&
						row < geometry.thumbTop + geometry.thumbHeight
					) {
						dragOffset = row - geometry.thumbTop;
						return { handled: true, capture: true, render: true };
					}
					scrollView.scrollBy(
						row < geometry.thumbTop ? -geometry.height : geometry.height,
					);
				}
				if (["press", "click", "release"].includes(e.type))
					return { handled: true, render: true };
			}
		},
		invalidate() {
			body.invalidate();
		},
		dispose() { source?.dispose(); source = undefined; pages = []; raw = ""; body.invalidate(); },
		updateSource(nextHeader: string, nextSource: FileLogSource, context = "") {
			header = nextHeader;
			const changed = source !== nextSource;
			if (changed) { source?.dispose(); pages = []; }
			source = nextSource;
			const reset = source.refresh();
			isAgent = source.isAgent;
			if (description !== context) body.invalidate();
			description = context;
			if (changed || reset || !pages.length) {
				adjacentPageStart = undefined;
				tailDirty = false;
				pages = [source.before()]; setPages(); scrollView.scrollToEnd();
			} else if (source.size !== sourceSize) {
				if (scrollView.isFollowingEnd && pages.at(-1)?.end === sourceSize) {
					tailDirty = false;
					pages = [source.before()]; setPages(); scrollView.scrollToEnd();
				} else if (pages.at(-1)?.end === sourceSize) {
					tailDirty = true;
				}
			}
			if (metadataVersion !== source.metadataVersion && !changed && !reset) {
				pages = pages.map(page => source!.retime(page)); setPages();
			}
			metadataVersion = source.metadataVersion;
			sourceSize = source.size;
			options.requestRender();
		},
		update(nextHeader: string, logText: string, agent: boolean, context = "", timestamps?: (number | undefined)[]) {
			if (source) { source.dispose(); source = undefined; pages = []; }
			header = nextHeader;
			if (raw !== logText || isAgent !== agent || description !== context ||
				JSON.stringify(lineTimestamps) !== JSON.stringify(timestamps)) {
				lineTimestamps = timestamps;
				raw = logText;
				isAgent = agent;
				description = context;
				body.invalidate();
			}
			options.requestRender();
		},
		handleKey(data: string): boolean {
			if (matchesKey(data, Key.escape)) {
				options.onClose();
				return true;
			}
			if (matchesKey(data, Key.up)) scrollView.scrollBy(-1);
			else if (matchesKey(data, Key.down)) scrollView.scrollBy(1);
			else return false;
			options.requestRender();
			return true;
		},
	};
}
