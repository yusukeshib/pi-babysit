/**
 * pi-environment.mjs — reproduce the parts of Pi's interactive startup that
 * decide how a transcript looks: settings, themes (including ones registered
 * through `settings.themes` and packages), terminal capability overrides,
 * keybindings, and extension tool / message renderers.
 *
 * Extensions are loaded the way Pi loads them (DefaultResourceLoader), but no
 * session is started: extension factories run, session events never fire.
 * Missing packages are skipped, never installed.
 */
import os from "node:os";
import path from "node:path";

const SYSTEM_THEME_NAME = "system";

function call(target, method, ...args) {
	return typeof target?.[method] === "function" ? target[method](...args) : undefined;
}

function defaultAgentDir(agent) {
	return (
		call(agent, "getAgentDir") ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent")
	);
}

/**
 * Pi's project trust decision without prompting: a remembered decision, then
 * "trusted" when the project has no trust-requiring resources, then the
 * `defaultProjectTrust` setting. An undecided project stays untrusted, so the
 * viewer never runs project-local extension code the user has not approved.
 */
function resolveProjectTrusted({ runtime, cwd, agentDir }) {
	const trust = runtime.internal?.trust;
	const { SettingsManager } = runtime.agent;
	try {
		const remembered = trust?.ProjectTrustStore ? new trust.ProjectTrustStore(agentDir).get(cwd) : undefined;
		if (remembered === true || remembered === false) return remembered;
		const requiresTrust = trust?.hasTrustRequiringProjectResources?.(cwd) ?? true;
		if (!requiresTrust) return true;
		const global = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		return call(global, "getDefaultProjectTrust") === "always";
	} catch {
		return false;
	}
}

async function loadResources({ runtime, cwd, agentDir, settingsManager, diagnostics }) {
	const { DefaultResourceLoader } = runtime.agent;
	if (typeof DefaultResourceLoader !== "function") return undefined;
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: runtime.internal?.builtInExtensions?.builtInExtensions ?? [],
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
	});
	const packageManager = loader.packageManager;
	if (typeof packageManager?.resolve !== "function") {
		diagnostics.push("Extensions not loaded: this Pi release does not allow resolving packages without installing them");
		return undefined;
	}
	// A viewer must not install packages; Pi's startup prompts do the same.
	const resolve = packageManager.resolve.bind(packageManager);
	packageManager.resolve = (onMissing) => resolve(onMissing ?? (async () => "skip"));
	await loader.reload();
	return loader;
}

function createRenderContext({ runtime, settingsManager, extensions }) {
	const { ExtensionRunner, getMarkdownTheme } = runtime.agent;
	const runner =
		extensions && typeof ExtensionRunner === "function"
			? new ExtensionRunner(extensions.extensions, extensions.runtime, undefined, undefined, undefined)
			: undefined;
	const builtIn = (name, definition) => runtime.withBuiltInRenderers?.(name, definition) ?? definition;
	const mermaid = runtime.internal?.mermaid?.createMermaidMarkdownTransformer;
	const themeProxy = runtime.internal?.theme?.theme;
	const mermaidTransformer =
		mermaid && themeProxy && typeof settingsManager?.getMermaidRenderingMode === "function"
			? mermaid({ getMode: () => settingsManager.getMermaidRenderingMode(), theme: themeProxy })
			: undefined;
	return {
		// Same lookup as InteractiveMode.getRegisteredToolDefinition().
		getToolDefinition(name) {
			const base = () => builtIn(name, runner?.getToolDefinition(name));
			return runner ? runner.resolveToolRenderers(name, base) : base();
		},
		getMessageRenderer: (customType) => runner?.getMessageRenderer(customType),
		getMarkdownTransformers: () => [
			...(mermaidTransformer ? [mermaidTransformer] : []),
			...(runner?.getMarkdownTransformers() ?? []),
		],
		markdownTheme: () => {
			const codeBlockIndent = call(settingsManager, "getCodeBlockIndent");
			return codeBlockIndent === undefined ? getMarkdownTheme() : { ...getMarkdownTheme(), codeBlockIndent };
		},
		hideThinkingBlock: call(settingsManager, "getHideThinkingBlock") === true,
		outputPad: call(settingsManager, "getOutputPad"),
		showImages: call(settingsManager, "getShowImages") ?? false,
		imageWidthCells: call(settingsManager, "getImageWidthCells"),
	};
}

/**
 * Load { settingsManager, themes, render, diagnostics } for a worker running in
 * `cwd`. `render` is the transcript-view render context.
 */
export async function loadPiEnvironment(runtime, { cwd, agentDir = defaultAgentDir(runtime.agent) } = {}) {
	const diagnostics = [];
	const { SettingsManager } = runtime.agent;
	let settingsManager;
	let loader;
	try {
		settingsManager = SettingsManager.create(cwd, agentDir, {
			projectTrusted: resolveProjectTrusted({ runtime, cwd, agentDir }),
		});
		loader = await loadResources({ runtime, cwd, agentDir, settingsManager, diagnostics });
	} catch (error) {
		diagnostics.push(`Pi resources not loaded: ${error instanceof Error ? error.message : String(error)}`);
	}
	const extensions = loader?.getExtensions();
	for (const { path: extensionPath, error } of extensions?.errors ?? []) {
		diagnostics.push(`Failed to load extension "${extensionPath}": ${error}`);
	}
	return {
		settingsManager,
		themes: loader?.getThemes().themes ?? [],
		render: createRenderContext({ runtime, settingsManager, extensions }),
		diagnostics,
	};
}

/** Terminal capability overrides and keybindings, as interactive mode sets them. */
export function applyTerminalSettings(runtime, environment) {
	const overrides = call(environment.settingsManager, "getTerminalCapabilityOverrides");
	if (overrides) call(runtime.tui, "setCapabilityOverrides", overrides);
	const KeybindingsManager = runtime.internal?.keybindings?.KeybindingsManager;
	if (KeybindingsManager && typeof runtime.tui.setKeybindings === "function") {
		try {
			runtime.tui.setKeybindings(KeybindingsManager.create());
		} catch {
			/* default keybindings */
		}
	}
}

function themeName(runtime, settingsManager) {
	const themeModule = runtime.internal?.theme;
	const setting = call(settingsManager, "getThemeSetting") ?? call(settingsManager, "getTheme");
	if (typeof themeModule?.resolveThemeSetting !== "function") return setting;
	return themeModule.resolveThemeSetting(setting, call(themeModule, "getTerminalTheme")) ?? SYSTEM_THEME_NAME;
}

/**
 * Apply the theme setting. With a `ui`, follow interactive mode: the returned
 * `start()` (call after `ui.start()`) queries the terminal's colors and keeps
 * the system theme and light/dark pairs in sync with the terminal. Without a
 * `ui` (print mode) the theme is applied once.
 */
export function initPiTheme(runtime, environment, ui) {
	const themeModule = runtime.internal?.theme;
	call(themeModule, "setRegisteredThemes", environment.themes);
	const Controller = runtime.internal?.themeController?.InteractiveThemeController;
	if (ui && Controller && environment.settingsManager) {
		const controller = new Controller(ui, {
			getSettingsManager: () => environment.settingsManager,
			showError: () => {},
			onChanged: () => {},
		});
		return { start: () => controller.applyFromSettings() };
	}
	runtime.agent.initTheme(themeName(runtime, environment.settingsManager), false);
	return { start() {} };
}
