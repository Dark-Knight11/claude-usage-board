# claude-usage-board

A local dashboard and terminal report for your **Claude Code** token usage. It reads the transcripts Claude Code already saves on your machine. It has no dependencies, needs no account, and uploads nothing.

```bash
npx claude-usage-board
```

The command opens a dashboard at `http://localhost:4321`.

## What it shows

- **Totals for any time range:** 1h, 5h, 24h, 7d, 30d, 90d, all time, or a custom "last N hours/days/weeks/months". Each number is compared with the previous period of the same length.
- **Token types:** input, output (including thinking), cache writes and cache reads, plus the cache hit rate.
- **By model and by project.** Each session counts under the project it was started in, subagents included.
- **Sessions,** with branch, where it ran (CLI, desktop app, VS Code), models, tokens, cost and duration.
- **Current 5-hour window:** tokens so far, reset countdown, burn rate and projection, with an optional budget.
- **Last 7 days:** a rolling total, the change vs the week before, and an optional budget.
- **Live plan limits (optional):** your real session and weekly usage % and reset times, the same numbers `/usage` shows in Claude Code.
- **Charts:** usage over time (by type, model or cost), model share, an activity heatmap, and recent 5-hour windows.
- **API-equivalent cost:** what the same usage would cost at public API prices.

There are filters for project and model, and switches for subagents, cache reads and background usage. It has light and dark themes and works on a phone.

## Install

```bash
npm install -g claude-usage-board
```

Then run `claude-usage-board`. You can also run it once without installing: `npx claude-usage-board`.

It needs Node.js 18 or newer.

### Windows, macOS and Linux

It works the same on all three. On Windows, Claude Code keeps its logs in `C:\Users\<you>\.claude\projects`, and the tool finds them automatically.

If you run Claude Code inside **WSL**, its logs live in your Linux home folder. In that case, run `npx claude-usage-board` inside WSL too. Or, from Windows, point the tool at those logs:

```powershell
$env:CLAUDE_CONFIG_DIR = "\\wsl$\Ubuntu\home\<you>\.claude"; npx claude-usage-board
```

## Terminal report

```bash
claude-usage-board report --since 7d
```

```bash
claude-usage-board report --by project --since 30d
```

```bash
claude-usage-board report --project my-app --by day
```

```bash
claude-usage-board report --json
```

| Option | |
|---|---|
| `--since <range>` | `30m`, `5h`, `7d`, `2w`, `3mo`, `all` (default `all`) |
| `--by <group>` | `model`, `project`, `day`, `session` (default `model`) |
| `--project <text>` | only projects whose path contains `<text>` |
| `--no-background` | leave out background usage (see below) |
| `--live-limits` | also fetch your real plan limits |
| `--json` | JSON output |

Colour is turned off when the output is piped or redirected, or when `NO_COLOR` is set.

Dashboard options: `--port <n>` (default 4321; if that port is busy it moves to the next free one) and `--no-open`.

## Where the data comes from

- Everything comes from Claude Code transcripts in `~/.claude/projects/**/*.jsonl`, or `$CLAUDE_CONFIG_DIR/projects` if you set that. This covers the CLI, the desktop app's Code tab, IDE extensions and subagents.
- Duplicate log lines for the same API response are merged.
- Conversations on claude.ai, and in the chat tab of the Claude desktop app, aren't stored locally, so they aren't included.
- **Background usage** is usage that Claude Code records in its per-session cost records but never writes to a transcript, such as session titles, summaries and background Haiku calls. It's shown separately, and you can hide it.
- **Cost** uses public API list prices: cache writes are 1.25× (5-minute) or 2× (1-hour) the input price, and cache reads are discounted. On a Pro, Max or Team plan you don't pay this; it shows the value of what you used.
- **The 5-hour window** is an estimate. It opens at your first message (floored to the UTC hour) and lasts five hours.

## Live plan limits

Click **Fetch live limits**, or pass `--live-limits` to the report. This reads Claude Code's login (from the macOS keychain, or `~/.claude/.credentials.json` on Linux and Windows) and asks Anthropic's usage endpoint for your current percentages.

- The token is only ever sent to `api.anthropic.com`.
- Nothing is fetched until you ask for it.
- If the saved login has expired, run `claude` in a terminal once to refresh it.

## Privacy

- The server listens only on `127.0.0.1` and only answers requests addressed to `localhost`.
- The dashboard makes no third-party requests.
- Budgets and display settings are stored only in your browser.

## License

MIT
