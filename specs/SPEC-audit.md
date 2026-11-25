# SPEC: Audit trail (wave D)

**Date:** 2026-11-25
**Status:** implemented in 0.13.0. Decisions: keep 90 days, at most 2000 entries (all bridges); a per-bridge group notice option, off by default.

## Contract (done by the orchestrator, src/protocol.ts)
`AuditAction`, `AuditEntry` (id, at, bridgeId, source telegram|panel, userId?, userLabel?, chatId?, roleName?, action, target?, result done|refused), `AuditQuery` (bridgeId?, action?, result?), `BridgeConfig.groupAuditNotice` / `SaveConfigInput.groupAuditNotice?`, requests `bridge.listAudit` (newest first, ≤500, plus total) and `bridge.exportAudit` (CSV text + file name).

## Worker
1. **Store**: one global storage key (e.g. `tg.audit`), not per bridge, so a removed bridge's entries stay. Append through one function; prune entries older than 90 days and keep at most 2000 newest; write batched like the logs (flush timer) and flush on dispose. Plain JSON only (`toPlainJson`). Never message text, tokens, keys or prompts. `userLabel` uses `formatSenderLabel`.
2. **What is recorded** (Telegram side, with the sender's/tapper's role name and chat id):
   - `run` (target = automation name, else id) for /run and r: buttons; `sync` (target on/off) for /sync and s: buttons; `new`, `home`, `bind` (target = Orca chat id), `rename` (no target: the new title is user text and is never stored); `retry`, `details` taps;
   - `refused` (target = the command, e.g. `/run`, or the button kind) for every role refusal (commands, buttons, messages without `chat` — target `chat`), result `refused`.
   Done actions: result `done` only when the action actually happened (after it succeeded).
3. **Panel side** (source panel): `access` (open/restricted, ids added/removed as ids — they are Telegram ids, not secrets), `roles` (target = changed role names / "assignments"), `token` (target "changed" / "cleared"), `allow` (target = the allowed id), `bridgeAdded`, `bridgeRemoved`. From saveConfig/allowUserId/addBridge/removeBridge; compute what changed, skip no-op saves.
4. **Group notice**: when `groupAuditNotice` is on and a `done` action of kind new/home/bind/rename/sync/run happens in a group chat, send one plain line in the chat's language (i18n, 4 languages), e.g. EN "@joao started a new chat", "@joao turned Orca sync off", "@joao ran Daily backup". Never for refusals or private chats.
5. Handlers `bridge.listAudit` and `bridge.exportAudit` (CSV columns: time ISO, bridge, source, user id, user, chat, role, action, target, result; quote fields).
6. Config: `groupAuditNotice` is read (default false) and saved (absent keeps). Changing it is not itself an audited action.

## Panel
1. A new tab **Audit** next to Logs, following the focused bot like Chats/Logs (bridgeId = the bot's bridge; the `unknown` fallback view shows all bridges). Loads via `bridge.listAudit` when the tab opens and on refresh; filters: action (Select, "All actions" + each action with a plain label) and result (All / Done / Refused); list newest first with title "<who> · <action> <target>" and description "<time> · <role> · <chat>"; refused entries with danger tone badge; empty state "Nothing recorded yet."; "Showing N of M"; **Export** button (files.saveAs with the CSV) when `host.has('files.saveAs')`.
2. Editor, **Groups** section: Switch "Post a line in the group when someone changes its shared chat, sync or runs an automation" (default off), saved as `groupAuditNotice`.

## Acceptance Criteria
1. [x] /run, /sync, /new, /home, /bind, /rename and their buttons record `done` with role and target; a role refusal records `refused`; no message text or title is stored.
2. [x] Panel saves record access, roles (per role: prompt, permissions, added, removed, renamed; assignments — never prompt text) and token changes (never the token), Allow, bridge added/removed; a no-op save records nothing.
3. [x] Entries older than 90 days are pruned; at most 2000 kept; a removed bridge's entries remain.
4. [x] Group notice: only with the option on, only in groups, only for done shared-state actions, in the chat language.
5. [x] listAudit filters by bridge/action/result, newest first, ≤500 with total; exportAudit returns CSV.
6. [x] Panel Audit tab: scoped to the focused bot, filters, list, empty state, Export; Groups switch saved.
7. [x] `orca plugin test` (252), `check`, `validate` pass; tsc no new error (12 older type-only errors remain).
