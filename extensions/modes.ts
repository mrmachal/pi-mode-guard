/**
 * Modes — chat / plan / act for Pi
 *
 * A mode is an active tool set plus a piece of system prompt:
 *
 *   chat -> every tool except `edit`/`write`, shell limited to read-only commands
 *   plan -> the same, and the model must answer with a numbered `Plan:`
 *   act  -> everything, including `edit`/`write`
 *
 * This file owns the mode definitions, switching, the session record, and prompt injection.
 * `readonly-guard.ts` owns enforcement (the shell allowlist) and the footer chip; the two
 * share only the `preset-state` session entry, so either works without the other.
 *
 * Definitions merge per mode, in this order:
 *   1. BUILT_IN_PRESETS below
 *   2. ~/.pi/agent/presets.json
 *   3. <cwd>/.pi/presets.json
 *
 * Usage:
 * - `/preset` shows a picker; `/preset chat|plan|act` switches directly
 * - `Ctrl+Shift+U` cycles through the modes
 * - `pi --preset plan` starts in a mode
 *
 * A session with no recorded mode starts in STARTUP_PRESET. Resuming a session re-applies the
 * mode recorded on its branch, tools included, so a read-only session never comes back
 * writable. `before_agent_start` folds the mode's instructions and the read-only brief into a
 * single system prompt, because results do not compose across handlers.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, DynamicBorder, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Container, Key, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

// Preset configuration
interface Preset {
	/** Provider name (e.g., "anthropic", "openai") */
	provider?: string;
	/** Model ID (e.g., "claude-sonnet-4-5") */
	model?: string;
	/** Thinking level */
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	/** Tools to enable (replaces default set). `"*"` means every registered tool. */
	tools?: string[];
	/** Tools removed from the selection after `tools` is applied. */
	excludeTools?: string[];
	/** Instructions to append to system prompt */
	instructions?: string;
}

interface PresetsConfig {
	[name: string]: Preset;
}

const WRITE_TOOLS = new Set(["edit", "write"]);

/** Handed to the model only while the shell is restricted. */
const READ_ONLY_BRIEF = `Read-only mode: \`edit\` and \`write\` are unavailable and shell writes are blocked.

If the user asks for a change, give the complete solution instead of attempting one: the exact file path plus a unified diff or a full replacement snippet that is ready to paste. Then finish with one short line telling the user to run \`/preset act\` to apply it. Never skip the solution, and never stop at "I cannot modify files".`;

/**
 * Modes shipped with the package, so a fresh machine needs no presets.json. They are the base:
 * `~/.pi/agent/presets.json` overrides them, then `<cwd>/.pi/presets.json` overrides that.
 * Models and thinking levels are left unset on purpose, so each device keeps its own.
 */
const BUILT_IN_PRESETS: PresetsConfig = {
	chat: {
		tools: ["*"],
		excludeTools: ["edit", "write"],
		instructions: `You are in CHAT MODE. The user wants an answer, not a code change.

Rules:
- Never modify, create, move, or delete files. \`edit\` and \`write\` are disabled, and shell commands that change anything are blocked.
- Gather whatever you need first: read files, search with grep/find/ls, use the web tools, then answer directly in the reply.
- Do not propose patches or write plans unless asked. Explain, compare, and summarize instead.
- If the user does ask for a change, describe what you would do and tell them to switch with \`/preset act\`.`,
	},
	plan: {
		tools: ["*"],
		excludeTools: ["edit", "write"],
		instructions: `You are in PLAN MODE. Explore the codebase and produce an implementation plan; make no changes.

Rules:
- No file changes and no state-changing shell commands. \`edit\` and \`write\` are disabled; shell access is limited to read-only commands.
- Read files in full, grep for related code and call sites, and check tests, configs, and dependencies before concluding.
- Ask clarifying questions instead of guessing at requirements.

Output the plan in exactly this shape so progress can be tracked:

Plan:
1. <step>
2. <step>

For each step give: files to touch, why, risks, and how to verify. Finish by offering the user three options: write the plan to PLAN.md, open an issue, or switch with \`/preset act\` to implement.`,
	},
	act: {
		tools: ["*"],
		instructions: `You are in ACT MODE. The user wants changes made.

Rules:
- Read a file before editing it; prefer \`edit\` over \`write\` on existing files.
- Keep the scope tight: do exactly what was asked, nothing extra.
- Run the project's tests or type checks after non-trivial changes (npm test, npm run check, go build, cargo check, ...).
- If the task turns out more complex or riskier than expected, stop and explain instead of hacking around it.
- Finish with a short summary of what changed and any follow-up work.`,
	},
};

/**
 * Load modes from config files.
 * Modes merge per mode, so an override may change only the instructions:
 * project beats agent directory beats the built-in defaults.
 */
function loadPresets(cwd: string): PresetsConfig {
	const globalPath = join(getAgentDir(), "presets.json");
	const projectPath = join(cwd, CONFIG_DIR_NAME, "presets.json");

	let globalPresets: PresetsConfig = {};
	let projectPresets: PresetsConfig = {};

	// Load global presets
	if (existsSync(globalPath)) {
		try {
			const content = readFileSync(globalPath, "utf-8");
			globalPresets = JSON.parse(content);
		} catch (err) {
			console.error(`Failed to load global presets from ${globalPath}: ${err}`);
		}
	}

	// Load project presets
	if (existsSync(projectPath)) {
		try {
			const content = readFileSync(projectPath, "utf-8");
			projectPresets = JSON.parse(content);
		} catch (err) {
			console.error(`Failed to load project presets from ${projectPath}: ${err}`);
		}
	}

	const merged: PresetsConfig = {};
	for (const [name, preset] of Object.entries(BUILT_IN_PRESETS)) merged[name] = { ...preset };
	for (const source of [globalPresets, projectPresets]) {
		for (const [name, preset] of Object.entries(source)) merged[name] = { ...merged[name], ...preset };
	}
	return merged;
}

interface OriginalState {
	model: Model<Api> | undefined;
	thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	tools: string[];
}

/**
 * Mode applied to a session that has no recorded mode: a fresh start, or a session
 * created before modes were persisted. Change this to change the startup default.
 */
const STARTUP_PRESET = "chat";

/** What a mode record on the session branch carries. */
interface ModeRecord {
	name: string | null;
}

/**
 * The last mode record on the active branch. Returns undefined when the branch holds none and
 * null when it cannot be read at all (an invalidated context), which callers must not confuse
 * with a cleared mode.
 */
function lastModeRecord(ctx: ExtensionContext): ModeRecord | null | undefined {
	try {
		const entries = ctx.sessionManager.getBranch();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as { type?: string; customType?: string; data?: ModeRecord };
			if (entry.type !== "custom" || entry.customType !== "preset-state") continue;
			return entry.data ?? { name: null };
		}
		return undefined;
	} catch {
		return null;
	}
}

export default function presetExtension(pi: ExtensionAPI) {
	let presets: PresetsConfig = {};
	let activePresetName: string | undefined;
	let activePreset: Preset | undefined;
	let originalState: OriginalState | undefined;

	// Register --preset CLI flag
	pi.registerFlag("preset", {
		description: "Preset configuration to use",
		type: "string",
	});

	/**
	 * Apply a preset configuration.
	 */
	async function applyPreset(
		name: string,
		preset: Preset,
		ctx: ExtensionContext,
		captureOriginal = true,
	): Promise<boolean> {
		// Snapshot the pre-preset state once, before the first preset of this process applies,
		// but never on a `/reload`: there the tool set is already whatever the preset applied,
		// so a snapshot would record a restricted set and "restore defaults" would restore that.
		if (captureOriginal && activePresetName === undefined) {
			originalState = {
				model: ctx.model,
				thinkingLevel: pi.getThinkingLevel(),
				tools: pi.getActiveTools(),
			};
		}

		// Apply model if specified
		if (preset.provider && preset.model) {
			const model = ctx.modelRegistry.find(preset.provider, preset.model);
			if (model) {
				const success = await pi.setModel(model);
				if (!success) {
					ctx.ui.notify(`Preset "${name}": No API key for ${preset.provider}/${preset.model}`, "warning");
				}
			} else {
				ctx.ui.notify(`Preset "${name}": Model ${preset.provider}/${preset.model} not found`, "warning");
			}
		}

		// Apply thinking level if specified
		if (preset.thinkingLevel) {
			pi.setThinkingLevel(preset.thinkingLevel);
		}

		// Apply tools if specified
		if (preset.tools && preset.tools.length > 0) {
			const allToolNames = pi.getAllTools().map((t) => t.name);
			const wanted = preset.tools.includes("*") ? allToolNames : preset.tools;
			const excluded = new Set(preset.excludeTools ?? []);
			const validTools = wanted.filter((t) => allToolNames.includes(t) && !excluded.has(t));
			const invalidTools = preset.tools.filter((t) => t !== "*" && !allToolNames.includes(t));

			if (invalidTools.length > 0) {
				ctx.ui.notify(`Preset "${name}": Unknown tools: ${invalidTools.join(", ")}`, "warning");
			}

			if (validTools.length > 0) {
				pi.setActiveTools(validTools);
			}
		}

		// Store active preset for system prompt injection
		activePresetName = name;
		activePreset = preset;
		// Record it now rather than on the next turn: the footer chip reads the branch, so a
		// delayed write would leave it showing the previous mode until then.
		persistState(ctx);

		return true;
	}

	/**
	 * Build description string for a preset.
	 */
	function buildPresetDescription(preset: Preset): string {
		const parts: string[] = [];

		if (preset.provider && preset.model) {
			parts.push(`${preset.provider}/${preset.model}`);
		}
		if (preset.thinkingLevel) {
			parts.push(`thinking:${preset.thinkingLevel}`);
		}
		if (preset.tools) {
			parts.push(`tools:${preset.tools.join(",")}`);
		}
		if (preset.instructions) {
			const truncated =
				preset.instructions.length > 30 ? `${preset.instructions.slice(0, 27)}...` : preset.instructions;
			parts.push(`"${truncated}"`);
		}

		return parts.join(" | ");
	}

	/**
	 * Show preset selector UI using custom SelectList component.
	 */
	async function showPresetSelector(ctx: ExtensionContext): Promise<void> {
		const presetNames = Object.keys(presets);

		if (presetNames.length === 0) {
			ctx.ui.notify(
				`No presets defined. Add presets to ${join(getAgentDir(), "presets.json")} or ${join(ctx.cwd, CONFIG_DIR_NAME, "presets.json")}`,
				"warning",
			);
			return;
		}

		// Build select items with descriptions
		const items: SelectItem[] = presetNames.map((name) => {
			const preset = presets[name];
			const isActive = name === activePresetName;
			return {
				value: name,
				label: isActive ? `${name} (active)` : name,
				description: buildPresetDescription(preset),
			};
		});

		// Add "None" option to clear preset
		items.push({
			value: "(none)",
			label: "(none)",
			description: "Clear active preset, restore defaults",
		});

		const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

			// Header
			container.addChild(new Text(theme.fg("accent", theme.bold("Select Preset"))));

			// SelectList with themed styling
			const selectList = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});

			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);

			container.addChild(selectList);

			// Footer hint
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel")));

			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		});

		if (!result) return;

		if (result === "(none)") {
			// Clear preset and restore original state
			activePresetName = undefined;
			activePreset = undefined;
			if (originalState) {
				if (originalState.model) {
					await pi.setModel(originalState.model);
				}
				pi.setThinkingLevel(originalState.thinkingLevel);
			}
			restoreDefaultTools();
			ctx.ui.notify("Preset cleared, defaults restored", "info");
			updateStatus(ctx);
			persistState(ctx);
			return;
		}

		const preset = presets[result];
		if (preset) {
			await applyPreset(result, preset, ctx);
			ctx.ui.notify(`Preset "${result}" activated`, "info");
			updateStatus(ctx);
		}
	}

	/**
	 * The mode chip is owned by readonly-guard.ts, which shows the mode and the lock state
	 * together. This call site stays so a stale "preset:" chip from an older load is cleared.
	 */
	function updateStatus(ctx: ExtensionContext) {
		ctx.ui.setStatus("preset", undefined);
	}

	/** Restore the tool set used before any preset: the snapshot, or every registered tool. */
	function restoreDefaultTools(): void {
		pi.setActiveTools(originalState?.tools ?? pi.getAllTools().map((tool) => tool.name));
	}

	/**
	 * Record the active mode on the session branch: `/resume` restores it and the footer chip
	 * reads it. Compared against the branch itself rather than process memory, so it stays
	 * correct across `/reload` and session switches, and never appends a duplicate.
	 */
	function persistState(ctx: ExtensionContext): void {
		const name = activePresetName ?? null;
		const last = lastModeRecord(ctx);
		// Unreadable branch (invalidated context): write nothing rather than one entry per turn.
		if (last === null) return;
		if (last && last.name === name) return;
		pi.appendEntry("preset-state", { name });
	}

	function getPresetOrder(): string[] {
		return Object.keys(presets).sort();
	}

	async function cyclePreset(ctx: ExtensionContext): Promise<void> {
		const presetNames = getPresetOrder();
		if (presetNames.length === 0) {
			ctx.ui.notify(
				`No presets defined. Add presets to ${join(getAgentDir(), "presets.json")} or ${join(ctx.cwd, CONFIG_DIR_NAME, "presets.json")}`,
				"warning",
			);
			return;
		}

		const cycleList = ["(none)", ...presetNames];
		const currentName = activePresetName ?? "(none)";
		const currentIndex = cycleList.indexOf(currentName);
		const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % cycleList.length;
		const nextName = cycleList[nextIndex];

		if (nextName === "(none)") {
			activePresetName = undefined;
			activePreset = undefined;
			if (originalState) {
				if (originalState.model) {
					await pi.setModel(originalState.model);
				}
				pi.setThinkingLevel(originalState.thinkingLevel);
			}
			restoreDefaultTools();
			ctx.ui.notify("Preset cleared, defaults restored", "info");
			updateStatus(ctx);
			persistState(ctx);
			return;
		}

		const preset = presets[nextName];
		if (!preset) return;

		await applyPreset(nextName, preset, ctx);
		ctx.ui.notify(`Preset "${nextName}" activated`, "info");
		updateStatus(ctx);
	}

	pi.registerShortcut(Key.ctrlShift("u"), {
		description: "Cycle presets",
		handler: async (ctx) => {
			await cyclePreset(ctx);
		},
	});

	// Register /preset command
	pi.registerCommand("preset", {
		description: "Switch preset configuration",
		handler: async (args, ctx) => {
			// If preset name provided, apply directly
			if (args?.trim()) {
				const name = args.trim();
				const preset = presets[name];

				if (!preset) {
					const available = Object.keys(presets).join(", ") || "(none defined)";
					ctx.ui.notify(`Unknown preset "${name}". Available: ${available}`, "error");
					return;
				}

				await applyPreset(name, preset, ctx);
				ctx.ui.notify(`Preset "${name}" activated`, "info");
				updateStatus(ctx);
				return;
			}

			// Otherwise show selector
			await showPresetSelector(ctx);
		},
	});

	// Inject the mode's instructions, plus the read-only brief while the shell is restricted.
	// One handler on purpose: before_agent_start results do not compose across handlers, so a
	// second handler returning systemPrompt would silently drop this one.
	pi.on("before_agent_start", async (event) => {
		const parts: string[] = [];
		if (activePreset?.instructions) parts.push(activePreset.instructions);
		if (!pi.getActiveTools().some((name) => WRITE_TOOLS.has(name))) parts.push(READ_ONLY_BRIEF);
		if (parts.length === 0) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${parts.join("\n\n")}` };
	});

	// Initialize on session start
	pi.on("session_start", async (event, ctx) => {
		// Load presets from config files
		presets = loadPresets(ctx.cwd);

		const presetFlag = pi.getFlag("preset");
		const available = Object.keys(presets).join(", ") || "(none defined)";
		let targetName: string | undefined;
		// A session whose preset was deliberately cleared stays cleared. Everything else that
		// resolves to nothing falls back to the startup default instead of to full access.
		let cleared = false;

		if (typeof presetFlag === "string" && presetFlag) {
			// An explicit --preset wins over whatever the session recorded.
			if (presets[presetFlag]) {
				targetName = presetFlag;
			} else {
				ctx.ui.notify(`Unknown preset "${presetFlag}". Available: ${available}`, "warning");
			}
		} else {
			const recorded = lastModeRecord(ctx);
			if (recorded?.name === null) {
				// Deliberately cleared, so leave it cleared.
				cleared = true;
			} else if (recorded && presets[recorded.name]) {
				// Resumed session: restore the mode it was left in.
				targetName = recorded.name;
			} else if (recorded) {
				ctx.ui.notify(`Preset "${recorded.name}" no longer exists. Available: ${available}`, "warning");
			}
			// No usable record (fresh session, or a branch we could not read) falls through to
			// the startup default below.
		}

		if (!targetName && !cleared) {
			targetName = presets[STARTUP_PRESET] ? STARTUP_PRESET : undefined;
		}

		if (targetName && presets[targetName]) {
			// Re-apply for real, tools included: on resume the process starts from
			// `defaultTools`, so restoring only the instructions would bring a chat or plan
			// session back with edit/write enabled.
			await applyPreset(targetName, presets[targetName], ctx, event.reason !== "reload");
			ctx.ui.notify(`Preset "${targetName}" activated`, "info");
		}

		// Record the mode right away, fresh sessions included, so the footer chip and a later
		// /resume both see it without waiting for the first turn.
		if (targetName || cleared) persistState(ctx);
		updateStatus(ctx);
	});

	// Persist the mode so resuming this session restores it
	pi.on("turn_start", async (_event, ctx) => {
		persistState(ctx);
	});
}
