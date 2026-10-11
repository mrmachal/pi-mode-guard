/**
 * Load test for pi-mode-guard.
 *
 * Loads the real extension files through pi's own loader (jiti plus its module aliases) with a
 * stubbed ExtensionAPI, then drives the handlers. No pi process and no model calls.
 *
 *   node test/load.test.mjs
 *
 * On WSL/Linux, point PI_CODING_AGENT_DIR at the Windows agent directory, for example
 * PI_CODING_AGENT_DIR=/mnt/c/Users/You/.pi/agent node test/load.test.mjs.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXT = join(dirname(fileURLToPath(import.meta.url)), "..", "extensions");
const AGENT_DIR_HOME = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

// Resolve the installed pi release, so the test follows the version automatically.
const versionFile = join(AGENT_DIR_HOME, "install", "current-version");
const piRoot = join(
	AGENT_DIR_HOME,
	"install",
	"releases",
	readFileSync(versionFile, "utf-8").trim(),
	"node_modules",
	"@earendil-works",
	"pi-coding-agent",
);
const { createJiti } = createRequire(join(piRoot, "package.json"))("jiti");

// A throwaway agent dir with NO presets.json: the package must stand on its own.
const AGENT = join(tmpdir(), "pi-mode-guard-agent");
const CWD = join(tmpdir(), "pi-mode-guard-project");
const ALL_TOOLS = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls", "web_search"];
const LOCKED_TOOLS = ALL_TOOLS.filter((t) => t !== "edit" && t !== "write");

rmSync(AGENT, { recursive: true, force: true });
rmSync(CWD, { recursive: true, force: true });
mkdirSync(AGENT, { recursive: true });
mkdirSync(CWD, { recursive: true });

const jiti = createJiti(join(piRoot, "package.json"), {
	interopDefault: true,
	moduleCache: false,
	virtualModules: {
		"@earendil-works/pi-coding-agent": {
			CONFIG_DIR_NAME: ".pi",
			getAgentDir: () => AGENT,
			DynamicBorder: class DynamicBorder {},
		},
		"@earendil-works/pi-tui": {
			Container: class Container {
				addChild() {}
				render() {
					return [];
				}
			},
			Key: new Proxy({}, { get: (_t, prop) => (...args) => `${String(prop)}:${args.join("+")}` }),
			SelectList: class SelectList {},
			Text: class Text {},
		},
		"@earendil-works/pi-ai": {},
	},
});

let failures = 0;
function check(label, actual, expected) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "  ok  " : "  FAIL"} ${label}${ok ? "" : `\n         got  ${JSON.stringify(actual)}\n         want ${JSON.stringify(expected)}`}`,
	);
}
function checkContains(label, haystack, needle) {
	const ok = typeof haystack === "string" && haystack.includes(needle);
	if (!ok) failures++;
	console.log(
		`${ok ? "  ok  " : "  FAIL"} ${label}${
			ok ? "" : `\n         ${JSON.stringify(String(haystack).slice(0, 160))} missing ${JSON.stringify(needle)}`
		}`,
	);
}

const rec = (name) => ({ type: "custom", customType: "preset-state", data: { name } });
const chipText = (mode, locked) =>
	locked
		? `<b><error>🔒 ${mode ? `${mode} · read-only` : "READ-ONLY"}</error></b>`
		: `<success>🔓 ${mode ? `${mode} · full access` : "full access"}</success>`;

function makeSession({ branch = [], presetFlag, tools } = {}) {
	const state = {
		active: [...(tools ?? ALL_TOOLS)],
		branch: [...branch],
		appended: [],
		flags: { preset: presetFlag },
		status: {},
		notifications: [],
		failBranch: false,
	};
	const handlers = {};
	const commands = {};
	const shortcuts = {};
	const pi = {
		on(ev, h) {
			(handlers[ev] ||= []).push(h);
			return () => {};
		},
		registerFlag() {},
		registerShortcut(key, opts) {
			shortcuts[key] = opts;
		},
		registerCommand(name, opts) {
			commands[name] = opts;
		},
		registerTool() {},
		getFlag: (name) => state.flags[name],
		getAllTools: () => ALL_TOOLS.map((name) => ({ name })),
		getActiveTools: () => [...state.active],
		setActiveTools: (names) => {
			state.active = [...names];
		},
		getThinkingLevel: () => "medium",
		setThinkingLevel() {},
		setModel: async () => true,
		appendEntry: (type, data) => {
			state.appended.push([type, data]);
			state.branch.push({ type: "custom", customType: type, data });
		},
		sendMessage() {},
		events: { on() {}, emit() {} },
	};
	const ctx = {
		cwd: CWD,
		mode: "tui",
		hasUI: true,
		model: undefined,
		modelRegistry: { find: () => undefined },
		sessionManager: {
			getBranch: () => {
				if (state.failBranch) throw new Error("stale context");
				return state.branch;
			},
			getEntries: () => state.branch,
		},
		ui: {
			theme: { fg: (color, text) => `<${color}>${text}</${color}>`, bold: (text) => `<b>${text}</b>`, strikethrough: (t) => t },
			notify: (message, type) => state.notifications.push([type, message]),
			setStatus: (key, text) => {
				if (text === undefined) delete state.status[key];
				else state.status[key] = text;
			},
			setWidget() {},
			select: async () => undefined,
			custom: async () => null,
		},
	};
	const fire = async (event, payload = {}) => {
		for (const handler of handlers[event] ?? []) await handler(payload, ctx);
	};
	return {
		pi,
		state,
		ctx,
		fire,
		commands,
		repaint: () => fire("input", { text: "" }),
		cycle: () => shortcuts["ctrlShift:u"].handler(ctx),
		chip: () => state.status["pi-mode-guard"],
		last: () => state.branch.filter((e) => e.customType === "preset-state").map((e) => e.data).at(-1),
		prompt: async () => (await handlers.before_agent_start[0]({ systemPrompt: "BASE" }, ctx))?.systemPrompt,
		// Surfaces a block result; fire() would swallow it and make the guard checks vacuous.
		toolCall: async (event) => {
			for (const handler of handlers.tool_call ?? []) {
				const result = await handler(event, ctx);
				if (result) return result;
			}
			return undefined;
		},
	};
}

const modesModule = await jiti.import(join(EXT, "modes.ts"));
const guardModule = await jiti.import(join(EXT, "readonly-guard.ts"));

function start(opts = {}) {
	const h = makeSession(opts);
	modesModule.default(h.pi);
	guardModule.default(h.pi);
	return h;
}

console.log("1. built-in modes: a machine with no presets.json at all");
{
	const h = start();
	await h.fire("session_start", { reason: "startup" });
	await h.repaint();
	check("starts in chat, tools locked", h.state.active.includes("edit"), false);
	check("record written on session_start", h.last(), { name: "chat" });
	check("chip", h.chip(), chipText("chat", true));
	const prompt = await h.prompt();
	checkContains("prompt has the mode instructions", prompt, "You are in CHAT MODE");
	checkContains("prompt has the read-only brief", prompt, "Read-only mode:");

	await h.commands.preset.handler("act", h.ctx);
	await h.repaint();
	check("act unlocks", h.state.active.includes("edit"), true);
	check("act is recorded immediately", h.last(), { name: "act" });
	check("chip", h.chip(), chipText("act", false));
	const actPrompt = await h.prompt();
	checkContains("prompt has ACT MODE", actPrompt, "You are in ACT MODE");
	check("no read-only brief while writable", /Read-only mode:/.test(actPrompt), false);

	await h.commands.preset.handler("plan", h.ctx);
	await h.repaint();
	check("plan locks again", h.state.active.includes("edit"), false);
	check("chip", h.chip(), chipText("plan", true));
	checkContains("prompt has PLAN MODE", await h.prompt(), "You are in PLAN MODE");
}

console.log("2. presets.json overrides merge per mode");
{
	writeFileSync(
		join(AGENT, "presets.json"),
		JSON.stringify({
			chat: { instructions: "OVERRIDDEN CHAT" },
			review: { tools: ["*"], excludeTools: ["edit", "write"], instructions: "REVIEW MODE" },
		}),
	);
	const h = start();
	await h.fire("session_start", { reason: "startup" });
	checkContains("override wins for instructions", await h.prompt(), "OVERRIDDEN CHAT");
	check("built-in tools survive a partial override", h.state.active.includes("edit"), false);
	await h.commands.preset.handler("review", h.ctx);
	await h.repaint();
	check("a new mode appears", h.chip(), chipText("review", true));
	check("the new mode is locked", h.state.active.includes("edit"), false);
}

console.log("3. project presets.json beats the agent directory");
{
	mkdirSync(join(CWD, ".pi"), { recursive: true });
	writeFileSync(join(CWD, ".pi", "presets.json"), JSON.stringify({ chat: { instructions: "PROJECT CHAT" } }));
	const h = start();
	await h.fire("session_start", { reason: "startup" });
	checkContains("project override wins", await h.prompt(), "PROJECT CHAT");
	rmSync(join(CWD, ".pi"), { recursive: true, force: true });
}

console.log("4. the guard enforces the tool set");
{
	const h = start();
	await h.fire("session_start", { reason: "startup" });
	const blocked = await h.toolCall({ toolName: "bash", input: { command: "rm -rf /" } });
	check("blocks a write while locked", blocked?.block, true);
	check("with an actionable reason", /\/preset act/.test(blocked?.reason ?? ""), true);
	check("allows a read-only command", await h.toolCall({ toolName: "bash", input: { command: "git status" } }), undefined);
	await h.commands.preset.handler("act", h.ctx);
	check("act runs anything", await h.toolCall({ toolName: "bash", input: { command: "rm -rf /" } }), undefined);
}

console.log("5. drift is stated, never hidden");
{
	const h = start({ branch: [rec("act")] });
	await h.fire("session_start", { reason: "resume" });
	check("act restored", h.chip(), chipText("act", false));
	h.state.active = [...LOCKED_TOOLS]; // as if /plan locked the shell
	await h.repaint();
	check("the mode name survives the drift", h.chip(), chipText("act", true));
}

console.log("6. /reload, and clearing a preset");
{
	// Drop the override added in section 2, so the cycle is exactly chat -> plan -> (none).
	rmSync(join(AGENT, "presets.json"), { force: true });
	const h = start({ branch: [rec("chat")], tools: LOCKED_TOOLS });
	await h.fire("session_start", { reason: "reload" });
	await h.repaint();
	check("chat restored on reload", h.chip(), chipText("chat", true));
	await h.cycle(); // chat -> plan
	await h.cycle(); // plan -> (none)
	check("clear restores every registered tool", h.state.active.length, ALL_TOOLS.length);
	check("cleared state recorded", h.last(), { name: null });
	await h.repaint();
	check("chip", h.chip(), chipText(undefined, false));
}

console.log("7. resilience");
{
	const h = start({ branch: [rec("chat")] });
	await h.fire("session_start", { reason: "resume" });
	const before = h.state.appended.length;
	h.state.failBranch = true;
	await h.fire("turn_start", {});
	check("unreadable branch writes nothing", h.state.appended.length, before);
	check("chip degrades to the generic label", h.chip(), chipText(undefined, true));
	await h.fire("session_shutdown", {});
}
{
	const h = start({ presetFlag: "nope" });
	await h.fire("session_start", { reason: "startup" });
	check("unknown --preset falls back to chat", h.last(), { name: "chat" });
	await h.commands.preset.handler("", h.ctx);
	check("the picker path does not throw", true, true);
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
