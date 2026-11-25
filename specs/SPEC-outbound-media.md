# SPEC: Orca bot → Telegram images and documents

**Date:** 2026-11-25
**Status:** implemented in 0.7.0 (images + documents from any folder when restricted, https URLs always)

## Goal
Orca bots can only answer in text: `orca agent read` entries are `message | tool | approval |
question | error`, with no attachment kind, and the plugin sends replies as text (tables become PNGs).
A real chat showed an Orca bot render a CPU chart and then say "this channel only carries text".
This feature lets an Orca bot attach images and documents to its Telegram reply.

## Behavior
- The handoff body sent to the Orca bot gains one instruction: to send an image or file to the
  Telegram user, put it on its own line as Markdown `![short caption](absolute local path or https URL)`.
- In every reply that goes to Telegram (dispatch replies and Orca → Telegram sync), the plugin finds
  `![caption](target)` references, removes them from the text, sends the text as today, then sends
  each attachment in order, captioned (caption cut to Telegram's 1024 chars).
- Order: media references are taken out of the reply first; table rendering and the HTML conversion
  run on the cleaned text (also the table fallback), so a media line never comes back as text.
- Local files are sent only when the bridge has a restricted allowlist (same rule as Orca → Telegram
  sync and group "All messages"); while open to everyone, local references get one localized line
  instead. https URLs are allowed in both modes. Telegram failure lines show only the file name.
- Local file targets: absolute paths (Windows `C:\…`/`C:/…`, POSIX `/…`, `file://` URLs, `~/` expanded),
  angle-bracket targets `<…>` allowed for paths with spaces.
  - Images: PNG, JPEG, GIF, WEBP, verified by file signature (magic bytes), not by extension alone.
    Sent with `sendPhoto` (≤ 10 MB, content type from the signature); a photo Telegram rejects (size/dimensions) is retried with `sendDocument`.
  - Documents: extensions pdf, csv, tsv, txt, md, xlsx, xls, docx, doc, pptx, ppt, odt, ods, odp,
    sent with `sendDocument` (≤ 50 MB).
  - Always refused, whatever the extension: files under `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`,
    `.docker`, `.config/gcloud`; names starting with `.env`; symlinks are resolved first and the real
    path is checked.
  - Missing, unreadable, too large, not allowed: the reference stays out of the text and the user
    gets one localized line per failed attachment (`Could not attach <name>: <reason>`); warn log
    with details (path shown only as its file name in Telegram, full path in logs).
- https URL targets: sent by URL (`sendPhoto` for image extensions, `sendDocument` otherwise); Telegram
  downloads them, nothing leaves the computer (Telegram limits: photo by URL 5 MB, document by URL 20 MB;
  a photo URL Telegram rejects is retried as a document). `http:` and other schemes are left as text.
- Relative paths and Markdown links without `!` are left untouched (regular text/links).
- Tables-as-images keep working; attachments come after the table images.

## Acceptance Criteria
1. [x] A reply with `![CPU](C:\…\cpu.png)` sends the text without that line, then the PNG as a photo with caption "CPU".
2. [x] A PDF/CSV reference is sent as a document; an `id_rsa`/`.env`/`.ssh/…` reference is refused with a reply line.
3. [x] A file named `.png` that is not a PNG is refused (signature check).
4. [x] An https image URL is sent by URL; an http URL stays as text.
5. [x] The handoff instruction mentions the syntax; the echo/dedupe marker regex still matches.
6. [x] `orca plugin test` (171) and `orca plugin check` pass; tsc shows no new error (12 older type-only errors remain).

## Out of Scope
- Sending Orca chat images that are not referenced in the reply text; videos/audio replies; albums.
