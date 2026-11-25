import { spawn, type ChildProcess } from 'node:child_process'
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
  shortened?: boolean
}

export type OrcaSessionRead = {
  orcaSessionId: string
  state?: string
  entries: OrcaSessionEntry[]
  limited?: boolean
}

export type OrcaAutomationSummary = {
  id: string
  name: string
  enabled: boolean
  rrule?: string | null
  nextRunAt?: number | null
  lastRunAt?: number | null
  lastRunStatus?: string | null
}

export interface OrcaCliRunner {
  listBots(): Promise<BotSummary[]>
  listBotChats(botName: string): Promise<OrcaChatSummary[]>
  readSession(sessionId: string, limit?: number): Promise<OrcaSessionRead>
  renameChat(sessionId: string, name: string): Promise<void>
  listAutomations(): Promise<OrcaAutomationSummary[]>
  runAutomation(id: string): Promise<void>
  sendToBot(params: {
    botName: string
    chatId: string | 'new'
    subject: string
    body: string
    signal?: AbortSignal
  }): Promise<void>
}

// Mirrors Orca's AGENT_READ_MAX_LIMIT: `agent read --limit` accepts at most 100 newest entries.
const AGENT_READ_MAX_LIMIT = 100

// Orca's Linux CLI is `orca-ide` because GNOME's screen reader owns /usr/bin/orca.
export function getOrcaBinary(
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = fs.existsSync
): string {
  if (env.ORCA_CLI && exists(env.ORCA_CLI)) {
    return env.ORCA_CLI
  }

  const p = platform === 'win32' ? path.win32 : path.posix
  const exeDir = p.dirname(execPath)
  const home = os.homedir()
  let candidates: string[]
  let fallback = 'orca'
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || p.join(home, 'AppData', 'Local')
    candidates = [
      p.join(exeDir, 'resources', 'bin', 'orca.exe'),
      p.join(exeDir, '..', 'bin', 'orca.exe'),
      p.join(exeDir, '..', '..', 'resources', 'bin', 'orca.exe'),
      p.join(localAppData, 'Programs', 'orca', 'resources', 'bin', 'orca.exe')
    ]
  } else if (platform === 'linux') {
    fallback = 'orca-ide'
    candidates = [p.join(exeDir, 'resources', 'bin', 'orca-ide')]
  } else {
    candidates = [
      p.join(exeDir, 'resources', 'bin', 'orca'),
      p.join(exeDir, '..', 'Resources', 'bin', 'orca'),
      '/Applications/Orca.app/Contents/Resources/bin/orca',
      '/usr/local/bin/orca'
    ]
  }

  for (const candidate of candidates) {
    if (exists(candidate)) {
      return candidate
    }
  }
  return fallback
}

function cleanOrcaEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.ORCA_SESSION_ID
  delete env.ORCA_RUN_ID
  delete env.ORCA_WORKTREE_ID
  delete env.ORCA_DISPATCH_ID
  delete env.ORCA_TASK_ID
  delete env.ORCA_TERMINAL_HANDLE
  // Caller identity the CLI reads (agent-session-caller-env.ts, terminal-identity.ts). Inherited from an
  // agent terminal, these make `orchestration send --from plugin:...` fail as `consumer_fenced`.
  delete env.ORCA_AGENT_SESSION_ID
  delete env.ORCA_AGENT_SESSION_SPAWN_TOKEN
  delete env.ORCA_AGENT_SESSION_TOOL_TOKEN
  delete env.ORCA_BOT_TOOLS_TOKEN
  delete env.ORCA_MCP_TOKEN
  delete env.ORCA_PANE_KEY
  delete env.ORCA_STRUCTURED_SESSION

  const home = os.homedir()
  if (!env.HOME) env.HOME = home
  if (process.platform === 'win32') {
    if (!env.USERPROFILE) env.USERPROFILE = home
    if (!env.APPDATA) env.APPDATA = path.join(home, 'AppData', 'Roaming')
    if (!env.LOCALAPPDATA) env.LOCALAPPDATA = path.join(home, 'AppData', 'Local')
  }
  return env
}

// On Windows `orca.exe` is a launcher that runs Orca.exe as its own child; child.kill() would orphan it.
function killProcessTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    const killer = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
      windowsHide: true,
      stdio: 'ignore'
    })
    killer.on('error', () => child.kill())
    return
  }
  child.kill()
}

export type OrcaCliErrorKind = 'timeout' | 'aborted' | 'exit' | 'json' | 'spawn' | 'cli'

const STDERR_FIELD_CHARS = 1500
// Values of these flags are Telegram/Orca text (a message preview, a chat title), never logged.
const TEXT_VALUE_FLAGS = new Set(['--subject', '--name'])

function maskTextArgs(args: string[]): string[] {
  return args.map((arg, i) =>
    i > 0 && TEXT_VALUE_FLAGS.has(args[i - 1]) ? `<${arg.length} chars>` : arg
  )
}

// What a failed `orca` call did. Only ids, lengths, codes and timings: `args` has text values
// masked, the stdin body of `--body-file -` is never kept and stdout (bot/session content) only by size.
export class OrcaCliError extends Error {
  readonly kind: OrcaCliErrorKind
  readonly args: string[]
  readonly exitCode: number | null
  readonly stderr: string
  readonly stdoutBytes: number
  readonly durationMs: number

  constructor(
    message: string,
    fields: {
      kind: OrcaCliErrorKind
      args: string[]
      durationMs: number
      exitCode?: number | null
      stderr?: string
      stdoutBytes?: number
      cause?: unknown
    }
  ) {
    super(message, fields.cause === undefined ? undefined : { cause: fields.cause })
    this.name = 'OrcaCliError'
    this.kind = fields.kind
    this.args = maskTextArgs(fields.args)
    this.exitCode = fields.exitCode ?? null
    this.stderr = (fields.stderr ?? '').slice(0, STDERR_FIELD_CHARS)
    this.stdoutBytes = fields.stdoutBytes ?? 0
    this.durationMs = fields.durationMs
  }
}

export async function runOrcaJson<T>(
  args: string[],
  options: { stdinText?: string; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<T> {
  const bin = getOrcaBinary()
  const timeoutMs = options.timeoutMs ?? 30_000
  const startedAt = Date.now()
  const cliError = (
    message: string,
    fields: { kind: OrcaCliErrorKind; exitCode?: number | null; stderr?: string; stdoutBytes?: number; cause?: unknown }
  ) => new OrcaCliError(message, { ...fields, args, durationMs: Date.now() - startedAt })

  return new Promise<T>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(cliError('Orca CLI command aborted', { kind: 'aborted' }))
      return
    }

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
      killProcessTree(child)
      finish(cliError('Orca CLI command aborted', { kind: 'aborted' }))
    }

    options.signal?.addEventListener('abort', onAbort, { once: true })

    const timer = setTimeout(() => {
      killProcessTree(child)
      finish(cliError(`Orca CLI timed out after ${timeoutMs}ms: orca ${maskTextArgs(args).join(' ')}`, { kind: 'timeout' }))
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
    child.on('error', (err) => finish(cliError(err.message, { kind: 'spawn', cause: err })))
    // A CLI that exits before reading all of stdin raises EPIPE/EOF here; the exit code reports the failure.
    child.stdin.on('error', () => {})

    child.on('close', (code) => {
      const stdoutBuf = Buffer.concat(stdoutChunks)
      const stdout = stdoutBuf.toString('utf8').trim()
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim()
      const stdoutBytes = stdoutBuf.length

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
            finish(cliError(parsed.error.message, { kind: 'cli', exitCode: code, stderr, stdoutBytes }))
            return
          }
        } catch {
          // Fall through to generic exit-code error below.
        }
      }

      // Stdout can hold bot or session content, so error messages report only its size.
      if (code === 0) {
        finish(
          cliError(`Unexpected non-JSON output from orca ${args[0]} (${stdoutBytes} bytes)`, {
            kind: 'json',
            exitCode: code,
            stderr,
            stdoutBytes
          })
        )
      } else {
        finish(
          cliError(stderr || `orca exited with code ${code}`, { kind: 'exit', exitCode: code, stderr, stdoutBytes })
        )
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
    async renameChat(sessionId, name) {
      await runOrcaJson<unknown>([
        'chat',
        'rename',
        '--session',
        sessionId,
        '--name',
        name,
        '--json'
      ])
    },
    async listAutomations() {
      const result = await runOrcaJson<{
        automations?: {
          id: string
          name: string
          enabled?: boolean
          rrule?: string | null
          nextRunAt?: number | null
          lastRunAt?: number | null
        }[]
        items?: {
          automationId: string
          usageSummary?: { lastRunStatus?: string | null }
        }[]
      }>(['automations', 'list', '--json'])
      const statusById = new Map<string, string | null>()
      for (const item of result.items || []) {
        statusById.set(item.automationId, item.usageSummary?.lastRunStatus ?? null)
      }
      return (result.automations || []).map((a) => ({
        id: a.id,
        name: a.name,
        enabled: a.enabled !== false,
        rrule: a.rrule ?? null,
        nextRunAt: a.nextRunAt ?? null,
        lastRunAt: a.lastRunAt ?? null,
        lastRunStatus: statusById.get(a.id) ?? null
      }))
    },
    async runAutomation(id) {
      await runOrcaJson<unknown>(['automations', 'run', id, '--json'])
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
  // Greedy `.*` so sender labels such as `Ann (123)` still match.
  return /^Telegram message from owner \(.*, chat [^)]*\) \[tg:[^:\]]+:\d+\]\./.test(text.trim())
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

const SHORTENED_REPLY_NOTE = '（回复过长已截断，请在 Orca 中查看完整内容）'

/**
 * Assistant messages after the user entry that carries `requestMarker`, or `null` when that turn is
 * not in this read. `anyLatestUser` accepts the latest user turn (a chat we just created holds only
 * ours). `markerLeftWindow` accepts a window with no user entry at all: a tool-heavy turn can push our
 * message out of the newest-entries window after an earlier read showed it.
 */
function findRequestReply(
  entries: OrcaSessionEntry[],
  requestMarker: string,
  fallback: { anyLatestUser: boolean; markerLeftWindow: boolean }
): OrcaSessionEntry[] | null {
  let markerIndex = -1
  let lastUserIndex = -1
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].kind !== 'message' || entries[i].role !== 'user') continue
    lastUserIndex = i
    if ((entries[i].text || '').includes(requestMarker)) markerIndex = i
  }

  let start: number
  if (markerIndex >= 0) start = markerIndex + 1
  else if (fallback.anyLatestUser && lastUserIndex >= 0) start = lastUserIndex + 1
  else if (fallback.markerLeftWindow && lastUserIndex < 0) start = 0
  else return null

  return entries
    .slice(start)
    .filter((e) => e.kind === 'message' && e.role === 'assistant' && e.text?.trim())
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

  params.signal?.throwIfAborted()
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
      params.signal?.throwIfAborted()
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
  let sawRequest = false
  let previousSignature = ''

  while (Date.now() < deadline) {
    params.signal?.throwIfAborted()
    if (Date.now() - lastTickAt >= 4500) {
      lastTickAt = Date.now()
      await params.onWorkingTick?.()
    }

    const session = await runner.readSession(activeChatId, AGENT_READ_MAX_LIMIT)
    const reply = findRequestReply(session.entries, requestMarker, {
      anyLatestUser: targetChatId === 'new',
      markerLeftWindow: sawRequest
    })
    if (reply) sawRequest = true
    const replyText = (reply ?? []).map((e) => (e.text || '').trim()).join('\n\n')
    const signature = `${session.entries.length}:${replyText}`
    // `state` absent means unknown, never done: accept it only once the reply stopped changing.
    const finished =
      session.state === 'done' || (!session.state && signature === previousSignature)
    previousSignature = signature

    if (reply && replyText && finished) {
      return {
        chatId: activeChatId,
        title: resolvedTitle,
        replyText: reply.some((e) => e.shortened)
          ? `${replyText}\n\n${SHORTENED_REPLY_NOTE}`
          : replyText,
        tailHashes: computeTailHashes(extractMessageItems(session.entries))
      }
    }

    await sleep(pollIntervalMs, params.signal)
  }

  throw new Error(
    `Timed out after ${Math.round(params.timeoutMs / 1000)}s waiting for "${params.botName}" to finish.`
  )
}
