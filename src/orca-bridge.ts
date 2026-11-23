import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BotSummary } from './protocol'

export type OrcaChatSummary = {
  id: string
  title: string
  lastActivityAt: number
  lastAsked: string | null
  lastSaid: string | null
  home: boolean
  self: boolean
  closed: boolean
}

export type OrcaSessionEntry = {
  kind: string
  role?: 'user' | 'assistant' | 'system'
  text?: string
}

export type OrcaSessionRead = {
  orcaSessionId: string
  state?: string
  entries: OrcaSessionEntry[]
  limited?: boolean
}

export interface OrcaCliRunner {
  listBots(): Promise<BotSummary[]>
  listBotChats(botName: string): Promise<OrcaChatSummary[]>
  readSession(sessionId: string, limit?: number): Promise<OrcaSessionRead>
  sendToBot(params: {
    botName: string
    chatId: string | 'new'
    subject: string
    body: string
    signal?: AbortSignal
  }): Promise<void>
}

function getOrcaBinary(): string {
  if (process.env.ORCA_CLI && fs.existsSync(process.env.ORCA_CLI)) {
    return process.env.ORCA_CLI
  }

  const exeDir = path.dirname(process.execPath)
  const home = os.homedir()
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(exeDir, 'resources', 'bin', 'orca.exe'),
          path.join(exeDir, '..', 'bin', 'orca.exe'),
          path.join(exeDir, '..', '..', 'resources', 'bin', 'orca.exe'),
          path.join(localAppData, 'Programs', 'orca', 'resources', 'bin', 'orca.exe')
        ]
      : [
          path.join(exeDir, 'resources', 'bin', 'orca'),
          path.join(exeDir, '..', 'Resources', 'bin', 'orca'),
          '/Applications/Orca.app/Contents/Resources/bin/orca',
          '/usr/local/bin/orca'
        ]

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate
    }
  }
  return 'orca'
}

function cleanOrcaEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.ORCA_SESSION_ID
  delete env.ORCA_RUN_ID
  delete env.ORCA_WORKTREE_ID
  delete env.ORCA_DISPATCH_ID
  delete env.ORCA_TASK_ID
  delete env.ORCA_TERMINAL_HANDLE

  const home = os.homedir()
  if (!env.HOME) env.HOME = home
  if (process.platform === 'win32') {
    if (!env.USERPROFILE) env.USERPROFILE = home
    if (!env.APPDATA) env.APPDATA = path.join(home, 'AppData', 'Roaming')
    if (!env.LOCALAPPDATA) env.LOCALAPPDATA = path.join(home, 'AppData', 'Local')
  }
  return env
}

export async function runOrcaJson<T>(
  args: string[],
  options: { stdinText?: string; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<T> {
  const bin = getOrcaBinary()
  const timeoutMs = options.timeoutMs ?? 30_000

  return new Promise<T>((resolve, reject) => {
    const child = spawn(bin, args, {
      env: cleanOrcaEnv(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let settled = false

    const finish = (err: Error | null, value?: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      if (err) reject(err)
      else resolve(value as T)
    }

    const onAbort = () => {
      child.kill()
      finish(new Error('Orca CLI command aborted'))
    }

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort()
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    const timer = setTimeout(() => {
      child.kill()
      finish(new Error(`Orca CLI timed out after ${timeoutMs}ms: orca ${args.join(' ')}`))
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
    child.on('error', (err) => finish(err))

    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim()
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim()

      if (stdout) {
        try {
          const parsed = JSON.parse(stdout) as {
            ok?: boolean
            result?: T
            error?: { message?: string; code?: string }
          }
          if (parsed.ok && parsed.result !== undefined) {
            finish(null, parsed.result)
            return
          }
          if (parsed.error?.message) {
            finish(new Error(parsed.error.message))
            return
          }
        } catch {
          // Fall through to generic exit-code error below.
        }
      }

      if (code === 0) {
        finish(new Error(`Unexpected non-JSON output from orca ${args[0]}: ${stdout.slice(0, 200)}`))
      } else {
        finish(new Error(stderr || stdout || `orca exited with code ${code}`))
      }
    })

    if (options.stdinText !== undefined) {
      child.stdin.write(options.stdinText, 'utf8')
    }
    child.stdin.end()
  })
}

export function createOrcaCliRunner(): OrcaCliRunner {
  return {
    async listBots() {
      const result = await runOrcaJson<{
        bots: { id: string; name: string; specialty?: string; agent?: string }[]
      }>(['bot', 'list', '--json'])
      return (result.bots || []).map((b) => ({
        id: b.id,
        name: b.name,
        specialty: b.specialty || '',
        agent: b.agent || 'claude'
      }))
    },
    async listBotChats(botName) {
      const result = await runOrcaJson<{ chats: OrcaChatSummary[] }>([
        'bot',
        'chats',
        '--bot',
        botName,
        '--json'
      ])
      return result.chats || []
    },
    async readSession(sessionId, limit = 40) {
      const id = sessionId.startsWith('orca_session_id:')
        ? sessionId
        : `orca_session_id:${sessionId}`
      return runOrcaJson<OrcaSessionRead>(['agent', 'read', id, '--limit', String(limit), '--json'])
    },
    async sendToBot({ botName, chatId, subject, body, signal }) {
      await runOrcaJson<unknown>(
        [
          'orchestration',
          'send',
          '--from',
          'plugin:telegram-bridge',
          '--to',
          `bot:${botName}`,
          '--chat',
          chatId,
          '--type',
          'handoff',
          '--subject',
          subject,
          '--body-file',
          '-',
          '--json'
        ],
        { stdinText: body, signal }
      )
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('Aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export type OrcaMessageItem = {
  role: 'user' | 'assistant'
  text: string
}

const TAIL_HASH_LIMIT = 20

export function extractMessageItems(entries: OrcaSessionEntry[]): OrcaMessageItem[] {
  const items: OrcaMessageItem[] = []
  for (const entry of entries) {
    if (
      entry.kind === 'message' &&
      (entry.role === 'user' || entry.role === 'assistant') &&
      entry.text?.trim()
    ) {
      items.push({ role: entry.role, text: entry.text.trim() })
    }
  }
  return items
}

export function hashMessageItem(item: OrcaMessageItem): string {
  return createHash('sha256')
    .update(`${item.role}\0${item.text}`, 'utf8')
    .digest('hex')
    .slice(0, 16)
}

export function computeTailHashes(items: OrcaMessageItem[], limit = TAIL_HASH_LIMIT): string[] {
  return items.slice(-limit).map(hashMessageItem)
}

export function isTelegramOriginatedUserMessage(text: string): boolean {
  return /^Telegram message from owner \([^)]+\) \[tg:[^:\]]+:\d+\]\./.test(text.trim())
}

/**
 * Aligns saved `tailHashes` against the current `items` window and returns any
 * messages appended after the aligned anchor.
 *
 * Returns `{ matched: false, unsynced: [] }` when `tailHashes` is empty or cannot
 * be aligned (so callers can re-baseline safely without flooding old history).
 */
export function findUnsyncedTail(
  items: OrcaMessageItem[],
  tailHashes: string[]
): { matched: boolean; unsynced: OrcaMessageItem[] } {
  if (tailHashes.length === 0) {
    return { matched: false, unsynced: [] }
  }
  if (items.length === 0) {
    return { matched: true, unsynced: [] }
  }

  const itemHashes = items.map(hashMessageItem)
  const maxAnchorLen = Math.min(tailHashes.length, itemHashes.length)

  // Prefer the longest suffix of `tailHashes` that matches a contiguous subarray in `itemHashes`,
  // scanning from the rightmost position so repeated short texts stay aligned to the latest turn.
  for (let anchorLen = maxAnchorLen; anchorLen >= 1; anchorLen--) {
    const anchor = tailHashes.slice(tailHashes.length - anchorLen)
    for (let start = itemHashes.length - anchorLen; start >= 0; start--) {
      let ok = true
      for (let k = 0; k < anchorLen; k++) {
        if (itemHashes[start + k] !== anchor[k]) {
          ok = false
          break
        }
      }
      if (ok) {
        return {
          matched: true,
          unsynced: items.slice(start + anchorLen)
        }
      }
    }
  }

  return { matched: false, unsynced: [] }
}

function extractMessagePairs(entries: OrcaSessionEntry[]): {
  userMessages: string[]
  lastUserIndex: number
  assistantAfterLastUser: string[]
} {
  const userMessages: string[] = []
  let lastUserIndex = -1
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.kind === 'message' && entry.role === 'user') {
      userMessages.push(entry.text || '')
      lastUserIndex = i
    }
  }
  const assistantAfterLastUser: string[] = []
  if (lastUserIndex >= 0) {
    for (let i = lastUserIndex + 1; i < entries.length; i++) {
      const entry = entries[i]
      if (entry.kind === 'message' && entry.role === 'assistant' && entry.text?.trim()) {
        assistantAfterLastUser.push(entry.text.trim())
      }
    }
  }
  return { userMessages, lastUserIndex, assistantAfterLastUser }
}

export async function dispatchToOrcaBotAndWait(
  runner: OrcaCliRunner,
  params: {
    botName: string
    boundChatId: string | null
    tgChatId: string
    senderLabel: string
    userText: string
    imagePaths?: string[]
    timeoutMs: number
    pollIntervalMs?: number
    signal?: AbortSignal
    onChatBound?: (chatId: string, title?: string) => Promise<void> | void
    onWorkingTick?: () => Promise<void> | void
  }
): Promise<{ chatId: string; title?: string; replyText: string; tailHashes: string[] }> {
  const pollIntervalMs = params.pollIntervalMs ?? 1500
  const chatsBefore = await runner.listBotChats(params.botName)

  let targetChatId: string | 'new' = 'new'
  let resolvedTitle: string | undefined

  if (params.boundChatId) {
    const existing = chatsBefore.find((c) => c.id === params.boundChatId && !c.closed)
    if (existing) {
      targetChatId = existing.id
      resolvedTitle = existing.title
    }
  }

  let baselineAssistantTail = ''
  let baselineLastUserText = ''
  let baselineEntrySignature = ''

  if (targetChatId !== 'new') {
    try {
      const snap = await runner.readSession(targetChatId, 40)
      const parsed = extractMessagePairs(snap.entries)
      baselineLastUserText = parsed.userMessages[parsed.userMessages.length - 1] || ''
      baselineAssistantTail = parsed.assistantAfterLastUser.join('\n\n')
      baselineEntrySignature = `${snap.entries.length}:${baselineLastUserText.slice(0, 80)}:${baselineAssistantTail.slice(-80)}`
    } catch {
      // Fresh or unreadable transcript: proceed with empty baseline.
    }
  }

  const cleanText = params.userText.trim()
  const imagePaths = (params.imagePaths ?? []).filter(Boolean)
  const previewBase = cleanText || (imagePaths.length > 0 ? '[Image]' : 'Telegram message')
  const preview = previewBase.replace(/\s+/g, ' ').trim().slice(0, 40)
  const subject = targetChatId === 'new' ? `Telegram: ${preview}` : `Telegram reply: ${preview}`
  const requestMarker = `[tg:${params.tgChatId}:${Date.now()}]`
  const bodyParts = [
    `Telegram message from owner (${params.senderLabel}, chat ${params.tgChatId}) ${requestMarker}.`,
    'Reply directly in this chat; your final message will be sent back to Telegram (use standard Markdown tables; avoid wide ASCII box tables).'
  ]
  if (imagePaths.length > 0) {
    bodyParts.push(
      '',
      'Attached Telegram image(s) saved locally (use your Read tool on these path(s) to view them):',
      ...imagePaths.map((p) => `- ${p}`)
    )
  }
  bodyParts.push(
    '',
    cleanText || 'Please inspect the attached image(s) above and respond.'
  )
  const body = bodyParts.join('\n')

  await runner.sendToBot({
    botName: params.botName,
    chatId: targetChatId,
    subject,
    body,
    signal: params.signal
  })

  let activeChatId = targetChatId === 'new' ? '' : targetChatId

  if (targetChatId === 'new') {
    const beforeIds = new Set(chatsBefore.map((c) => c.id))
    const deadlineNew = Date.now() + 15_000
    while (!activeChatId && Date.now() < deadlineNew) {
      const chatsAfter = await runner.listBotChats(params.botName)
      const created =
        chatsAfter.find((c) => !beforeIds.has(c.id) && !c.home && !c.closed) ||
        chatsAfter.find((c) => !c.home && !c.closed && c.title === subject)
      if (created) {
        activeChatId = created.id
        resolvedTitle = created.title
        break
      }
      await sleep(400, params.signal)
    }

    if (!activeChatId) {
      throw new Error(`Could not locate newly created Orca chat for bot "${params.botName}".`)
    }
    await params.onChatBound?.(activeChatId, resolvedTitle)
  }

  const deadline = Date.now() + params.timeoutMs
  let lastTickAt = 0
  let sawWorkingOrNewTurn = targetChatId === 'new'

  while (Date.now() < deadline) {
    if (Date.now() - lastTickAt >= 4500) {
      lastTickAt = Date.now()
      await params.onWorkingTick?.()
    }

    const session = await runner.readSession(activeChatId, 40)
    const parsed = extractMessagePairs(session.entries)
    const latestUser = parsed.userMessages[parsed.userMessages.length - 1] || ''
    const latestAssistant = parsed.assistantAfterLastUser.join('\n\n')
    const currentSignature = `${session.entries.length}:${latestUser.slice(0, 80)}:${latestAssistant.slice(-80)}`

    if (
      session.state === 'working' ||
      latestUser.includes(requestMarker) ||
      currentSignature !== baselineEntrySignature
    ) {
      sawWorkingOrNewTurn = true
    }

    if (sawWorkingOrNewTurn && session.state !== 'working') {
      if (latestAssistant && (targetChatId === 'new' || latestUser.includes(requestMarker) || latestAssistant !== baselineAssistantTail)) {
        return {
          chatId: activeChatId,
          title: resolvedTitle,
          replyText: latestAssistant,
          tailHashes: computeTailHashes(extractMessageItems(session.entries))
        }
      }
    }

    await sleep(pollIntervalMs, params.signal)
  }

  throw new Error(
    `Timed out after ${Math.round(params.timeoutMs / 1000)}s waiting for "${params.botName}" to finish.`
  )
}
