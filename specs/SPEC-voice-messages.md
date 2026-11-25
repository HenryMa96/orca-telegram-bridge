# SPEC: Voice messages (transcription per bridge)

**Date:** 2026-11-25
**Status:** implemented in 0.6.0 (providers OpenRouter + OpenAI, everything per bridge, no transcript echo, voice + audio files)

## Goal
Telegram voice messages (and audio files) are ignored today: Orca bots run agent CLIs that take
text only, so the plugin must transcribe the audio and send the text. Each bridge can turn this on
and choose its own provider, model and API key.

## Behavior
- A bridge with **Voice messages** on transcribes an incoming `voice` (OGG/Opus) or `audio`
  (mp3, m4a, ogg, wav, flac, webm…) message, then dispatches the text like a typed message,
  prefixed `[Voice message, transcribed]` (a caption, when present, comes first).
- Provider endpoints, both OpenAI-compatible `POST …/audio/transcriptions` (multipart, `file` + `model`,
  `response_format=json`), both accept `ogg` as sent by Telegram:
  - OpenRouter: `https://openrouter.ai/api/v1/audio/transcriptions`, default model `openai/whisper-large-v3`.
  - OpenAI: `https://api.openai.com/v1/audio/transcriptions`, default model `gpt-transcribe`
    (`whisper-1` shuts down 2027-02-26).
  - No language hint is sent (auto-detect; the two APIs name the field differently).
- The bridge's HTTP proxy, when set, is used for the transcription call too.
- Voice off, or on without an API key: the sender gets a short localized reply that voice
  messages are not enabled for this bot; nothing reaches the Orca bot.
- Transcription failure (HTTP error, timeout, empty text, file over 20 MB, Telegram's download cap for bots): a short localized
  reply with the reason, a warn log with details; nothing reaches the Orca bot.
- No transcript echo to Telegram. The transcript is never logged (only duration, bytes, model, ms).
- The API key is a secret (`voiceKey.<bridgeId>`), redacted from logs/exports like the bot token,
  deleted when the bridge is removed.
- Access rules, group rules and the per-chat queue apply exactly as for text.

## API / Interface
- `BridgeConfig`: `voiceEnabled`, `voiceProvider: 'openrouter' | 'openai'`, `voiceModel` (''
  = provider default), `hasVoiceKey`.
- `SaveConfigInput`: optional `voiceEnabled`, `voiceProvider`, `voiceModel`, `voiceApiKey`
  (empty keeps the saved key), `clearVoiceKey`.
- Defaults for new, migrated and older stored bridges: off, `openrouter`, `''`, no key.

## Acceptance Criteria
1. [x] A voice message on a bridge with voice on reaches its Orca bot as the transcribed text. (worker tests, fake transcriber)
2. [x] OpenRouter and OpenAI requests go to the right URL with the right model and key. (transcribe tests, local server)
3. [x] Voice off / no key / provider error: the sender gets a clear reply; nothing is dispatched.
4. [x] The voice API key never appears in logs, exports or panel state.
5. [x] Panel: the voice options appear only while the switch is on; Save sends them.
6. [x] `orca plugin test` (151) and `orca plugin check` pass; tsc shows no new error (12 older type-only errors remain).

## Out of Scope
- Video notes, Groq, local servers, transcript echo, text-to-speech replies.
