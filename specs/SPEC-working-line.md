# SPEC: "Working…" line and plain-language errors (wave B)

**Date:** 2026-11-25
**Status:** approved. Decisions: show the line after 20 s; [Details] gated by a new role permission `errorDetails` (Full access has it, Stranger never). No [Stop]: Orca has no way to cancel a bot's turn (no CLI command or host API).

## Contract (done by the orchestrator)
- `src/roles.ts`: permission `errorDetails` (in ROLE_PERMISSIONS, Full access gets it, in STRANGER_FORBIDDEN); `permissionForCallback`: `x:<id>` (Try again) -> `chat`, `d:<id>` (Details) -> `errorDetails`.
- `src/panel.tsx`: label "See error details (private chats)".

## Behavior (worker)
1. **Working line.** While waiting for the Orca bot's answer to a message that called it (private chat, or an addressed group message; never unaddressed group lines), if no answer after 20 s, send one message `⏳ <workingLine(elapsed)>` (i18n, 4 languages, e.g. EN "Working… 20s", "Working… 1 min 30 s") as a reply to the user's message, then edit it at most every 15 s while still waiting. The typing indicator stays as today.
2. **Answer arrives** -> delete the working line, then send the answer as today (so the phone notifies). If delete fails, edit it to `✓` and log a warning (once per chat).
3. **Failure** -> delete the working line and send ONE plain line in the chat's language by kind, with inline buttons:
   - timeout (the reply wait passed): "The Orca bot is still working and went past the wait time. Try again in a few minutes."
   - Orca unreachable / CLI failure: "I couldn't reach Orca on this computer."
   - anything else: "Something went wrong while answering."
   The technical text never goes in the line; it stays in Logs as today.
   The working line is also deleted on every path that sends no normal reply: a NO_REPLY answer, an answer withheld in a group's "answers when called" mode, and a refused or undispatched message.
   - Buttons: **[Try again]** (`x:<id>`) **only when the message provably never reached the Orca bot** (the send itself failed, before `sendToBot` succeeded). A timeout or a failure after the send does NOT get [Try again]: the Orca turn may still be running, and a retry could run a risky request twice. And, only in a private chat and only when the sender's role has `errorDetails`, **[Details]** (`d:<id>`).
4. **Try again** (`x:`): bound to the original sender id and chat id — any other user is refused, whatever their role; re-runs the same message (text, transcript, image paths) through the normal path. Kept **in memory only**, 30 min, then the button answers "This message expired". One retry at a time per message.
5. **Details** (`d:`): role check by permission + private chat only; sends the technical cause (already redacted: tokens and voice keys masked; truncated as today) as a reply. Kept in memory with the retry record.
6. Unaddressed group lines keep today's quiet behavior (no line, no error message).
7. **/help leak fix** (from review): `/help` shows the bound Orca chat id only when the role has `bindPrivate`/`bindGroup` for that chat type, and the sync state only when it has `sync`.

## Telegram client
- `editMessageText(token, { chatId, messageId, text }, options)` and `deleteMessage(token, chatId, messageId, options)`; add to the tracer and every mock that lists client methods.

## Acceptance Criteria
1. [ ] An answer after 20 s: a working line appears, is edited, then deleted before the answer; an answer before 20 s: no line.
2. [ ] A timeout and a CLI failure each give their plain line in the chat's language with [Try again]; no technical text in Telegram.
3. [ ] [Try again] by the sender re-sends and answers; by someone else it is refused; after 30 min it says expired.
4. [ ] [Details] shows only in private chats for roles with errorDetails and sends the redacted cause; a Member sees no [Details].
5. [ ] Unaddressed group lines: no working line, no error message.
6. [ ] /help hides the chat id without bind and the sync state without sync.
7. [ ] Wire format tests for editMessageText and deleteMessage.
8. [ ] `orca plugin test`, `check`, `validate` pass; tsc no new error.
