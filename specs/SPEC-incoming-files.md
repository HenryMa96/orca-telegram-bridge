# SPEC: Files from Telegram to the Orca bot

**Date:** 2026-11-25
**Status:** implemented in 0.15.1 (user report: an .xlsx sent to the bot never reached the Orca bot; .docx and .pdf required too).

## Problem
`handleIncomingUpdate` passes text, voice/audio, photos and image documents only. A non-image document with no caption hits `if (!text && !image && !unsupportedImage && !voice) return null` and is dropped silently (no log, no reply); with a caption only the caption reaches the Orca bot, so the bot truthfully says it got no file.

## Behavior
1. **Which messages**: a `msg.document` that is not taken as an image (`extractIncomingImage` null and not an `unsupportedImage`) is an incoming **file**. Any type (spreadsheets, PDF, CSV, Office, text, archives…).
2. **Size**: Telegram lets a bot download at most 20 MB. When `document.file_size` is above 20 MB (20 * 1024 * 1024), reply one plain line in the chat's language (new i18n `fileTooLarge`, 4 languages; EN "This file is larger than 20 MB, the most a Telegram bot can download. Send a smaller file or a link.") and do not dispatch. Unknown size: try the download.
3. **Download**: like images (`getFile` + `downloadFile`, same proxy/timeouts), saved under `<downloadDir or tmp>/orca-telegram-bridge/files` (dir mode 0o700), 24 h cleanup like images. File name: `tg-<ts>-<messageId>-<rand>-<safe original name>`; safe name = original `file_name` with every char outside `[A-Za-z0-9._-]` replaced by `_`, at most 80 chars keeping the extension, default `file` + extension from the Telegram file_path when there is no name. Never let the name escape the directory.
4. **Dispatch**: the Orca bot gets a new block, after the images block: `Attached Telegram file(s) saved locally (open them with your tools; the original name is in parentheses):` then `- <path> (<original file name>)`. With no caption, the user text is `Please open the attached file(s) above and respond.` The caption, when present, is the user text as today.
5. **Groups**: a file counts as media like an image or voice for `groupMessageText` (same addressing rules).
6. **Access and roles**: same as any message (needs `chat`); no new permission.
7. **Logs**: the inbound log line says `document <ext> <bytes> bytes` (never the file name). Download failure: the existing plain error path.
8. **Debounce/rerun paths** that carry `image` / `imagePaths` (e.g. `processAuthorizedMessage`, retry records) carry the file too, so a retry or a voice+file flow does not lose it.

## Also in this change (chat titles)
`isAutomaticChatTitle` in src/worker.ts must match only Orca's known automatic titles: `^Telegram: ` and `^your owner's agent: Telegram: `. A chosen title such as `Project: Telegram: roadmap` must stay.

## Acceptance Criteria
1. [x] An .xlsx without caption reaches the Orca bot as a saved file path with its original name; with a caption, the caption is the text and the file is attached. Also tested: .pdf and .docx.
2. [x] Over 20 MB: one plain reply, no dispatch, no download.
3. [x] Saved name is sanitized and stays in the files dir (a `../x` name cannot escape); 24 h cleanup.
4. [x] Logs carry ext and size, not the file name.
5. [x] Groups follow the same addressing rules as images.
6. [x] `Project: Telegram: roadmap` is not renamed; `your owner's agent: Telegram: hi` and `Telegram: hi` are.
7. [x] test (263), check, validate pass; tsc no new error.
