# SPEC: Names next to listed Telegram IDs

**Date:** 2026-11-25
**Status:** implemented in 0.14.0 (user request: show the Telegram @username/name after each ID in "People and groups").

## Problem
The editor's "People and groups" rows show bare numeric IDs; the owner cannot tell who is who.

## Behavior
1. **What is shown**: right after each ID field, a muted text with the name the bridge knows for that ID: `@username` for a person with one, else first + last name, else nothing; a group's title. Nothing when unknown. The panel matches the row's trimmed ID.
2. **Whose names are kept**: only IDs listed on the bridge (`allowedUserIds` and the keys of `roleAssignments`). Strangers on an open bridge and blocked senders are not stored. A name whose ID leaves the list is dropped at the next save.
3. **Where names come from** (worker):
   - every incoming update from a listed person (`from`) and every message in a listed group (`chat.title`): store when new or changed;
   - when a bridge connects (after getMe succeeds) and after a config save: `getChat(id)` for each listed ID that has no name yet, one after another, at most 50 per run; a failure (user never opened the bot, bot not in the group, 400/403) is ignored and logged at debug level only. Retry the missing ones only on the next connect or save, never in a loop.
4. **Storage**: per bridge key `tg.<bridgeId>.knownNames` = `{ [id]: name }`, plain JSON; removed with the bridge. Write only on change.
5. **Protocol**: `BridgeView.knownNames: Record<string, string>`.
6. **Telegram client**: new method `getChat(chatId)` returning `{ id, type, title?, username?, first_name?, last_name? }`. Every mock/tracer of TelegramClient gains it.

## Acceptance Criteria
1. [x] A listed person's message stores `@username` (or "First Last"); a listed group's message stores its title; an unlisted sender stores nothing.
2. [x] On connect and after save, listed IDs without a name are looked up once with getChat; failures leave them blank, are not retried in a loop, and do not log warnings.
3. [x] Removing an ID from the list drops its name; removing the bridge deletes the key.
4. [x] The panel shows the name after the ID field, only when known, and follows edits of the ID.
5. [x] test (258), check, validate pass; tsc no new error.
