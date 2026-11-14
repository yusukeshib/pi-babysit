/**
 * transcript-view.mjs — render standard Pi RPC events with Pi's own TUI
 * components, mirroring interactive mode's event handling.
 *
 * RPC `message_update` events are delta-only, so the streaming assistant
 * message is rebuilt from content-block deltas (see Pi docs/json.md).
 */

const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function userText(message) {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("");
}

/** Apply one delta-only assistantMessageEvent to a mutable assistant message. */
export function applyAssistantDelta(message, update) {
	if (!update || typeof update !== "object") return;
	const content = Array.isArray(message.content) ? message.content : (message.content = []);
	const index = update.contentIndex;
	switch (update.type) {
		case "text_start":
			content[index] = { type: "text", text: "" };
			break;
		case "text_delta":
			if (content[index]?.type !== "text") content[index] = { type: "text", text: "" };
			content[index].text += update.delta ?? "";
			break;
		case "text_end":
			content[index] = { ...content[index], type: "text", text: String(update.content ?? content[index]?.text ?? "") };
			break;
		case "thinking_start":
			content[index] = { type: "thinking", thinking: "" };
			break;
		case "thinking_delta":
			if (content[index]?.type !== "thinking") content[index] = { type: "thinking", thinking: "" };
			content[index].thinking += update.delta ?? "";
			break;
		case "thinking_end":
			content[index] = {
				...content[index],
				type: "thinking",
				thinking: String(update.content ?? content[index]?.thinking ?? ""),
			};
			break;
		case "toolcall_start":
			content[index] = { type: "toolCall", id: update.id, name: update.toolName, arguments: {} };
			break;
		case "toolcall_end":
			if (update.toolCall) content[index] = update.toolCall;
			break;
		default:
			break;
	}
}

export function createTranscriptView({ runtime, tui, cwd = process.cwd(), hideThinkingBlock = false }) {
	const {
		AssistantMessageComponent,
		ToolExecutionComponent,
		UserMessageComponent,
		CustomMessageComponent,
		CompactionSummaryMessageComponent,
		BranchSummaryMessageComponent,
		getMarkdownTheme,
	} = runtime.agent;
	const { Container, Spacer, Text } = runtime.tui;

	const container = new Container();
	const pendingTools = new Map();
	const expandables = [];
	const assistants = [];
	let expanded = false;
	let hideThinking = hideThinkingBlock;
	let streaming;

	const markdownTheme = () => getMarkdownTheme();
	const toolDefinition = (name) => runtime.withBuiltInRenderers?.(name, undefined);
	const add = (component) => {
		container.addChild(component);
		return component;
	};
	const addExpandable = (component) => {
		component.setExpanded?.(expanded);
		expandables.push(component);
		return add(component);
	};
	const note = (text, color = DIM) => {
		add(new Spacer(1));
		add(new Text(`${color}${text}${RESET}`, 1, 0));
	};

	function toolComponent(name, id, args) {
		let component = pendingTools.get(id);
		if (component) return component;
		component = new ToolExecutionComponent(name, id, args ?? {}, { showImages: false }, toolDefinition(name), tui, cwd);
		addExpandable(component);
		pendingTools.set(id, component);
		return component;
	}

	function syncToolCalls(message) {
		for (const block of message.content ?? []) {
			if (block?.type !== "toolCall" || !block.id) continue;
			const existing = pendingTools.get(block.id);
			if (existing) existing.updateArgs(block.arguments ?? {});
			else toolComponent(block.name, block.id, block.arguments);
		}
	}

	function newAssistant(message) {
		const component = new AssistantMessageComponent(undefined, hideThinking, markdownTheme());
		assistants.push(component);
		add(component);
		component.updateContent(message, true);
		return component;
	}

	function finishAssistant(component, message) {
		component.updateContent(message, false);
		if (message.stopReason === "aborted" || message.stopReason === "error") {
			const errorMessage =
				message.errorMessage || (message.stopReason === "aborted" ? "Operation aborted" : "Error");
			for (const tool of pendingTools.values()) {
				tool.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
			}
			pendingTools.clear();
		} else {
			for (const tool of pendingTools.values()) tool.setArgsComplete();
		}
	}

	function addMessage(message) {
		switch (message.role) {
			case "user": {
				const text = userText(message);
				if (!text) return;
				if (container.children.length > 0) add(new Spacer(1));
				add(new UserMessageComponent(text, markdownTheme()));
				return;
			}
			case "custom":
				if (message.display) addExpandable(new CustomMessageComponent(message, undefined, markdownTheme()));
				return;
			case "compactionSummary":
				add(new Spacer(1));
				addExpandable(new CompactionSummaryMessageComponent(message, markdownTheme()));
				return;
			case "branchSummary":
				add(new Spacer(1));
				addExpandable(new BranchSummaryMessageComponent(message, markdownTheme()));
				return;
			default:
				return;
		}
	}

	function apply(event) {
		switch (event?.type) {
			case "agent_start":
				pendingTools.clear();
				return;
			case "message_start": {
				const message = event.message;
				if (!message) return;
				if (message.role === "assistant") {
					const copy = { ...message, content: [...(Array.isArray(message.content) ? message.content : [])] };
					streaming = { message: copy, component: newAssistant(copy) };
				} else {
					addMessage(message);
				}
				return;
			}
			case "message_update": {
				if (!streaming) return;
				if (event.message?.role === "assistant") {
					// Cumulative snapshot from old Pi releases.
					streaming.message = { ...event.message, content: [...(event.message.content ?? [])] };
				} else {
					applyAssistantDelta(streaming.message, event.assistantMessageEvent);
				}
				if (event.usage) streaming.message.usage = event.usage;
				streaming.component.updateContent(streaming.message, true);
				syncToolCalls(streaming.message);
				return;
			}
			case "message_end": {
				const message = event.message;
				if (message?.role !== "assistant") return;
				const component = streaming?.component ?? newAssistant(message);
				syncToolCalls(message);
				finishAssistant(component, message);
				streaming = undefined;
				return;
			}
			case "tool_execution_start": {
				if (event.parentToolCallId) return;
				const component = toolComponent(event.toolName, event.toolCallId, event.args);
				component.markExecutionStarted?.();
				return;
			}
			case "tool_execution_update":
				pendingTools.get(event.toolCallId)?.updateResult({ ...event.partialResult, isError: false }, true);
				return;
			case "tool_execution_end": {
				const component = pendingTools.get(event.toolCallId);
				if (!component) return;
				component.updateResult({ ...event.result, isError: event.isError, durationMs: event.durationMs });
				pendingTools.delete(event.toolCallId);
				return;
			}
			case "agent_end":
				if (streaming) {
					container.removeChild(streaming.component);
					streaming = undefined;
				}
				pendingTools.clear();
				return;
			case "entry_appended": {
				const entry = event.entry;
				if (entry?.type === "custom_message" && entry.display) {
					addMessage({
						role: "custom",
						customType: entry.customType,
						content: entry.content,
						display: entry.display,
						details: entry.details,
						timestamp: entry.timestamp,
					});
				}
				return;
			}
			case "compaction_end":
				if (event.result?.summary) {
					addMessage({
						role: "compactionSummary",
						summary: event.result.summary,
						tokensBefore: event.result.tokensBefore,
						timestamp: Date.now(),
					});
				}
				return;
			case "extension_error":
				note(`Extension error${event.extensionPath ? ` (${event.extensionPath})` : ""}: ${event.error ?? ""}`, RED);
				return;
			case "error":
				note(`Error: ${event.message ?? event.error ?? JSON.stringify(event)}`, RED);
				return;
			case "response":
				if (event.success === false) note(`RPC ${event.command ?? "command"} failed: ${event.error ?? ""}`, RED);
				return;
			default:
				return;
		}
	}

	return {
		container,
		apply,
		get expanded() {
			return expanded;
		},
		setToolsExpanded(value) {
			expanded = value;
			for (const component of expandables) component.setExpanded?.(value);
		},
		toggleThinking() {
			hideThinking = !hideThinking;
			for (const component of assistants) component.setHideThinkingBlock(hideThinking);
			return hideThinking;
		},
	};
}
