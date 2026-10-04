# WeekToken

English · [简体中文](./README.zh-CN.md)

**Will you run out before the reset?** WeekToken puts what you have **used** of Claude Code's rate limits next to how much of the window has **passed**, and tells you whether you are ahead of the clock or behind it. It covers the 5-hour window, the 7-day window and **per-model weekly quotas such as Fable**.

![The WeekToken band above the prompt](./screenshots/band-dark.png)

- **Pace, not just a percentage.** 64% used means little on its own; 64% used with 71% of the week gone means you are fine. The band and the pane show both, colored by pace.
- **Per-model quotas.** Fable and other models with a weekly limit of their own get their own pace, next to the 5-hour and 7-day windows.
- **A forecast and a history.** "At this rate, runs out ~Sat 20:12", plus a burn-up chart that lays past windows under this one, so you can see how this week compares.
- **Nothing to set up.** No settings; English or Chinese, following Claude Code's language; desktop app and terminal.

| `/weektoken` pace | Burn-up history |
| --- | --- |
| ![Pace rings, forecast and readings](./screenshots/pane-pace.png) | ![Burn-up chart with past windows](./screenshots/pane-burnup.png) |

In the terminal, the band sits above the prompt and `/weektoken` docks beside the conversation:

![WeekToken in the terminal: the pane docked on the right, the band above the prompt](./screenshots/terminal-pane.png)

## Features

**A band above the prompt:** `❮ 7-day ❯ · 64% used · 71% elapsed`, a progress bar that stretches with the band, plus **Details** and **Hide** (in the desktop app, Hide is the close button at the band's right end).
- The bar stays in the quota's own color, like Apple's Activity rings. Using slower than time: light stripes of that color after the bar are the margin you have left. Using faster: the part ahead of the clock turns a deeper shade of the same color, striped. Only when a quota is used up does a warm tone appear, harmonized toward the quota's color.
- Shows the tightest quota by default. The arrows around the name switch to another quota, and the choice is remembered across sessions.
- On a narrow band the line never wraps: the desktop app truncates from the end; in the terminal the line is laid out by its real width, dropping the elapsed figure first and then the bar.
- When a quota's window has passed its reset time and no reading of the new window has arrived yet, the band says **reset** instead of showing the old window's usage.
- **Hide** asks first and tells you how to get the band back: `/weektoken show`, or **⊕ Show band** at the bottom of the pane.

**The `/weektoken` pane:**
- Pace rings: the outer ring is usage, the inner ring is time, and the center is the burn rate R (1.0 means you run out exactly at reset). The buttons on either side switch between the 5-hour window, the 7-day window and per-model quotas such as Fable.
- Narration and forecast, e.g. "Usage 12h 28m behind the clock", "At this rate, runs out ~Sat 20:12"; an extra line when you have been speeding up or slowing down lately.
- Three readings: used, elapsed, time to reset.
- Burn-up chart: this window, the last month or everything, with older windows a step away; an even-pace line, the projection at the recent rate, when you would run out, and stretches without data, with the legend drawn inside the chart. When a range holds more than 60 windows, 60 evenly spaced ones are drawn and the caption says so.
- Footer: "Last used Fable 3h ago" when a quota has not moved for half an hour, **⊖ Hide band / ⊕ Show band** and **↻ Refresh**. While refreshing, the button reads **Refreshing…**; a notice appears only if `/usage` could not run.

**Colors follow pace, not the raw percentage:** the over-pace thresholds are Claude Code's own rate-limit warning calibration (`five_hour`: 0.9/0.72; `seven_day`: 0.25/0.15, 0.5/0.35, 0.75/0.6) and tighten as the window goes on.

## Where the data comes from

| Source | Content |
|---|---|
| The session's own rate limits | The 5-hour and 7-day windows, updated after every reply |
| `cachedUsageUtilization` in `~/.claude.json` | Claude Code's own usage cache, including per-model quotas (Fable and others) |
| Local `claude -p --no-session-persistence /usage` (only when you press **↻ Refresh**) | Fresh per-model quotas; also the 5-hour and 7-day windows when there is no local reading from the last 10 minutes (a new session before its first reply) |
| `~/.weektoken/samples.jsonl` (optional) | History from the WeekToken macOS app, imported read-only |

Samples are kept in the mod's own cross-session store, up to 8000; the oldest go first. Sessions open at the same time merge their samples and keep one copy of each reading. Without history to import from the WeekToken macOS app, history starts when you install the mod, since the API only reports current values.

A quota you are not using does not change, so old data still gives a valid pace.

## Commands

| Command | Does |
|---|---|
| `/weektoken` | Opens the pace pane |
| `/weektoken hide` | Hides the band (kept across sessions) |
| `/weektoken show` | Shows it again |

## Configuration

Nothing to configure. Two environment variables override the defaults; set them in your shell profile (e.g. `~/.zshrc`) and start a new session:

| Variable | Effect |
|---|---|
| `WEEKTOKEN_LANG` | `zh` or `en` forces the interface language. By default it follows Claude Code's language setting, then the system language |
| `WEEKTOKEN_HISTORY` | Path of the WeekToken macOS app's history file; an empty string turns the import off |
| `CLAUDE_MODS_DISABLE` | `all`, or a comma list containing `weektoken`, turns the mod off entirely |

## Privacy and permissions

Mods run with the same access as Claude Code itself and are not sandboxed. This is everything WeekToken does besides drawing its own band and pane.

### What it sends, and where

WeekToken itself makes no network calls, and nothing it reads is sent anywhere. The only request that leaves your machine is made by Claude Code, not by the mod: when you press **↻ Refresh**, the mod runs Claude Code's own `/usage` command (below), and Claude Code looks up your usage at Anthropic's usage endpoint (`/api/oauth/usage`) with the login it already has. No model is called and no quota is used; checked with `claude --debug-file`.

### Programs it runs, and why

Every command is fixed text, and none goes through a shell.

| Command | When | Why |
| --- | --- | --- |
| `claude -p --no-session-persistence /usage` | Only when you press **↻ Refresh** | The only fresh source for per-model quotas such as Fable. The mod looks for `claude` on your `PATH`, then in `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin` and `/usr/local/bin`. It saves no session. |
| `defaults read -g AppleLanguages` | At session start, and when you change Claude Code's language | Reads the macOS language when Claude Code's own language setting is not set (macOS only). |
| `tail -n 8000 ~/.weektoken/samples.jsonl` | At session start and every 10 minutes, only if the file exists | Imports history from the WeekToken macOS app. |
| `perl -0777 -ne '<fixed pattern>' ~/.claude.json` | Only when `~/.claude.json` is over 4 MiB and can't be read directly | Extracts just the `cachedUsageUtilization` entry. |

### What it reads on your machine

- `~/.claude.json`, Claude Code's own file. Only its `cachedUsageUtilization` entry is used: Claude Code's usage cache, which includes per-model quotas. The file also holds account details; those are not used or kept. It is read at session start, every 5 minutes when the file has changed, and on Refresh.
- `~/.weektoken/samples.jsonl`, or the file named by `WEEKTOKEN_HISTORY`, if it exists.
- Environment variables: `HOME` and `PATH` (to find the files and `claude` above), `LANG`, `LC_ALL` and `LC_MESSAGES` (the language), `WEEKTOKEN_LANG`, `WEEKTOKEN_HISTORY` and `CLAUDE_MODS_DISABLE`. It reads no credentials.
- From Claude Code: the session's rate-limit figures, the time and model of each reply, and the `language` setting.

### What it stores

In the mod's own store on your machine: samples (up to 8000) and their version stamp, when each model was last used, whether the band is shown and which quota it shows, the quota selected in the pane, the modification time of the imported history file, and whether the welcome notice was shown. The interface language is detected each session, not stored.

### Hooks

| Hook | What it does |
| --- | --- |
| `session.start` | Registers `/weektoken`, loads the stored samples, reads the sources above and starts the 1-, 5- and 10-minute timers |
| `session.measure` | Records the session's 5-hour and 7-day figures when they change |
| `turn.complete` | Records the time and model of each reply, to tell when a quota was last used |
| `command.run`, `/weektoken` only | Answers its own command: opens the pane, or shows or hides the band |
| `ui.render`, `AbovePrompt` | Draws the band, then whatever other plugins or Claude Code draw there, below it |
| `ui.render`, the `weektoken` pane only | Draws the `/weektoken` pane |
| `ui.press` | Notes presses on its own pane and passes every press on unchanged |
| `ui.focus` | Passes the event on unchanged. On its own pane in the desktop app, when a click only moved the focus to a button (the first click on an unfocused pane), it runs that button's action |
| `config.set`, `language` only | Passes the change on unchanged, then detects the interface language again |

It changes no settings or permissions, and it leaves other plugins' events as they are.

## Requirements

- Claude Code 2.1.287 or newer, where mods are on by default. On an earlier build with mods in early access, add `"env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" }` to `~/.claude/settings.json` first
- A Claude subscription; sessions billed by API key have no rate limits

## Development

```bash
claude plugin validate .
claude plugin test
```

## Author

mj0111 · [@mj0011sec](https://x.com/mj0011sec)
