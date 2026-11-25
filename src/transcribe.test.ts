import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { assert, test } from 'orca/testing'
import { transcribeAudio, TranscriptionError, type TranscribeParams } from './transcribe'

type Seen = { path: string; auth: string; contentType: string; body: string }

const KEY = 'sk-test-SECRETKEY987654321'

// One local server per test: answers every request with `status` and `body`, records what it saw.
async function withServer(
  status: number,
  body: string,
  run: (baseUrl: string, seen: Seen[]) => Promise<void>
): Promise<void> {
  const seen: Seen[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      seen.push({
        path: req.url ?? '',
        auth: req.headers.authorization ?? '',
        contentType: req.headers['content-type'] ?? '',
        body: Buffer.concat(chunks).toString('latin1')
      })
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(body)
    })
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen)
  } finally {
    const closed = Promise.withResolvers<void>()
    server.close(() => closed.resolve())
    await closed.promise
  }
}

function params(baseUrl: string, overrides: Partial<TranscribeParams> = {}): TranscribeParams {
  return {
    provider: 'openai',
    model: '',
    apiKey: KEY,
    audio: Buffer.from('OggS-fake-opus'),
    fileName: 'voice.ogg',
    mimeType: 'audio/ogg',
    timeoutMs: 5000,
    baseUrl,
    ...overrides
  }
}

// The value of one multipart text field.
function field(body: string, name: string): string | undefined {
  return new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`).exec(body)?.[1]
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (err) {
    return err
  }
  throw new Error('expected a rejection')
}

test('an OpenAI request posts the model, response_format=json, the Bearer key and the audio file', async () => {
  await withServer(200, '{"text":" hello there "}', async (baseUrl, seen) => {
    const text = await transcribeAudio(params(baseUrl))
    assert.equal(text, 'hello there')
    assert.equal(seen[0].path, '/v1/audio/transcriptions')
    assert.equal(seen[0].auth, `Bearer ${KEY}`)
    assert.match(seen[0].contentType, /^multipart\/form-data; boundary=/)
    assert.equal(field(seen[0].body, 'model'), 'gpt-transcribe')
    assert.equal(field(seen[0].body, 'response_format'), 'json')
    assert.match(seen[0].body, /name="file"; filename="voice\.ogg"\r\nContent-Type: audio\/ogg\r\n\r\nOggS-fake-opus\r\n/)
  })
})

test('an OpenRouter request goes to its own path with the chosen model', async () => {
  await withServer(200, '{"text":"ok"}', async (baseUrl, seen) => {
    await transcribeAudio(params(baseUrl, { provider: 'openrouter', model: 'openai/whisper-large-v3-turbo' }))
    assert.equal(seen[0].path, '/api/v1/audio/transcriptions')
    assert.equal(field(seen[0].body, 'model'), 'openai/whisper-large-v3-turbo')
  })
  await withServer(200, '{"text":"ok"}', async (baseUrl, seen) => {
    await transcribeAudio(params(baseUrl, { provider: 'openrouter' }))
    assert.equal(field(seen[0].body, 'model'), 'openai/whisper-large-v3')
  })
})

test('a 401 becomes a TranscriptionError with status 401, the provider reason and no key', async () => {
  const body = JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } })
  await withServer(401, body, async (baseUrl) => {
    const err = await rejection(transcribeAudio(params(baseUrl)))
    assert.ok(err instanceof TranscriptionError, 'not a TranscriptionError')
    if (!(err instanceof TranscriptionError)) return
    assert.equal(err.status, 401)
    assert.match(err.message, /^OpenAI error 401: Incorrect API key provided/)
    assert.ok(!err.message.includes(KEY), 'the error message holds the key')
  })
})

test('an answer that is not JSON, or has no text, is an error rather than an empty transcript', async () => {
  for (const body of ['<html>Bad gateway</html>', '{"result":"hi"}', 'null']) {
    await withServer(200, body, async (baseUrl) => {
      const err = await rejection(transcribeAudio(params(baseUrl)))
      assert.ok(err instanceof TranscriptionError, `not a TranscriptionError for ${body}`)
    })
  }
})
