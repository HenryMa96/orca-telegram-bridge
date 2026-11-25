# Telegram Bridge

An Orca `trusted-worker` + `components` sidebar plugin that connects your Telegram bot directly to your local Orca bots for real-time two-way chat.

Fork of the original plugin by [HenryMa96](https://github.com/henryma96/orca-telegram-bridge).

## Features

- **Always-on long polling** (`getUpdates`) inside Orca's worker (no public IP, webhook, or external daemon required)
- **Strict user allowlist** (`allowedUserIds`) with one-click pairing in the sidebar panel
- **Encrypted Bot Token storage** via `orca.secrets` (OS keyring)
- **HTTP proxy support** (`proxyUrl` or `HTTPS_PROXY` / `HTTP_PROXY`)
- **Per-chat Orca context binding** — keeps multi-turn conversation history in a dedicated Orca chat per Telegram chat and automatically tracks Orca bot renames by `botId`
- **Telegram → Orca image forwarding** — downloads compressed photos and uncompressed image documents locally and passes their file path(s) to the Orca bot (with optional caption)
- **Optional two-way Orca-side sync** (`syncOrcaOutbound`) — optionally forwards messages you send directly in Orca (and bot replies) from bound chats back to Telegram
- **Telegram `/` command menu** (`setMyCommands`) + **interactive inline buttons**: `/help`, `/new`, `/home`, `/bots`, `/use`, `/chats`, `/bind`, `/rename`, `/sync`, `/automations`, `/run`, `/status`
- **Rich Markdown + Table PNG rendering**:
  - Converts Markdown headings, bold, italic, strikethrough, blockquotes, task lists, links, and fenced code blocks to Telegram HTML
  - Renders standard Markdown tables (`| col |`) into crisp PNG images via Python Pillow (`sendPhoto`), automatically falling back to formatted text when Python/Pillow is not installed

## Requirements

- **Orca** `>= 1.4.248`
- **Optional (for table-to-PNG rendering)**: Python 3 with `Pillow` installed (`pip install pillow`)

## Install

Two ways work today: from this GitHub repository (CLI or Orca Settings) and from a local clone. The Orca catalog way is not available yet.

Already using `henryma96.telegram-bridge`? Read [Moving from henryma96.telegram-bridge](#moving-from-henryma96telegram-bridge) first.

| Way | Use it when |
| --- | --- |
| [From this GitHub repository](#from-this-github-repository-recommended) | You want to use the plugin. This is the normal way today. |
| [From the Orca catalog](#from-the-orca-catalog-not-available-yet) | Not available yet. This fork is not listed. |
| [From a local clone](#from-a-local-clone-development) | You want to change the code. |

The plugin key is `drecchia.telegram-bridge`. Orca uses the repository owner (`drecchia`) as the publisher.

**On Linux, Orca's CLI is `orca-ide`.** Plain `orca` there is usually the GNOME screen reader. Replace `orca` with `orca-ide` in every command in this README. On Windows and macOS the command is `orca`.

### From this GitHub repository (recommended)

Orca installs the newest `vX.Y.Z` tag of this repository and pins it to that exact commit:

```sh
orca plugin install drecchia/orca-telegram-bridge
```

To install one exact version, add its tag (see the repository tags):

```sh
orca plugin install drecchia/orca-telegram-bridge@vX.Y.Z
```

**Approve the plugin.** This plugin runs code, so the first run stops with `approval_required` (exit code `3`). Nothing is installed yet. Orca prints:

- what the plugin would be granted and why (its capabilities `storage:own`, `secrets:own`, `settings:own`, plus its panel and commands);
- the publisher (`drecchia`) and the source repository (`github.com/drecchia/orca-telegram-bridge`), because the plugin does not come from Orca's official catalog;
- the exact command to run again with `--approve <fingerprint>`.

Check the list. If you trust it, run the printed command. It looks like this:

```sh
orca plugin install drecchia/orca-telegram-bridge --approve <fingerprint>
```

The fingerprint is bound to this plugin, version, files and access. Installing a different version by hand needs a new fingerprint. Updates that ask for no new access keep the approval (see [Update](#update)).

Without the CLI: in Orca, open **Settings → Plugins**, choose **Add plugin**, then **From a Git URL…**. Paste `https://github.com/drecchia/orca-telegram-bridge#vX.Y.Z`, choose **Install**, review the access, then enable it.

### From the Orca catalog (not available yet)

When the plugin is listed on [orca.dev/plugins](https://orca.dev/plugins), you can install it by id:

```sh
orca plugin install drecchia.telegram-bridge
```

Today this does not work. This repository is a GitHub fork of [HenryMa96/orca-telegram-bridge](https://github.com/henryma96/orca-telegram-bridge), and the directory leaves forks out ([Add your plugin](https://orca.dev/plugins/add)). The current status is on [orca.dev/plugins/drecchia/orca-telegram-bridge](https://orca.dev/plugins/drecchia/orca-telegram-bridge). Use the GitHub install above. After listing, the approval step is the same. Existing GitHub installs keep updating from GitHub; you do not need to switch.

### From a local clone (development)

Load the working folder as a development plugin:

```sh
git clone https://github.com/drecchia/orca-telegram-bridge.git
cd orca-telegram-bridge
orca plugin dev load . --json
```

The first load also stops with `approval_required` (exit code `3`). Run it again with the printed fingerprint:

```sh
orca plugin dev load . --approve <fingerprint> --json
```

Orca reloads the plugin when its files change. Code edits run without a new approval. New access needs one. If Orca missed a change, reload by hand:

```sh
orca plugin dev reload . --json
```

To remove the development copy, run `orca plugin dev unload .`. For checks and releases, see [PUBLISHING.md](./PUBLISHING.md).

### Update

- GitHub install: run `orca plugin update drecchia.telegram-bridge`, or run the install command again with the new `@vX.Y.Z` tag. If the new version asks for more access, Orca stops with `approval_required` and keeps the running version. Run the printed `--approve <fingerprint>` command.
- Local clone: `git pull`, then `orca plugin dev reload . --json`.

### Moving from `henryma96.telegram-bridge`

The upstream plugin has the key `henryma96.telegram-bridge`. This fork has a different key, so Orca treats it as a different plugin. The bot token, settings and stored data do not carry over.

1. Remove the old plugin. If you installed it from GitHub or the catalog, run `orca plugin uninstall henryma96.telegram-bridge`. If you loaded a local folder (upstream's Setup step), run `orca plugin dev unload <that folder>`. Two copies that poll the same bot token conflict.
2. Install this fork (see above).
3. Do the [Setup](#setup) steps again.

## Setup

Do these steps after the plugin is installed and approved.

1. Open the **Telegram** sidebar panel in Orca.
2. Paste your `@BotFather` bot token.
3. Choose a default Orca bot, or keep **(Auto-select first Orca bot)**.
4. Optional: set an HTTP proxy (e.g. `http://127.0.0.1:7890`).
5. Click **Save Settings**, then **Test Connection**.
6. Send a message to your Telegram bot. Then click **Allow \<your ID\>** in the panel banner.

## Telegram Commands

| Command | Description |
| --- | --- |
| `/help` | Show current target bot, session ID, sync status, and command list |
| `/new` | Reset current chat binding and start a fresh Orca session |
| `/home` | Bind Telegram chat to the current bot's Home Chat |
| `/bots` | List all available Orca bots with inline switch buttons |
| `/use <name>` | Switch target Orca bot |
| `/chats` | List recent active Orca chats with inline bind/new/home buttons |
| `/bind <chatId>` | Bind Telegram chat to an existing Orca chat |
| `/rename <title>` | Rename the currently bound Orca chat |
| `/sync [on\|off]` | Toggle or set Orca → Telegram outbound sync |
| `/automations` | List Orca automations with inline run buttons |
| `/run <id>` | Trigger an Orca automation immediately |
| `/status` | Show Telegram bot, target Orca bot, session, sync, and polling status |

## Debugging

- The **Logs** tab lists the newest 40 of up to 200 stored entries. Filter by level (all, errors, warnings and errors, debug only). Entries with details expand to show the error context: Orca CLI args, exit code and stderr; Telegram method, HTTP status and description; chat ids, timings and the top of the stack.
- Turn on **Debug logging** in the Logs tab (or the `debugLogging` setting, off by default) to also record `debug` entries: Telegram and Orca CLI calls with timings, dispatch start/finish, sync ticks that forward something, config changes (field names only), poll loop start/stop/backoff and errors that were ignored before. Turn it off again when done; errors and warnings keep their details either way.
- Every message and detail is redacted: the bot token and any `bot<digits>:<secret>` pattern become `bot<redacted>`. Message text from users and bots is never logged, only lengths and ids.
- For a bug report, click **Export logs**. It saves a text file with a diagnostics header (plugin version, platform, Node version, resolved `orca` CLI path, status, config without the token, bot and binding counts) and every stored entry with its details.

## Develop & Release

To work on the code, use the [local clone install](#from-a-local-clone-development). [PUBLISHING.md](./PUBLISHING.md) is the full runbook: the pre-release audit, the checks (`orca plugin validate`, `test`, `check`, `release-entry`), tagging a `vX.Y.Z` release, and the catalog listing status.

## License

[MIT](./LICENSE)
