// Speech-to-text for Telegram voice messages. OpenRouter and OpenAI both speak OpenAI's
// multipart `POST /audio/transcriptions` and answer `{ text }`.
import http from 'node:http'
import https from 'node:https'
import type { VoiceProvider } from './protocol'
import { createProxyAgent, resolveProxyUrl } from './telegram-api'

export const DEFAULT_VOICE_MODELS: Record<VoiceProvider, string> = {
  openrouter: 'openai/whisper-large-v3',
  openai: 'gpt-transcribe'
}

const PROVIDER_URLS: Record<VoiceProvider, string> = {
  openrouter: 'https://openrouter.ai/api/v1/audio/transcriptions',
  openai: 'https://api.openai.com/v1/audio/transcriptions'
}

// The smaller of the two providers' upload limits.
export const MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024

export class TranscriptionError extends Error {
  // HTTP status, or 0 for transport errors, timeouts and unreadable answers.
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'TranscriptionError'
    this.status = status
  }
}

export type TranscribeParams = {
  provider: VoiceProvider
  // '' uses the provider's default model.
  model: string
  apiKey: string
  audio: Buffer
  fileName: string
  mimeType: string
  proxyUrl?: string
  timeoutMs: number
  signal?: AbortSignal
  // Replaces the provider's origin (scheme + host + port), for tests.
  baseUrl?: string
}

export type Transcriber = (params: TranscribeParams) => Promise<string>

function providerUrl(provider: VoiceProvider, baseUrl?: string): URL {
  const url = new URL(PROVIDER_URLS[provider])
  if (!baseUrl) return url
  const base = new URL(baseUrl)
  return new URL(`${url.pathname}${url.search}`, base.origin)
}

function multipartBody(
  fields: Record<string, string>,
  file: { field: string; fileName: string; mimeType: string; data: Buffer }
): { body: Buffer; contentType: string } {
  const boundary = `----OrcaTgVoice${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const chunks: Buffer[] = []
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'))
  }
  const fileName = file.fileName.replace(/["\r\n\\]/g, '_')
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${fileName}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`,
      'utf8'
    )
  )
  chunks.push(file.data)
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'))
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` }
}

// A short reason from a provider's error body: `{ error: { message } }`, `{ error: "..." }` or `{ message }`.
function providerMessage(raw: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw.replace(/\s+/g, ' ').trim()
  }
  if (parsed && typeof parsed === 'object') {
    const err = 'error' in parsed ? parsed.error : undefined
    if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string') return err.message
    if (typeof err === 'string') return err
    if ('message' in parsed && typeof parsed.message === 'string') return parsed.message
  }
  return raw.replace(/\s+/g, ' ').trim()
}

function scrub(text: string, apiKey: string): string {
  const short = text.slice(0, 200)
  return apiKey ? short.split(apiKey).join('<redacted>') : short
}

export function transcribeAudio(params: TranscribeParams): Promise<string> {
  const { provider, apiKey, timeoutMs, signal } = params
  const model = params.model.trim() || DEFAULT_VOICE_MODELS[provider]
  const url = providerUrl(provider, params.baseUrl)
  const fields: Record<string, string> = { model, response_format: 'json' }
  const { body, contentType } = multipartBody(fields, {
    field: 'file',
    fileName: params.fileName,
    mimeType: params.mimeType,
    data: params.audio
  })
  const secure = url.protocol === 'https:'
  const proxyUrl = secure ? resolveProxyUrl(params.proxyUrl) : undefined
  const label = provider === 'openai' ? 'OpenAI' : 'OpenRouter'

  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new TranscriptionError('Transcription aborted', 0))
      return
    }
    let agent: https.Agent | undefined
    try {
      agent = proxyUrl ? createProxyAgent(proxyUrl, timeoutMs, signal) : undefined
    } catch (err) {
      reject(new TranscriptionError(err instanceof Error ? err.message : String(err), 0))
      return
    }
    // Plain http only for a test server's baseUrl.
    const request: typeof http.request = secure ? https.request : http.request
    const req = request(
      {
        hostname: url.hostname,
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        agent,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': contentType,
          'Content-Length': body.length
        }
      },
      (res) => {
        const status = res.statusCode ?? 0
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('error', (err) => reject(new TranscriptionError(`${label} response error: ${err.message}`, status)))
        res.on('close', () => {
          if (!res.complete) reject(new TranscriptionError(`${label} closed the connection early`, status))
        })
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          if (status < 200 || status >= 300) {
            const reason = scrub(providerMessage(raw), apiKey)
            reject(new TranscriptionError(`${label} error ${status}${reason ? `: ${reason}` : ''}`, status))
            return
          }
          let parsed: unknown
          try {
            parsed = JSON.parse(raw)
          } catch {
            reject(new TranscriptionError(`${label} returned no JSON: ${scrub(raw, apiKey)}`, status))
            return
          }
          const text = parsed && typeof parsed === 'object' && 'text' in parsed ? parsed.text : undefined
          if (typeof text !== 'string') {
            reject(new TranscriptionError(`${label} returned no text`, status))
            return
          }
          resolve(text.trim())
        })
      }
    )

    const fail = (err: TranscriptionError) => {
      reject(err)
      req.destroy(err)
    }
    const onAbort = () => fail(new TranscriptionError('Transcription aborted', 0))
    signal?.addEventListener('abort', onAbort, { once: true })
    req.setTimeout(timeoutMs, () => fail(new TranscriptionError(`${label} timed out after ${timeoutMs} ms`, 0)))
    req.on('error', (err) => {
      reject(err instanceof TranscriptionError ? err : new TranscriptionError(`${label} request failed: ${err.message}`, 0))
    })
    req.on('close', () => signal?.removeEventListener('abort', onAbort))
    req.end(body)
  })
}
