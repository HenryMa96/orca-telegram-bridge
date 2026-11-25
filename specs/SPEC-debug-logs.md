# SPEC: Detailed bridge logs (debug level, error details, export)

**Date:** 2026-11-25
**Status:** implemented (debugLogging default off; released in 0.2.1)

## Goal
The panel's Logs tab shows one short line per event (`message`, cut at 500 chars, last 25 of 60).
Errors lose their context (CLI args, exit code, stderr, HTTP status, Telegram method, stack, chat/bot
ids, timings), four failure paths only reach `orca.log`, and about 15 `catch {}` sites drop errors
silently. This feature makes the log good enough to diagnose a failure from the panel or from an
exported file, without leaking the bot token.

## Behavior
- When any error is logged, the entry carries `details`: error class, message, the error's own
  fields (CLI: args, exit code, stderr ≤1500 chars, stdout length only, duration, kind timeout/aborted/exit/json/spawn;
  Telegram: method, HTTP status, description, retry_after), the call context (tg chat id, update id,
  bot name, Orca chat id, elapsed ms) and the top of the stack.
- When the new setting `debugLogging` is on, the worker also records `debug` entries: Telegram calls
  (method, ms, result size; empty long polls skipped), Orca CLI calls (command, ms, ok/error; frequent
  sync reads only when slow (>2 s) or failing), dispatch start/finish (bot, chat, new/existing,
  body length, images, polls, final state, reply length, ms), sync ticks that forward something,
  config changes (field names, never values of secrets), poll loop start/stop/backoff.
- When `debugLogging` is off, no `debug` entries are stored; errors/warnings still get `details`.
- Swallowed errors (`catch {}` around sendChatAction, answerCallbackQuery, image cleanup,
  statusBar.update, storage writes, secrets delete, etc.) are recorded as `debug` entries
  instead of disappearing. Failures now only in `orca.log` also go to the panel log.
- Every message and detail is redacted: the current token and any `bot<digits>:<secret>` pattern
  become `bot<redacted>`.
- Data minimization: never logged are Telegram message/caption text, callback_data beyond its
  prefix, CLI stdin, CLI stdout content, HTTP headers, or credential URLs. Only ids, lengths,
  counts, methods, status codes and timings.
- The panel Logs tab: level filter (All / Errors / Warnings+errors / Debug), each entry shows time,
  level, scope and message; entries with details expand (Collapsible) into a wrapped CodeView.
  A `Debug logging` switch toggles the setting. `Export logs` saves a text file (files.saveAs,
  called right after the export request inside the press; disabled when the host has no
  `files` API, e.g. `orca serve`) with a diagnostics header (plugin version, platform, Node
  version, resolved orca CLI path, status, config without token, bot/binding counts) and all
  stored entries with details.
- Limits: 200 entries stored (ring), details cut at 3000 chars, state posted to the panel carries
  the newest 40 entries (keeps posts far under the 256 KiB cap); export returns all 200
  (answers may be up to 1 MiB).
- Old stored logs (no scope/details) still load and render.
- Storage writes of the log ring are coalesced (≤1 per ~1 s, flushed on dispose); `debug` entries
  never post state to the panel by themselves (post cap 200 per 10 s).

## API / Interface
- `protocol.ts`: `BridgeLogEntry { id; at; level: 'debug'|'info'|'warn'|'error'; scope: LogScope;
  message; details?: string }`, `LogScope = 'bridge'|'telegram'|'orca-cli'|'dispatch'|'sync'|'config'`.
  `BridgeState.logTotal: number`, `BridgeConfig.debugLogging: boolean`.
- New panel handlers: `bridge.setDebugLogging({ enabled })` → `BridgeState`;
  `bridge.exportLogs()` → `{ fileName: string; text: string }`.
- Manifest setting `debugLogging` (boolean, default false).
- `orca-bridge.ts`: `OrcaCliError extends Error { kind; args; exitCode; stderr; stdoutBytes; durationMs }`
  thrown by `runOrcaJson` (message text unchanged so existing checks keep working).
- `telegram-api.ts`: `TelegramApiError` gains `method?: string`.

## Implementation Outline
- `src/protocol.ts` — types above.
- `src/orca-bridge.ts` — `OrcaCliError`; set fields at every reject in `runOrcaJson`.
- `src/telegram-api.ts` — fill `method` on `TelegramApiError`.
- `src/worker.ts` — `appendLog(level, scope, message, details?)`; `describeError(err, context)`;
  `redact()`; debug gate; wrap `deps.telegram` and `deps.orcaCli` with timing/debug proxies at
  construction; route the 15 silent catches and 4 `orca.log`-only paths; context on error logs;
  `setDebugLogging`, `exportLogs` handlers; state slice + `logTotal`.
- `src/panel.tsx` — filter Select, Collapsible + CodeView details, debug Switch, Export button.
- `orca-plugin.json` — `debugLogging` setting. README: short "Debugging" section.
- Tests: worker (CLI error details incl. stderr/exit code; token redaction; debug gate on/off;
  swallowed sendChatAction error recorded; export contains header + details; state slice size),
  orca-bridge (OrcaCliError fields on exit/timeout/json), panel (filter, details expand, export
  calls files.saveAs, debug switch request).

## Acceptance Criteria
1. [x] A failing `orca` CLI call shows, in the panel, args, exit code and stderr of that call.
2. [x] A Telegram API error shows method, HTTP status and description.
3. [x] No log message, detail or export contains the bot token (test with a real-looking token).
4. [x] With `debugLogging` off, no `debug` entries are stored; with it on, a dispatch produces
       start/finish debug entries with timings.
5. [x] The previously silent `sendChatAction` failure appears as a debug entry.
6. [x] Export produces a text file with the diagnostics header and every stored entry's details.
7. [x] State posted to the panel holds at most 40 log entries; storage holds at most 200.
8. [x] Logs stored by 0.2.0 (no scope/details) render without errors.
9. [x] `orca plugin test` and `orca plugin check` pass.

## Out of Scope
- Sending logs anywhere remotely; log files on disk outside storage; per-scope verbosity levels;
  logging message bodies of users/bots (only lengths and ids are logged).
