import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { URL } from 'node:url'

export type TelegramUser = {
  id: number
  is_bot: boolean
  first_name: string
  username?: string
}

export type TelegramChat = {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
  title?: string
  username?: string
  first_name?: string
}

export type TelegramPhotoSize = {
  file_id: string
  file_unique_id: string
  width: number
  height: number
  file_size?: number
}

export type TelegramDocument = {
  file_id: string
  file_unique_id: string
  file_name?: string
  mime_type?: string
  file_size?: number
}

export type TelegramFile = {
  file_id: string
  file_unique_id: string
  file_size?: number
  file_path?: string
}

export type TelegramMessage = {
  message_id: number
  from?: TelegramUser
  chat: TelegramChat
  date: number
  text?: string
  caption?: string
  photo?: TelegramPhotoSize[]
  document?: TelegramDocument
}

export type TelegramUpdate = {
  update_id: number
  message?: TelegramMessage
}

export type TelegramRequestOptions = {
  proxyUrl?: string
  timeoutMs?: number
  signal?: AbortSignal
}

export class TelegramApiError extends Error {
  readonly statusCode: number
  readonly retryable: boolean

  constructor(message: string, statusCode = 0, retryable = false) {
    super(message)
    this.name = 'TelegramApiError'
    this.statusCode = statusCode
    this.retryable = retryable
  }
}

export type TelegramBotCommand = {
  command: string
  description: string
}

export interface TelegramClient {
  getMe(token: string, options?: TelegramRequestOptions): Promise<TelegramUser>
  setMyCommands(
    token: string,
    commands: TelegramBotCommand[],
    options?: TelegramRequestOptions
  ): Promise<boolean>
  getUpdates(
    token: string,
    params: { offset?: number; timeoutSec?: number },
    options?: TelegramRequestOptions
  ): Promise<TelegramUpdate[]>
  sendMessage(
    token: string,
    params: {
      chatId: number | string
      text: string
      replyToMessageId?: number
      parseMode?: 'Markdown' | 'HTML'
    },
    options?: TelegramRequestOptions
  ): Promise<TelegramMessage>
  sendPhoto(
    token: string,
    params: {
      chatId: number | string
      photo: Buffer
      filename?: string
      caption?: string
      replyToMessageId?: number
    },
    options?: TelegramRequestOptions
  ): Promise<TelegramMessage>
  sendChatAction(
    token: string,
    params: { chatId: number | string; action: 'typing' },
    options?: TelegramRequestOptions
  ): Promise<boolean>
  getFile(
    token: string,
    fileId: string,
    options?: TelegramRequestOptions
  ): Promise<TelegramFile>
  downloadFile(
    token: string,
    filePath: string,
    options?: TelegramRequestOptions
  ): Promise<Buffer>
}

export function resolveProxyUrl(explicitProxy?: string): string | undefined {
  const trimmed = explicitProxy?.trim()
  if (trimmed) return trimmed
  const envProxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy
  return envProxy?.trim() || undefined
}

function createProxyAgent(proxyUrl: string): https.Agent {
  const parsed = new URL(proxyUrl)
  const proxyHost = parsed.hostname
  const proxyPort = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
  const authHeader =
    parsed.username || parsed.password
      ? 'Basic ' +
        Buffer.from(
          `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`
        ).toString('base64')
      : undefined

  class HttpConnectAgent extends https.Agent {
    createConnection(
      options: https.RequestOptions,
      callback: (err: Error | null, socket?: tls.TLSSocket) => void
    ): void {
      const targetHost = options.host || 'api.telegram.org'
      const targetPort = Number(options.port || 443)
      const headers: Record<string, string> = {
        Host: `${targetHost}:${targetPort}`
      }
      if (authHeader) {
        headers['Proxy-Authorization'] = authHeader
      }

      const connectReq = http.request({
        host: proxyHost,
        port: proxyPort,
        method: 'CONNECT',
        path: `${targetHost}:${targetPort}`,
        headers
      })

      let settled = false
      const done = (err: Error | null, socket?: tls.TLSSocket) => {
        if (settled) return
        settled = true
        callback(err, socket)
      }

      connectReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy()
          done(new TelegramApiError(`Proxy CONNECT failed with status ${res.statusCode}`, res.statusCode ?? 0, true))
          return
        }
        const tlsSocket = tls.connect({
          socket,
          servername: targetHost
        })
        tlsSocket.once('error', (err) => done(err))
        done(null, tlsSocket)
      })

      connectReq.on('error', (err) => {
        done(new TelegramApiError(`Proxy connection error: ${err.message}`, 0, true))
      })

      connectReq.end()
    }
  }

  return new HttpConnectAgent({ keepAlive: false })
}

async function callTelegramApi<T>(
  token: string,
  method: string,
  payload?: Record<string, unknown>,
  options: TelegramRequestOptions = {}
): Promise<T> {
  const bodyText = payload ? JSON.stringify(payload) : undefined
  return sendTelegramHttp<T>(
    token,
    method,
    payload ? 'POST' : 'GET',
    bodyText ? Buffer.from(bodyText, 'utf8') : undefined,
    bodyText ? { 'Content-Type': 'application/json' } : undefined,
    options
  )
}

async function sendTelegramMultipart<T>(
  token: string,
  method: string,
  fields: Record<string, string>,
  file: { field: string; filename: string; contentType: string; data: Buffer },
  options: TelegramRequestOptions = {}
): Promise<T> {
  const boundary = `----OrcaTgBridge${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const chunks: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
        'utf8'
      )
    )
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
      'utf8'
    )
  )
  chunks.push(file.data)
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'))
  const body = Buffer.concat(chunks)

  return sendTelegramHttp<T>(
    token,
    method,
    'POST',
    body,
    { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    options
  )
}

async function sendTelegramHttp<T>(
  token: string,
  method: string,
  httpMethod: 'GET' | 'POST',
  bodyBuf: Buffer | undefined,
  extraHeaders: Record<string, string> | undefined,
  options: TelegramRequestOptions = {}
): Promise<T> {
  const proxyUrl = resolveProxyUrl(options.proxyUrl)
  const timeoutMs = options.timeoutMs ?? 20_000
  const headers: Record<string, string | number> | undefined = bodyBuf
    ? { ...(extraHeaders ?? {}), 'Content-Length': bodyBuf.length }
    : extraHeaders

  return new Promise<T>((resolve, reject) => {
    const agent = proxyUrl ? createProxyAgent(proxyUrl) : undefined
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${token}/${method}`,
        method: httpMethod,
        agent,
        headers
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let parsed: { ok?: boolean; result?: T; description?: string; error_code?: number }
          try {
            parsed = JSON.parse(raw) as typeof parsed
          } catch {
            reject(
              new TelegramApiError(
                `Invalid JSON from Telegram (${res.statusCode ?? 0}): ${raw.slice(0, 200)}`,
                res.statusCode ?? 0,
                (res.statusCode ?? 0) >= 500
              )
            )
            return
          }

          if (!parsed.ok || parsed.result === undefined) {
            const code = parsed.error_code ?? res.statusCode ?? 0
            const retryable = code === 429 || code >= 500
            reject(
              new TelegramApiError(
                parsed.description || `Telegram API error ${code}`,
                code,
                retryable
              )
            )
            return
          }
          resolve(parsed.result)
        })
      }
    )

    const onAbort = () => {
      req.destroy(new TelegramApiError('Request aborted', 0, false))
    }

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort()
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    req.setTimeout(timeoutMs, () => {
      req.destroy(new TelegramApiError(`Telegram request timed out after ${timeoutMs}ms`, 0, true))
    })

    req.on('error', (err) => {
      options.signal?.removeEventListener('abort', onAbort)
      if (err instanceof TelegramApiError) {
        reject(err)
      } else {
        reject(new TelegramApiError(err.message, 0, true))
      }
    })

    req.on('close', () => {
      options.signal?.removeEventListener('abort', onAbort)
    })

    if (bodyBuf) {
      req.write(bodyBuf)
    }
    req.end()
  })
}

const MAX_TELEGRAM_DOWNLOAD_BYTES = 20 * 1024 * 1024

async function downloadTelegramFileBytes(
  token: string,
  filePath: string,
  options: TelegramRequestOptions = {}
): Promise<Buffer> {
  const cleanPath = filePath.replace(/^\/+/, '')
  if (!cleanPath || cleanPath.includes('..')) {
    throw new TelegramApiError('Invalid Telegram file path', 400, false)
  }

  const proxyUrl = resolveProxyUrl(options.proxyUrl)
  const timeoutMs = options.timeoutMs ?? 30_000

  return new Promise<Buffer>((resolve, reject) => {
    const agent = proxyUrl ? createProxyAgent(proxyUrl) : undefined
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/file/bot${token}/${cleanPath}`,
        method: 'GET',
        agent
      },
      (res) => {
        const status = res.statusCode ?? 0
        const chunks: Buffer[] = []
        let total = 0
        res.on('data', (chunk: Buffer) => {
          total += chunk.length
          if (total > MAX_TELEGRAM_DOWNLOAD_BYTES) {
            req.destroy(new TelegramApiError('Telegram file exceeds 20 MB limit', 413, false))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          if (status < 200 || status >= 300) {
            reject(
              new TelegramApiError(
                `Failed downloading Telegram file (${status})`,
                status,
                status >= 500
              )
            )
            return
          }
          resolve(Buffer.concat(chunks))
        })
      }
    )

    const onAbort = () => {
      req.destroy(new TelegramApiError('Request aborted', 0, false))
    }

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort()
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    req.setTimeout(timeoutMs, () => {
      req.destroy(new TelegramApiError(`Telegram file download timed out after ${timeoutMs}ms`, 0, true))
    })

    req.on('error', (err) => {
      options.signal?.removeEventListener('abort', onAbort)
      if (err instanceof TelegramApiError) {
        reject(err)
      } else {
        reject(new TelegramApiError(err.message, 0, true))
      }
    })

    req.on('close', () => {
      options.signal?.removeEventListener('abort', onAbort)
    })

    req.end()
  })
}

export function createTelegramClient(): TelegramClient {
  return {
    getMe(token, options) {
      return callTelegramApi<TelegramUser>(token, 'getMe', undefined, options)
    },
    setMyCommands(token, commands, options) {
      return callTelegramApi<boolean>(token, 'setMyCommands', { commands }, options)
    },
    getUpdates(token, params, options) {
      const timeoutSec = params.timeoutSec ?? 25
      return callTelegramApi<TelegramUpdate[]>(
        token,
        'getUpdates',
        {
          offset: params.offset,
          timeout: timeoutSec,
          allowed_updates: ['message']
        },
        {
          ...options,
          timeoutMs: options?.timeoutMs ?? (timeoutSec + 15) * 1000
        }
      )
    },
    sendMessage(token, params, options) {
      const body: Record<string, unknown> = {
        chat_id: params.chatId,
        text: params.text
      }
      if (params.replyToMessageId !== undefined) {
        body.reply_to_message_id = params.replyToMessageId
      }
      if (params.parseMode) {
        body.parse_mode = params.parseMode
      }
      body.disable_web_page_preview = true
      return callTelegramApi<TelegramMessage>(token, 'sendMessage', body, options)
    },
    sendPhoto(token, params, options) {
      const fields: Record<string, string> = {
        chat_id: String(params.chatId)
      }
      if (params.caption) fields.caption = params.caption
      if (params.replyToMessageId !== undefined) {
        fields.reply_to_message_id = String(params.replyToMessageId)
      }
      return sendTelegramMultipart<TelegramMessage>(
        token,
        'sendPhoto',
        fields,
        {
          field: 'photo',
          filename: params.filename || 'table.png',
          contentType: 'image/png',
          data: params.photo
        },
        { ...options, timeoutMs: options?.timeoutMs ?? 25_000 }
      )
    },
    sendChatAction(token, params, options) {
      return callTelegramApi<boolean>(
        token,
        'sendChatAction',
        { chat_id: params.chatId, action: params.action },
        options
      )
    },
    getFile(token, fileId, options) {
      return callTelegramApi<TelegramFile>(
        token,
        'getFile',
        { file_id: fileId },
        { ...options, timeoutMs: options?.timeoutMs ?? 15_000 }
      )
    },
    downloadFile(token, filePath, options) {
      return downloadTelegramFileBytes(token, filePath, options)
    }
  }
}

export function splitTelegramMessage(text: string, maxLen = 4000): string[] {
  const normalized = text.trim()
  if (!normalized) return ['(empty reply)']
  if (normalized.length <= maxLen) return [normalized]

  const chunks: string[] = []
  let remaining = normalized
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf('\n\n', maxLen)
    if (cut < Math.floor(maxLen * 0.4)) {
      cut = remaining.lastIndexOf('\n', maxLen)
    }
    if (cut < Math.floor(maxLen * 0.4)) {
      cut = remaining.lastIndexOf(' ', maxLen)
    }
    if (cut < Math.floor(maxLen * 0.2)) {
      cut = maxLen
    }
    chunks.push(remaining.slice(0, cut).trimEnd())
    remaining = remaining.slice(cut).trimStart()
  }
  if (remaining) {
    chunks.push(remaining)
  }
  return chunks
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function displayWidth(str: string): number {
  let w = 0
  for (const ch of str) {
    const cp = ch.codePointAt(0) ?? 0
    w += cp >= 0x1100 ? 2 : 1
  }
  return w
}

function padDisplayEnd(str: string, targetWidth: number): string {
  const diff = targetWidth - displayWidth(str)
  return diff > 0 ? str + ' '.repeat(diff) : str
}

function stripInlineMd(str: string): string {
  return str
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .trim()
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((c) => c.trim())
}

function isTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return false
  const cells = splitTableRow(trimmed)
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c))
}

function formatInlineText(
  escapedText: string,
  stash: (html: string) => string
): string {
  let out = escapedText
  // Links [label](https://...) -> stash anchor so URL chars aren't mangled
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) => {
    return stash(`<a href="${url.replace(/"/g, '&quot;')}">${label}</a>`)
  })
  // Bold + Italic ***text***
  out = out.replace(/\*\*\*([^*\n]+?)\*\*\*/g, '<b><i>$1</i></b>')
  // Bold **text**
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>')
  // Italic *text* (only when non-space inside bounds, avoiding bullet/math asterisks)
  out = out.replace(/(?<!\*)\*([^\s*\n](?:[^\n*]*[^\s*\n])?)\*(?!\*)/g, '<i>$1</i>')
  // Strikethrough ~~text~~
  out = out.replace(/~~([^~\n]+?)~~/g, '<s>$1</s>')
  return out
}

function formatMarkdownTable(
  headers: string[],
  rows: string[][],
  stash: (html: string) => string
): string {
  const plainHeaders = headers.map(stripInlineMd)
  const plainRows = rows.map((r) => headers.map((_, i) => stripInlineMd(r[i] ?? '')))

  const colWidths = plainHeaders.map((h, i) =>
    Math.max(displayWidth(h), ...plainRows.map((r) => displayWidth(r[i] ?? '')))
  )
  const totalWidth = colWidths.reduce((a, b) => a + b, 0) + Math.max(0, colWidths.length - 1) * 3

  if (headers.length <= 3 && totalWidth <= 38) {
    const headerLine = plainHeaders.map((h, i) => padDisplayEnd(h, colWidths[i])).join(' │ ')
    const sepLine = colWidths.map((w) => '─'.repeat(w)).join('─┼─')
    const bodyLines = plainRows.map((r) =>
      r.map((cell, i) => padDisplayEnd(cell, colWidths[i])).join(' │ ')
    )
    const tableText = [headerLine, sepLine, ...bodyLines].join('\n')
    return stash(`<pre><code>${escapeHtml(tableText)}</code></pre>`)
  }

  // Mobile-friendly card list for wider tables so lines never wrap broken box borders.
  const cards = rows.map((row) => {
    const firstRaw = row[0] ?? ''
    const firstHtml = formatInlineCell(firstRaw, stash)
    const restParts: string[] = []
    for (let i = 1; i < headers.length; i++) {
      const val = (row[i] ?? '').trim()
      if (!val) continue
      const hEsc = escapeHtml(plainHeaders[i] || `Col ${i + 1}`)
      restParts.push(`${hEsc}: ${formatInlineCell(val, stash)}`)
    }
    return restParts.length > 0
      ? `• <b>${firstHtml}</b>\n  ${restParts.join(' ｜ ')}`
      : `• <b>${firstHtml}</b>`
  })
  return stash(cards.join('\n'))
}

function formatInlineCell(raw: string, stash: (html: string) => string): string {
  const localText = raw.replace(/`([^`\n]+)`/g, (_m, code: string) =>
    stash(`<code>${escapeHtml(code)}</code>`)
  )
  return formatInlineText(escapeHtml(localText), stash)
}

export function markdownToTelegramHtml(md: string): string {
  const placeholders: string[] = []
  const stash = (html: string): string => {
    const idx = placeholders.length
    placeholders.push(html)
    return `\u0000TGPH_${idx}\u0000`
  }

  // 1. Protect fenced code blocks first (preserving optional language tag).
  let text = md.replace(
    /```([a-zA-Z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)```/g,
    (_m, lang: string, code: string) => {
      const cleanCode = escapeHtml(code.replace(/\r?\n$/, ''))
      const cleanLang = lang.trim()
      if (cleanLang) {
        return stash(`<pre><code class="language-${escapeHtml(cleanLang)}">${cleanCode}</code></pre>`)
      }
      return stash(`<pre><code>${cleanCode}</code></pre>`)
    }
  )

  // 2. Convert GFM Markdown tables into narrow aligned <pre> or mobile-friendly structured cards.
  const lines = text.split(/\r?\n/)
  const tableProcessed: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const nextLine = lines[i + 1]
    if (line.includes('|') && nextLine !== undefined && isTableSeparatorLine(nextLine)) {
      const headers = splitTableRow(line)
      const rows: string[][] = []
      let j = i + 2
      while (
        j < lines.length &&
        lines[j].trim().includes('|') &&
        !lines[j].trim().startsWith('```') &&
        !(lines[j + 1] !== undefined && isTableSeparatorLine(lines[j + 1]))
      ) {
        rows.push(splitTableRow(lines[j]))
        j++
      }
      tableProcessed.push(formatMarkdownTable(headers, rows, stash))
      i = j - 1
      continue
    }
    tableProcessed.push(line)
  }
  text = tableProcessed.join('\n')

  // 3. Protect inline code spans.
  text = text.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    return stash(`<code>${escapeHtml(code)}</code>`)
  })

  // 4. Escape remaining HTML characters.
  text = escapeHtml(text)

  // 5. Block-level formatting (blockquotes, headings, dividers, task lists, bullets).
  const outLines: string[] = []
  const rawLines = text.split('\n')
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]
    if (/^&gt;(?: |$)/.test(line)) {
      const quoteLines: string[] = []
      let j = i
      while (j < rawLines.length && /^&gt;(?: |$)/.test(rawLines[j])) {
        quoteLines.push(rawLines[j].replace(/^&gt; ?/, ''))
        j++
      }
      outLines.push(`<blockquote>${formatInlineText(quoteLines.join('\n'), stash)}</blockquote>`)
      i = j - 1
      continue
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      outLines.push('──────────')
      continue
    }

    const headingMatch = line.match(/^#{1,6}\s+(.+)$/)
    if (headingMatch) {
      outLines.push(`<b>${formatInlineText(headingMatch[1], stash)}</b>`)
      continue
    }

    const taskMatch = line.match(/^(\s*)[-*]\s+\[([ xX]?)\]\s+(.+)$/)
    if (taskMatch) {
      const icon = taskMatch[2].toLowerCase() === 'x' ? '✅' : '⬜'
      const indent = taskMatch[1].length >= 2 ? '  ' : ''
      outLines.push(`${indent}${icon} ${formatInlineText(taskMatch[3], stash)}`)
      continue
    }

    const bulletMatch = line.match(/^(\s*)[-*]\s+(.+)$/)
    if (bulletMatch) {
      const indent = bulletMatch[1].length >= 2 ? '  ◦ ' : '• '
      outLines.push(`${indent}${formatInlineText(bulletMatch[2], stash)}`)
      continue
    }

    outLines.push(formatInlineText(line, stash))
  }

  text = outLines.join('\n')

  // 6. Restore stashed blocks in reverse order (nested stashes resolve cleanly).
  for (let pass = 0; pass < 3 && text.includes('\u0000TGPH_'); pass++) {
    text = text.replace(/\u0000TGPH_(\d+)\u0000/g, (_m, idx: string) => placeholders[Number(idx)] ?? '')
  }
  return text
}
