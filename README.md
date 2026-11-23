# Telegram Bridge

An Orca `trusted-worker` + `components` sidebar plugin that connects your Telegram bot directly to your local Orca bots for real-time two-way chat.

## Features

- **Always-on long polling** (`getUpdates`) inside Orca's worker (no public IP, webhook, or external daemon required)
- **Strict user allowlist** (`allowedUserIds`) with one-click pairing in the sidebar panel
- **Encrypted Bot Token storage** via `orca.secrets` (OS keyring)
- **HTTP proxy support** (`proxyUrl` or `HTTPS_PROXY` / `HTTP_PROXY`)
- **Per-chat Orca context binding** — keeps multi-turn conversation history in a dedicated Orca chat per Telegram chat and automatically tracks Orca bot renames by `botId`
- **Optional two-way Orca-side sync** (`syncOrcaOutbound`) — optionally forwards messages you send directly in Orca (and bot replies) from bound chats back to Telegram
- **Telegram `/` command menu** (`setMyCommands`): `/help`, `/new`, `/bots`, `/use`, `/chats`, `/bind`, `/status`
- **Rich Markdown + Table PNG rendering**:
  - Converts Markdown headings, bold, italic, strikethrough, blockquotes, task lists, links, and fenced code blocks to Telegram HTML
  - Renders standard Markdown tables (`| col |`) into crisp PNG images via Python Pillow (`sendPhoto`), automatically falling back to formatted text when Python/Pillow is not installed

## Requirements

- **Orca** `>= 1.4.248`
- **Optional (for table-to-PNG rendering)**: Python 3 with `Pillow` installed (`pip install pillow`)

## Setup

1. Install or load the plugin in Orca:
   ```sh
   orca plugin dev load . --json
   ```
   Review the requested capabilities (`storage:own`, `secrets:own`, `settings:own`, `notifications:show`) and re-run with the printed `--approve <fingerprint>` flag.
2. Open the **Telegram** sidebar panel in Orca.
3. Paste your `@BotFather` token, choose a default Orca bot (or leave blank to auto-select the first bot), optionally set an HTTP proxy (e.g. `http://127.0.0.1:7890`), and click **Save Settings** -> **Test Connection**.
4. Send a message to your Telegram bot, then click **Allow \<your ID\>** in the panel banner.

## Telegram Commands

| Command | Description |
| --- | --- |
| `/help` | Show current target bot, session ID, and command list |
| `/new` | Reset current chat binding and start a fresh Orca session |
| `/bots` | List all available Orca bots |
| `/use <name>` | Switch target Orca bot |
| `/chats` | List recent active Orca chats for the current bot |
| `/bind <chatId>` | Bind Telegram chat to an existing Orca chat |
| `/status` | Show Telegram bot, target Orca bot, session, and polling status |

## Develop & Validate

```sh
orca plugin validate . --json
orca plugin test . --json
orca plugin check . --json
orca plugin release-entry . --json
orca plugin dev reload . --json
```

## Publishing to Orca Community Plugins

See [PUBLISHING.md](./PUBLISHING.md) for the full pre-publish audit and step-by-step release runbook.

When ready to publish to a public GitHub repository for automatic indexing on `orca.dev/plugins`:

1. Ensure `LICENSE` (MIT) and `orca-plugin.json` (`"license": "MIT"`) are present, and optionally add `"repository"`, `"homepage"`, `"author"`, and `"publisher"` (set to your GitHub owner name) in `orca-plugin.json`.
2. Run all local checks and confirm exit code `0`:
   ```sh
   orca plugin validate . --json
   orca plugin test . --json
   orca plugin check . --json
   ```
3. Push to a public, non-fork GitHub repository, tag the release matching `version` in `orca-plugin.json`, and add the `orca-plugin` topic:
   ```sh
   git tag -a v0.1.0 -m v0.1.0
   git push origin v0.1.0
   gh repo edit <owner>/orca-telegram-bridge --add-topic orca-plugin
   ```
4. Check listing status at `https://orca.dev/plugins/<owner>/orca-telegram-bridge`.

## License

[MIT](./LICENSE)
