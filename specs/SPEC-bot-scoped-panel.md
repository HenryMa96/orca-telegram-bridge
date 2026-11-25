# SPEC: Telegram panel follows the bot selected in Orca's left sidebar

**Date:** 2026-11-25
**Status:** implemented in 0.9.0 (user: show only the clicked bot's bridge, chats and logs; a bot without a bridge shows only "Add bridge"; one bridge per bot. Answers: outside a bot the panel shows only a hint; remove "Auto-select first Orca bot")

## Facts (Orca upstream, host API)
- Every Orca bot has a home: a folder workspace `folder:<folderWorkspaceId>` at `<bots root>/<slug>` (`~/.orca/bots/<slug>`), the folder that holds `bot.json` (`{ id, name, ... }`). Opening a bot focuses that workspace (`src/renderer/src/components/bots/bot-session-open.ts`, `src/main/bots/bot-home-workspace.ts`).
- A components panel gets the focused workspace with `on('workspace.changed', handler)` from `orca` (each new subscriber first gets the current context); frames see `folder:` ids. Capability `workspace:read`.
- The worker lists workspaces with `this.orca.host.call('workspace.list')` (rows: `id`, `kind`, `name`, `path`, ...; capability `workspace:read`).
- A panel cannot be hidden by context: the manifest has no visibility condition. Only its content changes.

## Behavior
1. Manifest: add capability `workspace:read`.
2. Worker handler `bridge.focusedBot` (no input) → `{ kind: 'bot', bot: { id, name } } | { kind: 'none' } | { kind: 'unknown', reason: string }`. The worker calls `workspace.readContext` itself and matches its `workspaceId` against its own `workspace.list` rows (both worker-surface ids, so they are comparable; a frame's id may be a different form). Folder row → read `<path>/bot.json` → `bot` when `id`/`name` are strings. `none` = the lookup worked and focus is not a bot (no focused workspace, a worktree, a folder without bot.json). `unknown` = the lookup could not run (capability refused, no `workspaceId` from an older host, `workspace.list` failed, bot.json unreadable for another reason than missing); logged at warn once per reason. Cache the workspace list briefly (a few seconds).
3. Panel subscribes to `workspace.changed` and, on each event, asks `bridge.focusedBot` (ignore stale answers when another event came after). Also asks once at setup.
4. Focus resolved and not a bot (`none`): the panel shows only an EmptyState "Select a bot in the left sidebar to see its Telegram bridge." — plus, when any exist, the bridges whose bot no longer exists (orphans: `orcaBot` not in `state.bots`, and not '' while bots exist), each with its card so it can be edited or removed.
   Lookup unavailable (`unknown`): fall back to the full bridge list as before (all bridges, the old Setup/Chats/Logs), with a muted line "Showing all bridges: Orca did not say which bot is selected." so config is never out of reach.
5. Focus on a bot:
   - The bridge for the bot is the one whose `orcaBot` equals the bot's name (case-sensitive; Orca bot names are what `orcaBot` stores).
   - With a bridge: tabs Setup / Chats / Logs show only that bridge (its card or editor; its chat bindings; its log entries — the log bridge filter disappears).
   - Without a bridge: Setup shows "No Telegram bridge for <bot>" and one button "Add bridge", which creates a bridge pinned to this bot (`orcaBot` = bot name) and opens its editor. Chats/Logs show their empty states.
6. One bridge per bot: the worker refuses `bridge.add`/`bridge.saveConfig` that would give two bridges the same `orcaBot` (error message names the bot); the panel never offers it.
7. "(Auto-select first Orca bot)" is removed. The editor shows the bot as fixed text (no Orca bot select): the selected bot is the bridge's bot. A stored bridge with `orcaBot: ''` keeps working in the worker as before (first bot) and is shown for the first bot in `state.bots`; saving it pins it to that bot.
8. Status bar, commands, worker behavior otherwise unchanged. Header line ("N bridges · M connected") may stay in the bot view only if it is about this bridge; prefer the bridge's own status.

## Acceptance Criteria
1. [x] `workspace.changed` with a bot's home → only that bot's bridge, chats and logs; another bot → switches; a project workspace or null → only the hint (plus orphan bridges); lookup unavailable → all bridges.
2. [x] A bot without a bridge shows only "Add bridge"; pressing it creates a bridge with `orcaBot` = that bot and opens the editor.
3. [x] The worker refuses a second bridge for the same bot (add, and a save that moves a bridge onto a bot that has one).
4. [x] `bridge.focusedBot` maps the focused folder workspace to its bot.json (`bot`); a worktree, null focus or a folder without a valid bot.json → `none`; capability refused, no `workspaceId`, a failed list, or a focused id missing from the list → `unknown` (logged once per reason).
5. [x] No "Auto-select" option and no Orca bot select in the editor.
6. [x] `orca plugin test` (192), `orca plugin check`, `orca plugin validate` pass; tsc shows no new error (12 older type-only errors remain).
