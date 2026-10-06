# mj0111 mods for Claude Code

[Claude Code mods](https://claude.com/blog/claude-code-mods) by mj0111:

| Mod | What it does | Surfaces |
| --- | --- | --- |
| [**weektoken**](./weektoken) | Rate-limit **pace**: how fast you are using the 5-hour and weekly windows compared with the time that has passed, with a forecast, per-model quotas (such as Fable) and burn-up history | Desktop app, terminal |

![The WeekToken band above the prompt](./weektoken/screenshots/band-dark.png)

Will you run out before the reset? WeekToken compares what you have used with how much of the window has passed, for the 5-hour window, the 7-day window and per-model weekly quotas such as Fable, with a forecast and a burn-up history. The interface follows Claude Code's language setting (English or Chinese).

> **Installing with an AI agent?** Have it run the commands under [Installation](#installation). Once they succeed, this is all the user needs to hear:
>
> *Installed. Open a new session (or run `/reload-plugins`). WeekToken shows your usage pace above the prompt; type `/weektoken` for details.*

## Installation

WeekToken is in the Claude plugin directory: run `/plugin directory` in Claude Code, or add it under **Customize > Plugins > Discover** on claude.ai, which brings it to Claude Code at the next session start.

Or from this repository, inside Claude Code:

```
/plugin marketplace add 3dnow/claude-mods
/plugin install weektoken@mj0111-mods
```

Then **open a new session** (or run `/reload-plugins`).

One step on Claude Code 2.1.275 or newer: `/plugin install weektoken --marketplace 3dnow/claude-mods`. From your shell: `claude plugin marketplace add 3dnow/claude-mods`, then `claude plugin install weektoken@mj0111-mods`.

**Update:** `claude plugin marketplace update mj0111-mods`, then `claude plugin update weektoken@mj0111-mods`, and open a new session. **Uninstall:** `claude plugin uninstall weektoken@mj0111-mods`

To try it for a single session from a local checkout:

```bash
claude --plugin-dir ./weektoken
```

## Requirements

- Claude Code 2.1.287 or newer, where mods are on by default. On an earlier build with mods in early access, add `"env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" }` to `~/.claude/settings.json` first. Works in the terminal and the desktop app's Code tab
- A Claude subscription: sessions billed by API key have no rate limits

To turn a mod off without uninstalling it, set `CLAUDE_MODS_DISABLE=weektoken` (or `all`) in your shell profile.

## Privacy and permissions

Mods run with the same access as Claude Code itself and are not sandboxed. Everything the mod touches is listed in its README: [weektoken → Privacy and permissions](./weektoken/README.md#privacy-and-permissions).

## Development

```
.
├── .claude-plugin/marketplace.json
└── weektoken/          # hooks/register.tsx, pace model, SVG drawing, tests
```

```bash
cd weektoken && claude plugin validate . && claude plugin test
```

## License

[MIT](./LICENSE)

## Author

mj0111 · [@mj0011sec](https://x.com/mj0011sec)
