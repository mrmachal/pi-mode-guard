/**
 * Read-only Guard
 *
 * Keeps the shell read-only whenever the write tools are NOT active, so a "mode"
 * is fully described by its active tool set (see ~/.pi/agent/presets.json):
 *
 *   chat / plan  -> no `edit`      -> bash/powershell limited to allowlisted read-only commands
 *   act          -> `edit` active  -> full shell access
 *
 * This closes the gap that plain tool selection leaves open: dropping `edit` and
 * `write` alone does not stop `bash` from running `rm`, `>`, `npm install`, etc.
 *
 * It also paints a footer chip: a bold red "🔒 chat · read-only" while the shell is restricted
 * and a green "🔓 act · full access" when it is not. The lock state is stated in words rather
 * than left to the emoji, and the mode name is context that cannot contradict it, so the chip
 * stays correct even when `/plan` or a manual tool change moves the tool set. With no recorded
 * mode it shows the generic "🔒 READ-ONLY" / "🔓 full access".
 *
 * Command patterns mirror examples/extensions/plan-mode/utils.ts, so /plan mode
 * and the presets agree on what counts as read-only.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "pi-mode-guard";
const WRITE_TOOLS = new Set(["edit", "write"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);

/** Custom session entry the preset extension writes to record the active mode. */
const MODE_ENTRY_TYPE = "preset-state";

/**
 * The mode name recorded on the active branch, or undefined when there is none. Never throws:
 * a failed lookup only costs us the mode name, and a throw here would otherwise turn into a
 * blocked tool call downstream.
 */
function recordedMode(ctx: ExtensionContext): string | undefined {
	try {
		const entries = ctx.sessionManager.getBranch();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as { type?: string; customType?: string; data?: { name?: string | null } };
			if (entry.type !== "custom" || entry.customType !== MODE_ENTRY_TYPE) continue;
			return entry.data?.name ?? undefined;
		}
	} catch {
		// Fall through: the chip degrades to the generic lock label.
	}
	return undefined;
}

// Commands that change files, git state, packages, or the machine
const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone|clean)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

// Read-only commands allowed while the write tools are inactive
const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*cut\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|rev-parse|describe|blame|shortlog|config\s+--get|ls-files|ls-tree)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit|why)/i,
	/^\s*pnpm\s+(list|ls|why|outdated)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+(--version|-v)\b/i,
	/^\s*python3?\s+--version/i,
	/^\s*go\s+(version|env|list|vet)\b/i,
	/^\s*cargo\s+(tree|metadata|--version)\b/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

function isReadOnlyCommand(command: string): boolean {
	if (!command.trim()) return false;
	if (DESTRUCTIVE_PATTERNS.some((p) => p.test(command))) return false;
	return SAFE_PATTERNS.some((p) => p.test(command));
}

export default function readonlyGuard(pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let painted: string | undefined;

	function writeToolsActive(): boolean {
		return pi.getActiveTools().some((name) => WRITE_TOOLS.has(name));
	}

	/** Paint the footer chip, skipping redundant writes. */
	function paint(ctx: ExtensionContext): void {
		const theme = ctx.ui.theme;
		const locked = !writeToolsActive();
		// The lock state is spelled out because it is the safety signal; the mode name qualifies
		// it. Two independent facts, so neither can misrepresent the other.
		const mode = recordedMode(ctx);
		const text = locked
			? theme.bold(theme.fg("error", mode ? `🔒 ${mode} · read-only` : "🔒 READ-ONLY"))
			: theme.fg("success", mode ? `🔓 ${mode} · full access` : "🔓 full access");
		if (text === painted) return;
		painted = text;
		ctx.ui.setStatus(STATUS_KEY, text);
	}

	function stopTimer(): void {
		if (timer !== undefined) {
			clearInterval(timer);
			timer = undefined;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		painted = undefined;
		paint(ctx);
		stopTimer();
		// Other extensions (presets, /plan) change the active tool set without an
		// event of their own, so poll cheaply. unref() keeps it from holding the
		// process open; the timer is dropped on shutdown or on any stale-ctx error.
		timer = setInterval(() => {
			try {
				paint(ctx);
			} catch {
				stopTimer();
			}
		}, 1000);
		timer.unref?.();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopTimer();
		painted = undefined;
		try {
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			// Context may already be invalidated during shutdown.
		}
	});

	// Refresh immediately around the moments that follow a mode switch.
	pi.on("input", async (_event, ctx) => {
		if (ctx.hasUI) paint(ctx);
	});
	pi.on("turn_start", async (_event, ctx) => {
		if (ctx.hasUI) paint(ctx);
	});
	pi.on("agent_settled", async (_event, ctx) => {
		if (ctx.hasUI) paint(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (ctx.hasUI) paint(ctx);
		if (!SHELL_TOOLS.has(event.toolName)) return;
		// ACT mode: edit/write are declared, so the shell is unrestricted.
		if (writeToolsActive()) return;

		const command = String((event.input as { command?: unknown }).command ?? "");
		if (isReadOnlyCommand(command)) return;

		return {
			block: true,
			reason:
				`Read-only mode: only allowlisted read-only commands may run while \`edit\`/\`write\` are disabled.\n` +
				`Blocked command: ${command || "(empty)"}\n` +
				`Keep gathering information with read-only commands, then answer. ` +
				`If the user really wants changes, tell them to switch to ACT mode with /preset act (or /plan to leave plan mode).`,
		};
	});
}
