# pi-mode-guard

chat / plan / act modes for [Pi](https://pi.dev): a read-only shell guard, a footer chip, and
per-mode system-prompt instructions.

A mode is nothing more than an active tool set plus a bit of prompt:

| Mode  | Tools                      | Shell                       | Prompt                             |
| ----- | -------------------------- | --------------------------- | ---------------------------------- |
| chat  | everything except `edit`/`write` | allowlisted read-only commands | answer, do not change anything |
| plan  | everything except `edit`/`write` | allowlisted read-only commands | produce a numbered `Plan:`         |
| act   | everything                 | unrestricted                | make the change, then verify       |

## Install

```sh
pi install git:github.com/mrmachal/pi-mode-guard@v1
```

> An unrelated `pi-modes` package already exists on npm. This project is `pi-mode-guard`: install
> it from this repository, and never as `npm:pi-modes`, which would fetch someone else's code.

Update every device with `pi update --extensions`.

## Migrate from a hand-made setup

Remove the old copies first: they register the same `/preset` command and `--preset` flag.

```sh
rm ~/.pi/agent/extensions/preset.ts
rm ~/.pi/agent/extensions/readonly-guard.ts
rm ~/.pi/agent/APPEND_SYSTEM.md     # the read-only rule now ships inside modes.ts
# optional: plan-mode is not part of this package
rm -rf ~/.pi/agent/extensions/plan-mode
```

`~/.pi/agent/presets.json` becomes optional: the package ships chat/plan/act, and an entry in
`presets.json` merges over the matching built-in mode (per mode, so you can override just the
instructions).

## Use

| Action             | How                                                                |
| ------------------ | ------------------------------------------------------------------ |
| Switch             | `/preset chat` · `/preset plan` · `/preset act`, or `/preset` for a picker |
| Cycle              | `Ctrl+Shift+U`                                                     |
| Start in a mode    | `pi --preset plan`                                                 |
| See the current state | footer chip: `🔒 chat · read-only` / `🔓 act · full access`     |

A new session starts in `chat` (read-only). Resuming a session restores the mode recorded on
that session's branch. While the shell is restricted, `bash`/`powershell` only run allowlisted
read-only commands, and the model is told to hand back a patch instead of editing.

Session state is recorded as a `preset-state` custom entry, so sessions created by the original
`preset.ts` example keep working.

## Add a mode

Append to `~/.pi/agent/presets.json` (or `<project>/.pi/presets.json`):

```json
{
  "review": {
    "tools": ["*"],
    "excludeTools": ["edit", "write"],
    "instructions": "You are in REVIEW MODE. Critique only; never change a file."
  }
}
```

`"tools": ["*"]` means every registered tool, so extension, package, and MCP tools stay
available. `excludeTools` removes tools from that selection. A mode may also set
`provider`/`model` and `thinkingLevel`.

Clear the preset with `/preset` → `(none)` to get full access back.

## How it works

- `extensions/modes.ts` owns the mode definitions, the `/preset` command, the `--preset` flag,
  `Ctrl+Shift+U`, the session record, and the system-prompt injection.
- `extensions/readonly-guard.ts` owns enforcement: while `edit`/`write` are inactive, shell
  commands must match a read-only allowlist, and the footer chip reports the state.
- The two share only the `preset-state` record type, so the guard also works when a mode is
  never applied (for example `/plan` from the plan-mode example, or a manual tool change).

## Development

```sh
npm test
```

loads both extensions through pi's own loader (jiti plus its module aliases) with a stubbed
`ExtensionAPI`, then drives every handler: mode switching, the session record, prompt
injection, the shell allowlist, and the footer chip. No pi process, no model calls. On WSL,
point it at the Windows agent directory:

```sh
PI_CODING_AGENT_DIR=/mnt/c/You/.pi/agent npm test
```

To try the package without installing it:

```sh
pi -ne -e ~/pi-mode-guard/extensions/modes.ts -e ~/pi-mode-guard/extensions/readonly-guard.ts --print "hi"
```

`-ne` isolates the run from installed extensions. Without it, a leftover copy in
`~/.pi/agent/extensions/` makes pi stop with `Flag "--preset" conflicts with …`, which is the
migration check working.
