import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import { normalizeLanguage, t, TELEGRAM_COMMAND_NAMES, type Messages } from './i18n'
import {
  computeTailHashes,
  createOrcaCliRunner,
  dispatchToOrcaBotAndWait,
  extractMessageItems,
  findUnsyncedTail,
  getOrcaBinary,
  isTelegramOriginatedUserMessage,
  OrcaCliError,
  type OrcaCliRunner,
  type OrcaMessageItem
} from './orca-bridge'
import type {
  BotSummary,
  BridgeConfig,
  BridgeConnectionStatus,
  BridgeLogEntry,
  BridgeState,
  ChatBinding,
  ExportLogsResult,
  LogScope,
  SaveConfigInput,
  TestConnectionResult
} from './protocol'
import {
  extractTablesFromMarkdown,
  renderTableToPng,
  type ExtractedTable
} from './table-render'
import {
  createTelegramClient,
  markdownToTelegramHtml,
  splitTelegramMessage,
  TelegramApiError,
  type TelegramBotCommand,
  type TelegramCallbackQuery,
  type TelegramClient,
  type TelegramInlineKeyboardButton,
  type TelegramInlineKeyboardMarkup,
  type TelegramMessage,
  type TelegramUpdate
} from './telegram-api'

const SECRET_BOT_TOKEN = 'botToken'
const STORAGE_OFFSET = 'tg.updateOffset'
const STORAGE_BINDINGS = 'tg.bindings'
const STORAGE_LOGS = 'tg.logs'
const STORAGE_LAST_BLOCKED = 'tg.lastBlockedUserId'
const STORAGE_SYNC_CURSORS = 'tg.syncCursors'
const STATUS_BAR_ID = 'telegram-status'
// Stored ring of log entries; the state posted to the panel carries only the newest STATE_LOGS.
const MAX_LOGS = 200
const STATE_LOGS = 40
const MAX_DETAIL_CHARS = 500
const MAX_LOG_DETAILS_CHARS = 3000
const MAX_STDERR_DETAIL_CHARS = 1500
const STACK_DETAIL_LINES = 8
// Frequent sync reads (`bot chats`, `agent read`) are traced only when slower than this or failing.
const SLOW_CLI_CALL_MS = 2000
const LOG_FLUSH_MS = 1000
const BLOCK_LOG_INTERVAL_MS = 60_000

type SyncCursor = {
  tailHashes: string[]
  lastActivityAt?: number
  pendingWorking?: boolean
}

export type BridgeDeps = {
  telegram: TelegramClient
  orcaCli: OrcaCliRunner
  renderTable?: (table: ExtractedTable) => Promise<Buffer | null>
  downloadDir?: string
  pollIntervalMs?: number
  outboundPollIntervalMs?: number
  retryBackoffMs?: number
  // Delay before stored logs are written; 0 writes on every entry (tests).
  logFlushMs?: number
}

type IncomingTelegramImage = {
  fileId: string
  ext: string
}

const ALLOWED_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'])
const IMAGE_EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp'
}

function extractIncomingImage(msg: TelegramMessage): IncomingTelegramImage | null {
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo.reduce((best, item) => {
      const bestScore = best.file_size ?? best.width * best.height
      const itemScore = item.file_size ?? item.width * item.height
      return itemScore >= bestScore ? item : best
    })
    return { fileId: largest.file_id, ext: '.jpg' }
  }
  if (msg.document && msg.document.mime_type?.toLowerCase().startsWith('image/')) {
    const docExt = msg.document.file_name
      ? path.extname(msg.document.file_name).toLowerCase()
      : ''
    const ext = ALLOWED_IMAGE_EXTS.has(docExt)
      ? docExt
      : IMAGE_EXT_BY_MIME[msg.document.mime_type?.toLowerCase() ?? '']
    // Other image types (SVG, HEIC, ...) are refused: saved under a wrong extension the agent cannot read them.
    return ext ? { fileId: msg.document.file_id, ext } : null
  }
  return null
}

function resolveSafeImageExt(filePath: string | undefined, fallbackExt: string): string {
  const fromPath = filePath ? path.extname(filePath).toLowerCase() : ''
  return ALLOWED_IMAGE_EXTS.has(fromPath) ? fromPath : fallbackExt
}

function parseAllowedIds(raw: string): Set<string> {
  return new Set(
    raw
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s))
  )
}

function formatSenderLabel(msg: TelegramMessage): string {
  const from = msg.from
  if (!from) return `chat:${msg.chat.id}`
  if (from.username) return `@${from.username}`
  return `${from.first_name} (${from.id})`
}

function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

// Orca refuses `undefined` (and NaN) anywhere in a storage value (invalid_params "Invalid input") and
// in a panel answer ("answered with a non-JSON value"). Optional fields such as a binding's botId are
// often unset, so drop them as JSON would.
function toPlainJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

type ErrorContext = Record<string, string | number | boolean | null | undefined>
type DispatchParams = Parameters<typeof dispatchToOrcaBotAndWait>[1]
type DispatchResult = Awaited<ReturnType<typeof dispatchToOrcaBotAndWait>>
type DispatchStats = { startedAt: number; polls: number; lastState?: string }

function indentLines(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}

function errorFieldLines(err: Error): string[] {
  if (err instanceof OrcaCliError) {
    const lines = [
      `command: orca ${err.args.join(' ')}`,
      `kind: ${err.kind}`,
      `exit code: ${err.exitCode ?? 'none'}`,
      `duration: ${err.durationMs} ms`,
      `stdout: ${err.stdoutBytes} bytes`
    ]
    // An exit error's message already is its stderr.
    if (err.stderr && err.stderr !== err.message) {
      lines.push('stderr:', indentLines(truncateText(err.stderr, MAX_STDERR_DETAIL_CHARS)))
    }
    return lines
  }
  if (err instanceof TelegramApiError) {
    const lines = [
      `method: ${err.method ?? 'unknown'}`,
      `HTTP status: ${err.statusCode}`,
      `retryable: ${err.retryable}`
    ]
    if (err.retryAfterSec !== undefined) lines.push(`retry after: ${err.retryAfterSec} s`)
    return lines
  }
  const code = 'code' in err ? err.code : undefined
  return typeof code === 'string' || typeof code === 'number' ? [`code: ${code}`] : []
}

// The `details` of a log entry: class and message, the error's own fields, its causes, the call
// context and the top of the stack. appendLog redacts and caps it.
function describeError(err: unknown, context?: ErrorContext): string {
  const lines: string[] = []
  let current: unknown = err
  for (let depth = 0; current !== undefined && current !== null && depth < 4; depth++) {
    const prefix = depth === 0 ? '' : 'caused by: '
    if (!(current instanceof Error)) {
      lines.push(`${prefix}${String(current)}`)
      break
    }
    lines.push(
      `${prefix}${current.name}: ${truncateText(current.message, MAX_STDERR_DETAIL_CHARS)}`,
      ...errorFieldLines(current)
    )
    current = current.cause
  }
  for (const [key, value] of Object.entries(context ?? {})) {
    if (value !== undefined) lines.push(`${key}=${value}`)
  }
  const stack =
    err instanceof Error && err.stack
      ? err.stack
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.startsWith('at '))
          .slice(0, STACK_DETAIL_LINES)
      : []
  if (stack.length > 0) lines.push('stack:', ...stack.map((line) => `  ${line}`))
  return lines.join('\n')
}

// Callback data carries ids and names after its "<kind>:" prefix; only the prefix is logged.
function callbackDataKind(data: string | undefined): string | undefined {
  return data === undefined ? undefined : `${data.split(':')[0]}:`
}

function changedConfigFields(prev: BridgeConfig, next: BridgeConfig): string[] {
  return (Object.keys(next) as (keyof BridgeConfig)[]).filter(
    (key) => key !== 'hasToken' && prev[key] !== next[key]
  )
}

function maskProxyCredentials(proxyUrl: string): string {
  return proxyUrl.replace(/\/\/[^/@]*@/, '//<redacted>@')
}

function fileTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

async function readPluginInfo(): Promise<{ name: string; version: string }> {
  try {
    const raw = JSON.parse(
      await fs.readFile(new URL('../orca-plugin.json', import.meta.url), 'utf8')
    ) as { name?: unknown; version?: unknown }
    return {
      name: typeof raw.name === 'string' ? raw.name : 'unknown',
      version: typeof raw.version === 'string' ? raw.version : 'unknown'
    }
  } catch {
    // The manifest is not readable where this module was loaded from.
    return { name: 'unknown', version: 'unknown' }
  }
}

export class TelegramBridgeController {
  private readonly orca: OrcaWorkerApi
  private readonly deps: BridgeDeps

  private status: BridgeConnectionStatus = 'needs_token'
  private botUsername: string | null = null
  private botDisplayName: string | null = null
  private lastError: string | null = null
  private lastBlockedUserId: string | null = null
  private lastPollAt: number | null = null
  private bots: BotSummary[] = []
  private bindings: ChatBinding[] = []
  private syncCursors: Record<string, SyncCursor> = {}
  private logs: BridgeLogEntry[] = []
  private updateOffset = 0
  private config: BridgeConfig = {
    hasToken: false,
    enabled: true,
    defaultBot: '',
    allowedUserIds: '',
    proxyUrl: '',
    replyTimeoutSec: 300,
    syncOrcaOutbound: false,
    debugLogging: false,
    replyLanguage: 'en'
  }

  private cachedToken: string | null = null
  // The token that updateOffset, botUsername and commandsRegistered belong to.
  private identityToken: string | null = null
  private commandsRegistered = false
  private pollAbort: AbortController | null = null
  private pollLoopPromise: Promise<void> | null = null
  private outboundLoopPromise: Promise<void> | null = null
  private outboundLoopAbort: AbortController | null = null
  private readonly chatQueues = new Map<string, Promise<void>>()
  private readonly activeTelegramTgChats = new Set<string>()
  private readonly activeTelegramOrcaChats = new Set<string>()
  private readonly blockedLoggedAt = new Map<string, number>()
  private outboundSyncRunning = false
  private disposed = false
  private botsRefresh: Promise<void> | null = null
  private backgroundBotsRefresh: Promise<void> | null = null
  private configOp: Promise<unknown> = Promise.resolve()
  private logFlushTimer: ReturnType<typeof setTimeout> | null = null
  // Failures retried every few seconds (bot list, sync ticks, status bar, secrets) by site:
  // logged once until their message changes or the call succeeds again.
  private readonly lastFailures = new Map<string, string>()

  constructor(orca: OrcaWorkerApi, deps: BridgeDeps) {
    this.orca = orca
    this.deps = {
      ...deps,
      telegram: this.traceTelegram(deps.telegram),
      orcaCli: this.traceOrcaCli(deps.orcaCli)
    }
  }

  async init(): Promise<void> {
    await this.loadConfig()
    await this.loadRuntimeState()
    this.identityToken = this.cachedToken
    this.updateInitialStatus()
    this.emitState()
    if (this.config.hasToken && this.config.enabled) {
      this.startPolling()
    }
    this.refreshBotsInBackground()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.stopPolling()
    if (this.logFlushTimer) await this.flushLogs()
  }

  getState(): BridgeState {
    return toPlainJson({
      status: this.status,
      polling: this.pollAbort !== null,
      botUsername: this.botUsername,
      botDisplayName: this.botDisplayName,
      lastError: this.lastError,
      lastBlockedUserId: this.lastBlockedUserId,
      lastPollAt: this.lastPollAt,
      config: { ...this.config },
      bots: [...this.bots],
      bindings: [...this.bindings].sort((a, b) => b.updatedAt - a.updatedAt),
      logs: this.logs.slice(0, STATE_LOGS),
      logTotal: this.logs.length
    })
  }

  // Texts for Telegram, in the language the settings chose.
  private get i18n(): Messages {
    return t(this.config.replyLanguage)
  }

  // saveConfig's own settings.set calls fire onDidChange reloads. Running both through one chain
  // makes those reloads start after the save, so a settings snapshot taken mid-save cannot roll it back.
  private runConfigOp<T>(op: () => Promise<T>): Promise<T> {
    const run = this.configOp.then(op)
    this.configOp = run.catch(() => {})
    return run
  }

  reloadFromSettingsAndSecrets(): Promise<void> {
    return this.runConfigOp(() => this.reloadConfigNow())
  }

  private async reloadConfigNow(): Promise<void> {
    const prev = { ...this.config }
    const prevToken = this.cachedToken
    const prevSync = this.config.syncOrcaOutbound
    await this.loadConfig()
    if (prev.replyLanguage !== this.config.replyLanguage) {
      // The next poll registers the command menu again in the new language.
      this.commandsRegistered = false
    }
    // A blank defaultBot setting means auto: the bot list, not the settings, picks it.
    const changed = changedConfigFields(prev, this.config).filter(
      (key) => key !== 'defaultBot' || this.config.defaultBot !== ''
    )
    if (prevToken !== this.cachedToken) changed.push('botToken')
    if (changed.length > 0) {
      await this.appendLog('debug', 'config', `Settings reloaded; changed: ${changed.join(', ')}`)
    }
    this.refreshBotsInBackground()
    if (!prevSync && this.config.syncOrcaOutbound) {
      await this.resetSyncCursors()
    }
    if (this.cachedToken !== this.identityToken) {
      await this.stopPolling()
      await this.adoptToken(this.cachedToken)
    }
    if (!this.config.hasToken) {
      await this.stopPolling()
      this.status = 'needs_token'
      this.botUsername = null
      this.botDisplayName = null
      this.emitState()
      return
    }
    if (!this.config.enabled) {
      await this.stopPolling()
      this.status = 'stopped'
      this.emitState()
      return
    }
    if (!this.pollAbort) {
      this.startPolling()
    } else {
      if (this.config.syncOrcaOutbound) {
        this.ensureOutboundLoopStarted(this.pollAbort)
      }
      this.emitState()
    }
  }

  saveConfig(input: SaveConfigInput): Promise<BridgeState> {
    return this.runConfigOp(() => this.saveConfigNow(input))
  }

  private async saveConfigNow(input: SaveConfigInput): Promise<BridgeState> {
    const prev = { ...this.config }
    const prevToken = this.cachedToken
    if (input.clearToken) {
      try {
        await this.orca.secrets.delete(SECRET_BOT_TOKEN)
      } catch (err) {
        await this.appendLog('debug', 'config', 'Deleting the stored bot token failed', describeError(err))
      }
      this.cachedToken = null
    } else if (input.botToken && input.botToken.trim()) {
      const cleanToken = input.botToken.trim()
      await this.orca.secrets.set(SECRET_BOT_TOKEN, cleanToken)
      this.cachedToken = cleanToken
    }

    const defaultBot = input.defaultBot.trim() || this.bots[0]?.name || ''
    const timeout = Math.min(1800, Math.max(30, Math.round(input.replyTimeoutSec || 300)))
    const syncOrcaOutbound = Boolean(input.syncOrcaOutbound)
    const replyLanguage =
      input.replyLanguage === undefined ? prev.replyLanguage : normalizeLanguage(input.replyLanguage)

    await this.orca.settings.set('enabled', Boolean(input.enabled))
    await this.orca.settings.set('defaultBot', defaultBot)
    await this.orca.settings.set('allowedUserIds', input.allowedUserIds.trim())
    await this.orca.settings.set('proxyUrl', input.proxyUrl.trim())
    await this.orca.settings.set('replyTimeoutSec', timeout)
    await this.orca.settings.set('syncOrcaOutbound', syncOrcaOutbound)
    await this.orca.settings.set('replyLanguage', replyLanguage)

    this.config = {
      hasToken: Boolean(this.cachedToken),
      enabled: Boolean(input.enabled),
      defaultBot,
      allowedUserIds: input.allowedUserIds.trim(),
      proxyUrl: input.proxyUrl.trim(),
      replyTimeoutSec: timeout,
      syncOrcaOutbound,
      debugLogging: prev.debugLogging,
      replyLanguage
    }
    if (prev.replyLanguage !== replyLanguage) {
      // The next poll registers the command menu again in the new language.
      this.commandsRegistered = false
    }
    if (!prev.syncOrcaOutbound && syncOrcaOutbound) {
      await this.resetSyncCursors()
    }
    this.lastError = null
    this.refreshBotsInBackground()
    await this.appendLog('info', 'config', 'Configuration saved.')
    const changed = changedConfigFields(prev, this.config)
    if (prevToken !== this.cachedToken) changed.push('botToken')
    await this.appendLog('debug', 'config', `Config changed: ${changed.join(', ') || 'nothing'}`)

    const tokenChanged = this.cachedToken !== this.identityToken
    // Restarting aborts in-flight replies, so restart only when the Telegram connection itself changes.
    if (tokenChanged || prev.proxyUrl !== this.config.proxyUrl || prev.enabled !== this.config.enabled) {
      await this.stopPolling()
    }
    await this.adoptToken(this.cachedToken)
    if (!this.config.hasToken) {
      this.status = 'needs_token'
    } else if (!this.config.enabled) {
      this.status = 'stopped'
    } else if (!this.pollAbort) {
      this.startPolling()
    } else if (this.config.syncOrcaOutbound) {
      this.ensureOutboundLoopStarted(this.pollAbort)
    }
    this.emitState()
    return this.getState()
  }

  async testConnection(): Promise<TestConnectionResult> {
    const token = await this.readToken()
    if (!token) {
      this.status = 'needs_token'
      this.lastError = 'Missing Telegram Bot Token.'
      this.emitState()
      return { ok: false, error: this.lastError, state: this.getState() }
    }

    try {
      const me = await this.deps.telegram.getMe(token, {
        proxyUrl: this.config.proxyUrl,
        timeoutMs: 12_000
      })
      this.botUsername = me.username || null
      this.botDisplayName = me.first_name
      this.lastError = null
      await this.ensureCommandsRegistered(token)
      if (this.status === 'error' || this.status === 'needs_token') {
        this.status = this.pollAbort ? 'connected' : 'stopped'
      }
      await this.appendLog('info', 'telegram', `Verified Telegram bot @${me.username || me.id}`)
      this.emitState()
      return { ok: true, ...(me.username ? { username: me.username } : {}), botId: me.id, state: this.getState() }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.lastError = message
      // While paused a failed test is not a polling failure; lastError alone reports it.
      if (this.pollAbort) {
        this.status = 'error'
      }
      await this.appendLog('error', 'telegram', `Telegram connection test failed: ${message}`, describeError(err))
      this.emitState()
      return { ok: false, error: message, state: this.getState() }
    }
  }

  async togglePolling(): Promise<BridgeState> {
    if (!this.config.hasToken) {
      this.status = 'needs_token'
      this.lastError = 'Configure a Telegram Bot Token first.'
      this.emitState()
      return this.getState()
    }

    const nextEnabled = !this.config.enabled
    await this.orca.settings.set('enabled', nextEnabled)
    this.config.enabled = nextEnabled

    if (nextEnabled) {
      this.startPolling()
      await this.appendLog('info', 'telegram', 'Telegram polling resumed.')
    } else {
      await this.stopPolling()
      this.status = 'stopped'
      await this.appendLog('info', 'telegram', 'Telegram polling paused.')
    }
    this.emitState()
    return this.getState()
  }

  async allowUserId(userId: string): Promise<BridgeState> {
    const clean = userId.trim()
    if (!/^\d+$/.test(clean)) {
      return this.getState()
    }
    const existing = parseAllowedIds(this.config.allowedUserIds)
    existing.add(clean)
    const merged = Array.from(existing).join(', ')
    await this.orca.settings.set('allowedUserIds', merged)
    this.config.allowedUserIds = merged
    if (this.lastBlockedUserId === clean) {
      this.lastBlockedUserId = null
      await this.orca.storage.set(STORAGE_LAST_BLOCKED, null)
    }
    await this.appendLog('info', 'config', `Added Telegram user ${clean} to allowlist.`)
    this.emitState()
    return this.getState()
  }

  async resetBinding(tgChatId: string): Promise<BridgeState> {
    // Queued behind a running reply, which would otherwise write the binding back when it ends.
    // The panel request does not wait for that reply; the state post after the reset updates it.
    const busy = this.chatQueues.has(tgChatId)
    const done = this.enqueueChatWork(tgChatId, async () => {
      this.bindings = this.bindings.filter((b) => b.tgChatId !== tgChatId)
      await this.orca.storage.set(STORAGE_BINDINGS, this.bindings)
      await this.pruneUnusedSyncCursors()
      await this.appendLog('info', 'bridge', `Reset Orca chat binding for Telegram chat ${tgChatId}.`)
      this.emitState()
    })
    if (!busy) await done
    return this.getState()
  }

  async clearLogs(): Promise<BridgeState> {
    this.logs = []
    await this.orca.storage.set(STORAGE_LOGS, [])
    this.emitState()
    return this.getState()
  }

  setDebugLogging(enabled: boolean): Promise<BridgeState> {
    return this.runConfigOp(async () => {
      await this.orca.settings.set('debugLogging', enabled)
      this.config.debugLogging = enabled
      await this.appendLog('info', 'config', enabled ? 'Debug logging enabled' : 'Debug logging disabled')
      this.emitState()
      return this.getState()
    })
  }

  async exportLogs(): Promise<ExportLogsResult> {
    const now = new Date()
    const plugin = await readPluginInfo()
    const config = { ...this.config, proxyUrl: maskProxyCredentials(this.config.proxyUrl) }
    const lines = [
      'Telegram Bridge diagnostics',
      `Plugin: ${plugin.name} ${plugin.version}`,
      `Exported: ${now.toISOString()}`,
      `Platform: ${process.platform} ${process.arch}`,
      `Node: ${process.version}`,
      `Orca CLI: ${getOrcaBinary()}`,
      `Status: ${this.status}${this.pollAbort ? ' (polling)' : ''}`,
      `Bot: ${this.botUsername ? `@${this.botUsername}` : 'unknown'}`,
      `Last error: ${this.lastError ?? 'none'}`,
      `Config: ${JSON.stringify(config)}`,
      `Bots: ${this.bots.length}`,
      `Bindings: ${this.bindings.length}`,
      `Log entries: ${this.logs.length}`,
      ''
    ]
    for (const entry of [...this.logs].reverse()) {
      lines.push(
        `${new Date(entry.at).toISOString()} ${entry.level.toUpperCase()} [${entry.scope ?? '-'}] ${entry.message}`
      )
      if (entry.details) lines.push(indentLines(entry.details))
    }
    return {
      fileName: `telegram-bridge-logs-${fileTimestamp(now)}.txt`,
      text: this.redact(`${lines.join('\n')}\n`)
    }
  }

  async handleIncomingUpdate(update: TelegramUpdate): Promise<void> {
    const accepted = await this.acceptIncomingUpdate(update, this.pollAbort?.signal)
    await accepted?.done
  }

  // The ordered part of an update: offset, allowlist, then enqueue on the chat's queue. The queued
  // work is returned, not awaited, so the poll loop keeps serving other chats during a slow reply.
  private async acceptIncomingUpdate(
    update: TelegramUpdate,
    signal?: AbortSignal
  ): Promise<{ done: Promise<void> } | null> {
    if (update.update_id >= this.updateOffset) {
      this.updateOffset = update.update_id + 1
      await this.orca.storage.set(STORAGE_OFFSET, this.updateOffset)
    }

    if (update.callback_query) {
      return this.acceptCallbackQuery(update.callback_query)
    }

    const msg = update.message
    if (!msg) return null
    const text = (msg.text ?? msg.caption ?? '').trim()
    const image = extractIncomingImage(msg)
    const unsupportedImage =
      !image && Boolean(msg.document?.mime_type?.toLowerCase().startsWith('image/'))
    if (!text && !image && !unsupportedImage) return null

    const tgChatId = String(msg.chat.id)
    const fromId = msg.from ? String(msg.from.id) : tgChatId
    const allowed = parseAllowedIds(this.config.allowedUserIds)

    if (!allowed.has(fromId) && !allowed.has(tgChatId)) {
      await this.recordBlockedUser(
        fromId,
        `Blocked unauthorized Telegram user ${fromId} (${formatSenderLabel(msg)}).`
      )

      const token = await this.readToken()
      if (token && allowed.size === 0) {
        await this.safeSendTelegram(
          token,
          msg.chat.id,
          this.i18n.unauthorized(fromId),
          msg.message_id
        )
      }
      return null
    }

    const done = this.enqueueChatWork(tgChatId, async () => {
      try {
        if (unsupportedImage) {
          const token = await this.readToken()
          if (token) {
            await this.safeSendTelegram(
              token,
              msg.chat.id,
              this.i18n.unsupportedImage,
              msg.message_id
            )
          }
          return
        }
        await this.processAuthorizedMessage(msg, text, image, signal, update.update_id)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await this.appendLog(
          'error',
          'bridge',
          `Failed handling Telegram message in chat ${tgChatId}: ${message}`,
          describeError(err, { tgChatId, updateId: update.update_id, messageId: msg.message_id })
        )
        this.emitState()
        const token = await this.readToken()
        if (token) {
          await this.safeSendTelegram(
            token,
            msg.chat.id,
            this.i18n.processingFailed(truncateText(this.redact(message), MAX_DETAIL_CHARS)),
            msg.message_id
          )
        }
      }
    })
    return { done }
  }

  private async acceptCallbackQuery(
    cq: TelegramCallbackQuery
  ): Promise<{ done: Promise<void> } | null> {
    const fromId = String(cq.from.id)
    const tgChatId = cq.message ? String(cq.message.chat.id) : fromId
    const allowed = parseAllowedIds(this.config.allowedUserIds)
    const token = await this.readToken()

    if (!allowed.has(fromId) && !allowed.has(tgChatId)) {
      await this.recordBlockedUser(fromId, `Blocked unauthorized Telegram callback from ${fromId}.`)
      if (token) {
        await this.safeAnswerCallbackQuery(token, cq.id, this.i18n.callbackUnauthorized, true)
      }
      return null
    }

    if (!token || !cq.message || !cq.data) {
      if (token) {
        await this.safeAnswerCallbackQuery(token, cq.id)
      }
      return null
    }

    const done = this.enqueueChatWork(tgChatId, async () => {
      try {
        await this.processCallbackQuery(token, cq)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await this.appendLog(
          'error',
          'bridge',
          `Failed handling Telegram button in chat ${tgChatId}: ${message}`,
          describeError(err, { tgChatId, callbackId: cq.id, callback: callbackDataKind(cq.data) })
        )
        this.emitState()
        await this.safeAnswerCallbackQuery(token, cq.id, this.i18n.actionFailed(this.redact(message).slice(0, 120)), true)
      }
    })
    return { done }
  }

  private enqueueChatWork(tgChatId: string, work: () => Promise<void>): Promise<void> {
    const prev = this.chatQueues.get(tgChatId) ?? Promise.resolve()
    const next = prev
      .then(work)
      // The work runs detached from the poll loop, so a rejection must end here.
      .catch(async (err) => {
        const message = err instanceof Error ? err.message : String(err)
        await this.appendLog(
          'error',
          'bridge',
          `Telegram chat ${tgChatId} work failed: ${message}`,
          describeError(err, { tgChatId })
        )
        this.emitState()
      })
      .finally(() => {
        if (this.chatQueues.get(tgChatId) === next) {
          this.chatQueues.delete(tgChatId)
        }
      })
    this.chatQueues.set(tgChatId, next)
    return next
  }

  // Any stranger can flood the bot; log and post each blocked id at most once a minute.
  private async recordBlockedUser(fromId: string, logMessage: string): Promise<void> {
    const now = Date.now()
    for (const [id, at] of this.blockedLoggedAt) {
      if (now - at >= BLOCK_LOG_INTERVAL_MS) this.blockedLoggedAt.delete(id)
    }
    if (this.blockedLoggedAt.has(fromId)) return
    this.blockedLoggedAt.set(fromId, now)
    this.lastBlockedUserId = fromId
    await this.orca.storage.set(STORAGE_LAST_BLOCKED, fromId)
    await this.appendLog('warn', 'bridge', logMessage)
    this.emitState()
  }

  private async processAuthorizedMessage(
    msg: TelegramMessage,
    text: string,
    image: IncomingTelegramImage | null,
    signal: AbortSignal | undefined,
    updateId: number
  ): Promise<void> {
    const token = await this.readToken()
    if (!token) return

    const tgChatId = String(msg.chat.id)
    const fromId = msg.from ? String(msg.from.id) : tgChatId
    const senderLabel = formatSenderLabel(msg)

    if (!image && text.startsWith('/')) {
      const handled = await this.handleSlashCommand(token, msg, text)
      if (handled) return
    }

    const binding = await this.resolveBindingBot(await this.getOrCreateBinding(tgChatId, fromId))
    if (!binding.botName) {
      await this.appendLog('error', 'dispatch', 'No Orca bots found to route incoming Telegram message.')
      this.emitState()
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        this.i18n.noBotsAvailable,
        msg.message_id
      )
      return
    }
    // Only the length of what the user wrote is logged, never the text.
    const content = [text ? `text ${text.length} chars` : '', image ? 'image' : ''].filter(Boolean).join(' + ')
    await this.appendLog('info', 'dispatch', `[TG ${senderLabel} -> ${binding.botName}] ${content}`)
    this.emitState()

    this.activeTelegramTgChats.add(tgChatId)
    if (binding.orcaChatId) {
      this.activeTelegramOrcaChats.add(binding.orcaChatId)
    }

    let boundOrcaChatId = binding.orcaChatId
    const stats: DispatchStats = { startedAt: Date.now(), polls: 0 }
    try {
      const imagePaths: string[] = []
      if (image) {
        await this.sendTypingAction(token, msg.chat.id)
        const savedPath = await this.downloadTelegramImage(token, image, msg.message_id, signal)
        imagePaths.push(savedPath)
      }

      const result = await this.dispatchTraced(stats, {
        botName: binding.botName,
        boundChatId: binding.orcaChatId,
        tgChatId,
        senderLabel,
        userText: text,
        imagePaths,
        timeoutMs: this.config.replyTimeoutSec * 1000,
        pollIntervalMs: this.deps.pollIntervalMs,
        signal,
        onChatBound: async (chatId, title) => {
          boundOrcaChatId = chatId
          this.activeTelegramOrcaChats.add(chatId)
          await this.upsertBinding({
            tgChatId,
            botId: binding.botId,
            botName: binding.botName,
            orcaChatId: chatId,
            title,
            updatedAt: Date.now()
          })
          this.emitState()
        },
        onWorkingTick: () => this.sendTypingAction(token, msg.chat.id)
      })

      boundOrcaChatId = result.chatId
      this.activeTelegramOrcaChats.add(result.chatId)
      await this.upsertBinding({
        tgChatId,
        botId: binding.botId,
        botName: binding.botName,
        orcaChatId: result.chatId,
        title: result.title || binding.title,
        updatedAt: Date.now()
      })

      const delivery = await this.sendFormattedReplyToTelegram(
        token,
        msg.chat.id,
        result.shortened ? `${result.replyText}\n\n${this.i18n.shortenedNote}` : result.replyText,
        msg.message_id
      )

      const existingCursor = this.syncCursors[result.chatId]
      this.syncCursors[result.chatId] = {
        tailHashes: result.tailHashes,
        ...(existingCursor?.lastActivityAt !== undefined
          ? { lastActivityAt: existingCursor.lastActivityAt }
          : {}),
        pendingWorking: false
      }
      await this.saveSyncCursors()

      await this.appendLog(
        'info',
        'dispatch',
        `[${binding.botName} -> TG ${tgChatId}] Sent ${delivery.messageCount} message(s)${
          delivery.imageCount > 0 ? ` + ${delivery.imageCount} table image(s)` : ''
        }.`
      )
      this.emitState()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.appendLog(
        'error',
        'dispatch',
        `Failed handling message for ${binding.botName}: ${message}`,
        describeError(err, {
          tgChatId,
          updateId,
          messageId: msg.message_id,
          bot: binding.botName,
          orcaChatId: boundOrcaChatId,
          elapsedMs: Date.now() - stats.startedAt,
          polls: stats.polls
        })
      )
      this.emitState()
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        this.i18n.processingFailed(truncateText(this.redact(message), MAX_DETAIL_CHARS)),
        msg.message_id
      )
    } finally {
      this.activeTelegramTgChats.delete(tgChatId)
      if (boundOrcaChatId) {
        this.activeTelegramOrcaChats.delete(boundOrcaChatId)
      }
    }
  }

  private async sendTypingAction(token: string, chatId: number): Promise<void> {
    try {
      await this.deps.telegram.sendChatAction(
        token,
        { chatId, action: 'typing' },
        { proxyUrl: this.config.proxyUrl, timeoutMs: 8000 }
      )
    } catch (err) {
      // Non-fatal: the reply still goes out without a typing indicator.
      await this.appendLog(
        'debug',
        'telegram',
        `Typing indicator failed for chat ${chatId}`,
        describeError(err, { tgChatId: chatId })
      )
    }
  }

  // dispatchToOrcaBotAndWait with debug start/finish entries; `stats` counts its session reads.
  private async dispatchTraced(stats: DispatchStats, params: DispatchParams): Promise<DispatchResult> {
    const cli = this.deps.orcaCli
    const runner: OrcaCliRunner = {
      ...cli,
      readSession: async (sessionId, limit) => {
        stats.polls++
        const session = await cli.readSession(sessionId, limit)
        stats.lastState = session.state
        return session
      }
    }
    await this.appendLog(
      'debug',
      'dispatch',
      `Dispatch start: bot ${params.botName}, tg chat ${params.tgChatId}, ${
        params.boundChatId ? `bound Orca chat ${params.boundChatId}` : 'new Orca chat'
      }, body ${params.userText.length} chars, ${params.imagePaths?.length ?? 0} image(s)`
    )
    const result = await dispatchToOrcaBotAndWait(runner, params)
    await this.appendLog(
      'debug',
      'dispatch',
      `Dispatch finished in ${Date.now() - stats.startedAt} ms: Orca chat ${result.chatId}, ${
        stats.polls
      } poll(s), state ${stats.lastState ?? 'unknown'}, reply ${result.replyText.length} chars`
    )
    return result
  }

  private async downloadTelegramImage(
    token: string,
    image: IncomingTelegramImage,
    messageId: number,
    signal: AbortSignal | undefined
  ): Promise<string> {
    const fileMeta = await this.deps.telegram.getFile(token, image.fileId, {
      proxyUrl: this.config.proxyUrl,
      timeoutMs: 15_000,
      signal
    })
    if (!fileMeta.file_path) {
      throw new Error('Telegram did not return a downloadable file_path for this image.')
    }
    const bytes = await this.deps.telegram.downloadFile(token, fileMeta.file_path, {
      proxyUrl: this.config.proxyUrl,
      timeoutMs: 30_000,
      signal
    })

    const dir = this.deps.downloadDir ?? path.join(os.tmpdir(), 'orca-telegram-bridge', 'images')
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    await this.cleanupOldDownloadedImages(dir)

    const ext = resolveSafeImageExt(fileMeta.file_path, image.ext)
    const filename = `tg-${Date.now()}-${messageId}-${Math.random().toString(36).slice(2, 6)}${ext}`
    const targetPath = path.join(dir, filename)
    await fs.writeFile(targetPath, bytes)
    return targetPath
  }

  private async cleanupOldDownloadedImages(dir: string): Promise<void> {
    try {
      const cutoffMs = Date.now() - 24 * 60 * 60 * 1000
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile()) continue
        const full = path.join(dir, entry.name)
        try {
          const stat = await fs.stat(full)
          if (stat.mtimeMs < cutoffMs) {
            await fs.unlink(full)
          }
        } catch (err) {
          // Best-effort cleanup.
          await this.appendLog('debug', 'bridge', 'Removing an old downloaded image failed', describeError(err))
        }
      }
    } catch (err) {
      // Best-effort cleanup.
      await this.appendLog('debug', 'bridge', 'Listing downloaded images for cleanup failed', describeError(err))
    }
  }

  private async sendFormattedReplyToTelegram(
    token: string,
    chatId: number | string,
    rawMarkdown: string,
    replyToMessageId?: number
  ): Promise<{ messageCount: number; imageCount: number }> {
    const renderTable = this.deps.renderTable ?? renderTableToPng
    const i18n = this.i18n
    const { textWithMarkers, tables } = extractTablesFromMarkdown(rawMarkdown, i18n.tableMarker)
    const renderedImages: { index: number; png: Buffer }[] = []

    for (let i = 0; i < tables.length; i++) {
      const png = await renderTable(tables[i])
      if (png) {
        renderedImages.push({ index: i + 1, png })
      }
    }

    // Only swap tables for markers if all tables rendered as PNGs; otherwise keep raw markdown fallback.
    const finalText =
      renderedImages.length === tables.length && renderedImages.length > 0
        ? textWithMarkers
        : rawMarkdown

    const chunks = splitTelegramMessage(finalText, 3500)
    for (let i = 0; i < chunks.length; i++) {
      await this.safeSendTelegram(
        token,
        chatId,
        chunks[i],
        i === 0 ? replyToMessageId : undefined,
        true
      )
    }

    let imageCount = 0
    if (renderedImages.length === tables.length && renderedImages.length > 0) {
      for (const img of renderedImages) {
        await this.safeSendTelegramPhoto(
          token,
          chatId,
          img.png,
          `table-${img.index}.png`,
          tables.length > 1 ? i18n.tableCaption(img.index) : undefined
        )
        imageCount++
      }
    }

    return { messageCount: chunks.length, imageCount }
  }

  private async handleSlashCommand(
    token: string,
    msg: TelegramMessage,
    text: string
  ): Promise<boolean> {
    const [rawCmd, ...rest] = text.split(/\s+/)
    const cmd = rawCmd.split('@')[0].toLowerCase()
    const arg = rest.join(' ').trim()
    const tgChatId = String(msg.chat.id)
    const fromId = msg.from ? String(msg.from.id) : tgChatId
    const binding = await this.resolveBindingBot(await this.getOrCreateBinding(tgChatId, fromId))

    if (cmd === '/start' || cmd === '/help') {
      const helpText = this.i18n.help({
        botName: binding.botName,
        orcaChatId: binding.orcaChatId,
        syncOn: this.config.syncOrcaOutbound
      })
      await this.safeSendTelegram(token, msg.chat.id, helpText, msg.message_id)
      return true
    }

    if (cmd === '/bots') {
      await this.refreshBots()
      const lines = this.bots.length
        ? this.bots.map(
            (b) =>
              `• ${b.name}${b.name === binding.botName ? this.i18n.currentSuffix : ''}${b.specialty ? ` — ${b.specialty}` : ''}`
          )
        : [this.i18n.noBotsFound]
      const keyboardRows: TelegramInlineKeyboardButton[][] = []
      for (let i = 0; i < this.bots.length; i += 2) {
        keyboardRows.push(
          this.bots.slice(i, i + 2).map((b) => ({
            text: `${b.name === binding.botName ? '✓ ' : ''}${b.name.slice(0, 24)}`,
            callback_data: `u:${b.id}`
          }))
        )
      }
      await this.safeSendTelegramChunks(
        token,
        msg.chat.id,
        lines.join('\n'),
        msg.message_id,
        keyboardRows.length > 0 ? { inline_keyboard: keyboardRows } : undefined
      )
      return true
    }

    if (cmd === '/use') {
      if (!arg) {
        await this.safeSendTelegram(token, msg.chat.id, this.i18n.useUsage, msg.message_id)
        return true
      }
      await this.refreshBots()
      const match = this.bots.find((b) => b.name.toLowerCase() === arg.toLowerCase())
      if (!match) {
        await this.safeSendTelegramChunks(
          token,
          msg.chat.id,
          this.i18n.botNotFound(arg, this.bots.map((b) => b.name)),
          msg.message_id
        )
        return true
      }
      await this.switchBotForChat(tgChatId, match)
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        this.i18n.switchedBot(match.name),
        msg.message_id
      )
      return true
    }

    if (cmd === '/new') {
      await this.resetChatSessionForBinding(tgChatId, binding)
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        this.i18n.contextReset(binding.botName),
        msg.message_id
      )
      return true
    }

    if (cmd === '/home') {
      const chats = await this.deps.orcaCli.listBotChats(binding.botName)
      const homeChat = chats.find((c) => c.home && !c.closed)
      if (!homeChat) {
        await this.safeSendTelegram(
          token,
          msg.chat.id,
          this.i18n.homeChatNotFoundFor(binding.botName),
          msg.message_id
        )
        return true
      }
      await this.bindSpecificChat(tgChatId, binding, homeChat)
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        this.i18n.boundHomeChat(binding.botName, homeChat.id),
        msg.message_id
      )
      return true
    }

    if (cmd === '/chats') {
      const chats = await this.deps.orcaCli.listBotChats(binding.botName)
      const active = chats.filter((c) => !c.closed).slice(0, 8)
      const lines = active.length
        ? active.map(
            (c) =>
              `• ${c.title || this.i18n.untitledChat}${c.home ? ' [Home]' : ''}${c.id === binding.orcaChatId ? this.i18n.currentSuffix : ''}\n  ID: ${c.id}`
          )
        : [this.i18n.noChats]
      const keyboardRows: TelegramInlineKeyboardButton[][] = active.map((c) => {
        const labelBase = c.home ? '🏠 Home' : (c.title || c.id).slice(0, 28)
        return [
          {
            text: `${c.id === binding.orcaChatId ? '✓ ' : ''}${labelBase}`,
            callback_data: `b:${c.id}`
          }
        ]
      })
      keyboardRows.push([
        { text: '🏠 Home Chat', callback_data: 'c:home' },
        { text: this.i18n.newChatButton, callback_data: 'c:new' }
      ])
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        lines.join('\n'),
        msg.message_id,
        false,
        { inline_keyboard: keyboardRows }
      )
      return true
    }

    if (cmd === '/bind') {
      if (!arg) {
        await this.safeSendTelegram(token, msg.chat.id, this.i18n.bindUsage, msg.message_id)
        return true
      }
      const chats = await this.deps.orcaCli.listBotChats(binding.botName)
      const target = chats.find((c) => c.id === arg && !c.closed)
      if (!target) {
        await this.safeSendTelegram(
          token,
          msg.chat.id,
          this.i18n.chatNotFound(binding.botName, arg),
          msg.message_id
        )
        return true
      }
      await this.bindSpecificChat(tgChatId, binding, target)
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        this.i18n.boundChat(binding.botName, target.title || target.id),
        msg.message_id
      )
      return true
    }

    if (cmd === '/rename') {
      if (!arg) {
        await this.safeSendTelegram(token, msg.chat.id, this.i18n.renameUsage, msg.message_id)
        return true
      }
      if (!binding.orcaChatId) {
        await this.safeSendTelegram(
          token,
          msg.chat.id,
          this.i18n.noBoundChat,
          msg.message_id
        )
        return true
      }
      try {
        await this.deps.orcaCli.renameChat(binding.orcaChatId, arg)
        await this.upsertBinding({
          ...binding,
          title: arg,
          updatedAt: Date.now()
        })
        await this.appendLog('info', 'orca-cli', `Renamed Orca chat ${binding.orcaChatId} (${arg.length} chars).`)
        this.emitState()
        await this.safeSendTelegram(token, msg.chat.id, this.i18n.renamed(arg), msg.message_id)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await this.appendLog(
          'warn',
          'orca-cli',
          `Renaming Orca chat ${binding.orcaChatId} failed: ${message}`,
          describeError(err, { tgChatId, orcaChatId: binding.orcaChatId })
        )
        this.emitState()
        await this.safeSendTelegram(
          token,
          msg.chat.id,
          this.i18n.renameFailed(truncateText(this.redact(message), MAX_DETAIL_CHARS)),
          msg.message_id
        )
      }
      return true
    }

    if (cmd === '/sync') {
      const normalized = arg.toLowerCase()
      if (!normalized) {
        await this.safeSendTelegram(
          token,
          msg.chat.id,
          this.i18n.syncState(this.config.syncOrcaOutbound),
          msg.message_id,
          false,
          {
            inline_keyboard: [
              [
                {
                  text: `${this.config.syncOrcaOutbound ? '✓ ' : ''}${this.i18n.syncOnButton}`,
                  callback_data: 's:on'
                },
                {
                  text: `${!this.config.syncOrcaOutbound ? '✓ ' : ''}${this.i18n.syncOffButton}`,
                  callback_data: 's:off'
                }
              ]
            ]
          }
        )
        return true
      }
      if (['on', 'true', '1', 'enable'].includes(normalized)) {
        await this.setSyncOrcaOutbound(true)
        await this.safeSendTelegram(token, msg.chat.id, this.i18n.syncEnabled, msg.message_id)
        return true
      }
      if (['off', 'false', '0', 'disable'].includes(normalized)) {
        await this.setSyncOrcaOutbound(false)
        await this.safeSendTelegram(token, msg.chat.id, this.i18n.syncDisabled, msg.message_id)
        return true
      }
      await this.safeSendTelegram(token, msg.chat.id, this.i18n.syncUsage, msg.message_id)
      return true
    }

    if (cmd === '/automations') {
      try {
        const automations = await this.deps.orcaCli.listAutomations()
        if (automations.length === 0) {
          await this.safeSendTelegram(token, msg.chat.id, this.i18n.noAutomations, msg.message_id)
          return true
        }
        const slice = automations.slice(0, 8)
        const lines = slice.map(
          (a) => `• ${a.name} (${this.i18n.automationState(a.enabled, a.lastRunStatus)})\n  ID: ${a.id}`
        )
        const keyboardRows: TelegramInlineKeyboardButton[][] = slice.map((a) => [
          {
            text: this.i18n.runButton(a.name.slice(0, 26)),
            callback_data: `r:${a.id}`
          }
        ])
        await this.safeSendTelegram(
          token,
          msg.chat.id,
          lines.join('\n'),
          msg.message_id,
          false,
          { inline_keyboard: keyboardRows }
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await this.appendLog(
          'warn',
          'orca-cli',
          `Listing Orca automations failed: ${message}`,
          describeError(err, { tgChatId })
        )
        this.emitState()
        await this.safeSendTelegram(
          token,
          msg.chat.id,
          this.i18n.automationsFailed(truncateText(this.redact(message), MAX_DETAIL_CHARS)),
          msg.message_id
        )
      }
      return true
    }

    if (cmd === '/run') {
      if (!arg) {
        await this.safeSendTelegram(
          token,
          msg.chat.id,
          this.i18n.runUsage,
          msg.message_id
        )
        return true
      }
      try {
        await this.deps.orcaCli.runAutomation(arg)
        await this.appendLog('info', 'orca-cli', `Triggered Orca automation ${arg} from Telegram.`)
        this.emitState()
        await this.safeSendTelegram(token, msg.chat.id, this.i18n.automationTriggered(arg), msg.message_id)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await this.appendLog(
          'warn',
          'orca-cli',
          `Running Orca automation ${arg} failed: ${message}`,
          describeError(err, { tgChatId, automationId: arg })
        )
        this.emitState()
        await this.safeSendTelegram(
          token,
          msg.chat.id,
          this.i18n.runFailed(truncateText(this.redact(message), MAX_DETAIL_CHARS)),
          msg.message_id
        )
      }
      return true
    }

    if (cmd === '/status') {
      const statusText = this.i18n.status({
        botUsername: this.botUsername,
        botName: binding.botName,
        orcaChatId: binding.orcaChatId,
        syncOn: this.config.syncOrcaOutbound,
        pollStatus: this.status
      })
      await this.safeSendTelegram(token, msg.chat.id, statusText, msg.message_id)
      return true
    }

    return false
  }

  private async processCallbackQuery(token: string, cq: TelegramCallbackQuery): Promise<void> {
    const msg = cq.message
    const data = cq.data || ''
    if (!msg) return
    const tgChatId = String(msg.chat.id)
    const binding = await this.resolveBindingBot(
      await this.getOrCreateBinding(tgChatId, String(cq.from.id))
    )

    if (data.startsWith('u:')) {
      const botId = data.slice(2)
      await this.refreshBots()
      const match = this.bots.find((b) => b.id === botId)
      if (!match) {
        await this.safeAnswerCallbackQuery(token, cq.id, this.i18n.botNotFoundRetry, true)
        return
      }
      await this.switchBotForChat(tgChatId, match)
      await this.safeAnswerCallbackQuery(token, cq.id, this.i18n.switchedBotToast(match.name))
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        this.i18n.switchedBot(match.name)
      )
      return
    }

    if (data.startsWith('b:')) {
      const chatId = data.slice(2)
      const chats = await this.deps.orcaCli.listBotChats(binding.botName)
      const target = chats.find((c) => c.id === chatId && !c.closed)
      if (!target) {
        await this.safeAnswerCallbackQuery(token, cq.id, this.i18n.chatGoneRetry, true)
        return
      }
      await this.bindSpecificChat(tgChatId, binding, target)
      await this.safeAnswerCallbackQuery(token, cq.id, this.i18n.chatBoundToast)
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        this.i18n.boundChat(binding.botName, target.title || target.id)
      )
      return
    }

    if (data === 'c:new') {
      await this.resetChatSessionForBinding(tgChatId, binding)
      await this.safeAnswerCallbackQuery(token, cq.id, this.i18n.contextResetToast)
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        this.i18n.contextReset(binding.botName)
      )
      return
    }

    if (data === 'c:home') {
      const chats = await this.deps.orcaCli.listBotChats(binding.botName)
      const homeChat = chats.find((c) => c.home && !c.closed)
      if (!homeChat) {
        await this.safeAnswerCallbackQuery(token, cq.id, this.i18n.homeChatNotFound, true)
        return
      }
      await this.bindSpecificChat(tgChatId, binding, homeChat)
      await this.safeAnswerCallbackQuery(token, cq.id, this.i18n.homeChatBoundToast)
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        this.i18n.boundHomeChat(binding.botName, homeChat.id)
      )
      return
    }

    if (data === 's:on' || data === 's:off') {
      const enabled = data === 's:on'
      await this.setSyncOrcaOutbound(enabled)
      await this.safeAnswerCallbackQuery(
        token,
        cq.id,
        enabled ? this.i18n.syncOnToast : this.i18n.syncOffToast
      )
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        enabled ? this.i18n.syncEnabled : this.i18n.syncDisabled
      )
      return
    }

    if (data.startsWith('r:')) {
      const automationId = data.slice(2)
      try {
        await this.deps.orcaCli.runAutomation(automationId)
        await this.appendLog('info', 'orca-cli', `Triggered Orca automation ${automationId} via Telegram button.`)
        this.emitState()
        await this.safeAnswerCallbackQuery(token, cq.id, this.i18n.automationTriggeredToast)
        await this.safeSendTelegram(token, msg.chat.id, this.i18n.automationTriggered(automationId))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await this.appendLog(
          'warn',
          'orca-cli',
          `Running Orca automation ${automationId} failed: ${message}`,
          describeError(err, { tgChatId: String(msg.chat.id), automationId })
        )
        this.emitState()
        await this.safeAnswerCallbackQuery(token, cq.id, this.i18n.runFailed(this.redact(message).slice(0, 120)), true)
      }
      return
    }

    await this.safeAnswerCallbackQuery(token, cq.id)
  }

  private async switchBotForChat(tgChatId: string, match: BotSummary): Promise<void> {
    await this.upsertBinding({
      tgChatId,
      botId: match.id,
      botName: match.name,
      orcaChatId: null,
      updatedAt: Date.now()
    })
    await this.pruneUnusedSyncCursors()
    await this.appendLog('info', 'bridge', `Switched Telegram chat ${tgChatId} to bot "${match.name}".`)
    this.emitState()
  }

  private async resetChatSessionForBinding(tgChatId: string, binding: ChatBinding): Promise<void> {
    await this.upsertBinding({
      tgChatId,
      botId: binding.botId,
      botName: binding.botName,
      orcaChatId: null,
      updatedAt: Date.now()
    })
    await this.pruneUnusedSyncCursors()
    await this.appendLog('info', 'bridge', `Started fresh session binding for Telegram chat ${tgChatId}.`)
    this.emitState()
  }

  private async bindSpecificChat(
    tgChatId: string,
    binding: ChatBinding,
    target: { id: string; title: string; lastActivityAt: number }
  ): Promise<void> {
    await this.upsertBinding({
      tgChatId,
      botId: binding.botId,
      botName: binding.botName,
      orcaChatId: target.id,
      title: target.title,
      updatedAt: Date.now()
    })
    try {
      const snap = await this.deps.orcaCli.readSession(target.id, 80)
      this.syncCursors[target.id] = {
        tailHashes: computeTailHashes(extractMessageItems(snap.entries)),
        ...(snap.state !== 'working' ? { lastActivityAt: target.lastActivityAt } : {}),
        pendingWorking: snap.state === 'working'
      }
      await this.saveSyncCursors()
    } catch (err) {
      // Cursor will baseline on next sync tick if needed.
      await this.appendLog(
        'debug',
        'sync',
        `Reading Orca chat ${target.id} for its sync baseline failed`,
        describeError(err, { tgChatId, orcaChatId: target.id })
      )
    }
    await this.pruneUnusedSyncCursors()
    this.emitState()
  }

  private async setSyncOrcaOutbound(enabled: boolean): Promise<void> {
    const prev = this.config.syncOrcaOutbound
    await this.orca.settings.set('syncOrcaOutbound', enabled)
    this.config.syncOrcaOutbound = enabled
    if (!prev && enabled) {
      await this.resetSyncCursors()
    }
    if (enabled && this.pollAbort) {
      this.ensureOutboundLoopStarted(this.pollAbort)
    }
    await this.appendLog(
      'info',
      'sync',
      enabled ? 'Enabled Orca -> Telegram outbound sync.' : 'Disabled Orca -> Telegram outbound sync.'
    )
    this.emitState()
  }

  private async safeAnswerCallbackQuery(
    token: string,
    callbackQueryId: string,
    text?: string,
    showAlert = false
  ): Promise<void> {
    try {
      await this.deps.telegram.answerCallbackQuery(
        token,
        { callbackQueryId, text, showAlert },
        { proxyUrl: this.config.proxyUrl, timeoutMs: 10_000 }
      )
    } catch (err) {
      // Non-fatal callback ack failure.
      await this.appendLog(
        'debug',
        'telegram',
        'Answering a Telegram button press failed',
        describeError(err, { callbackId: callbackQueryId })
      )
    }
  }

  private async safeSendTelegram(
    token: string,
    chatId: number | string,
    text: string,
    replyToMessageId?: number,
    formatMarkdown = false,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ): Promise<void> {
    if (formatMarkdown) {
      const html = markdownToTelegramHtml(text)
      if (html.length <= 4096) {
        try {
          await this.deps.telegram.sendMessage(
            token,
            { chatId, text: html, replyToMessageId, parseMode: 'HTML', replyMarkup },
            { proxyUrl: this.config.proxyUrl, timeoutMs: 15_000 }
          )
          return
        } catch (err) {
          // Fall back to plain text below if HTML formatting or length fails.
          await this.appendLog(
            'debug',
            'telegram',
            `HTML reply to chat ${chatId} rejected; resending as plain text`,
            describeError(err, { tgChatId: chatId, htmlLength: html.length })
          )
        }
      }
    }
    try {
      await this.deps.telegram.sendMessage(
        token,
        { chatId, text, replyToMessageId, replyMarkup },
        { proxyUrl: this.config.proxyUrl, timeoutMs: 15_000 }
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.appendLog(
        'error',
        'telegram',
        `Failed sending Telegram reply: ${message}`,
        describeError(err, { tgChatId: chatId, textLength: text.length, replyToMessageId })
      )
    }
  }

  // Plain text over Telegram's 4096-char limit is rejected, so long lists go out in chunks.
  private async safeSendTelegramChunks(
    token: string,
    chatId: number | string,
    text: string,
    replyToMessageId?: number,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ): Promise<void> {
    const chunks = splitTelegramMessage(text, 3500)
    for (let i = 0; i < chunks.length; i++) {
      await this.safeSendTelegram(
        token,
        chatId,
        chunks[i],
        i === 0 ? replyToMessageId : undefined,
        false,
        i === chunks.length - 1 ? replyMarkup : undefined
      )
    }
  }

  private async safeSendTelegramPhoto(
    token: string,
    chatId: number | string,
    photo: Buffer,
    filename: string,
    caption?: string
  ): Promise<void> {
    try {
      await this.deps.telegram.sendPhoto(
        token,
        { chatId, photo, filename, caption },
        { proxyUrl: this.config.proxyUrl, timeoutMs: 25_000 }
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.appendLog(
        'error',
        'telegram',
        `Failed sending Telegram table image: ${message}`,
        describeError(err, { tgChatId: chatId, bytes: photo.length })
      )
    }
  }

  private async ensureCommandsRegistered(token: string, signal?: AbortSignal): Promise<void> {
    if (this.commandsRegistered) return
    const language = this.config.replyLanguage
    const descriptions = t(language).commands
    const commands: TelegramBotCommand[] = TELEGRAM_COMMAND_NAMES.map((command) => ({
      command,
      description: descriptions[command]
    }))
    try {
      await this.deps.telegram.setMyCommands(token, commands, {
        proxyUrl: this.config.proxyUrl,
        timeoutMs: 10_000,
        signal
      })
      // A language change during the call leaves the flag unset, so the next poll sends the new menu.
      this.commandsRegistered = language === this.config.replyLanguage
      this.lastFailures.delete('setMyCommands')
      await this.appendLog('info', 'telegram', `Registered Telegram slash command menu (${language}).`)
    } catch (err) {
      // Retried on every poll until it works; logged again only when the failure changes.
      if (this.isRepeatedFailure('setMyCommands', err)) return
      const message = err instanceof Error ? err.message : String(err)
      await this.appendLog('warn', 'telegram', `Failed to register Telegram commands: ${message}`, describeError(err))
    }
  }

  private startPolling(): void {
    if (this.disposed || this.pollAbort) return
    const abort = new AbortController()
    this.pollAbort = abort
    this.status = 'connecting'
    this.lastError = null
    this.emitState()

    const loop = this.runPollLoop(abort).finally(() => {
      // The loop also ends on its own (401, no token); abort so the outbound loop and queued replies stop.
      abort.abort()
      if (this.pollAbort === abort) {
        this.pollAbort = null
      }
      if (this.pollLoopPromise === loop) {
        this.pollLoopPromise = null
      }
    })
    this.pollLoopPromise = loop

    if (this.config.syncOrcaOutbound) {
      this.ensureOutboundLoopStarted(abort)
    }
  }

  private ensureOutboundLoopStarted(abort: AbortController): void {
    if (this.disposed || this.outboundLoopAbort === abort) return
    // The loop of an aborted controller may still be finishing a tick; run the new loop after it.
    const prev = this.outboundLoopPromise ?? Promise.resolve()
    const loop = prev
      .then(() => this.runOutboundSyncLoop(abort))
      .finally(() => {
        if (this.outboundLoopPromise === loop) {
          this.outboundLoopPromise = null
          this.outboundLoopAbort = null
        }
      })
    this.outboundLoopAbort = abort
    this.outboundLoopPromise = loop
  }

  private async stopPolling(): Promise<void> {
    // Read the loops before awaiting: loops of a restart during the wait are not ours to wait for.
    const loops = [this.pollLoopPromise, this.outboundLoopPromise]
    this.pollAbort?.abort()
    this.pollAbort = null
    await Promise.all(loops)
    // Replies still running in chat queues got the aborted poll signal; wait for them to settle.
    await Promise.all(this.chatQueues.values())
  }

  private async runOutboundSyncLoop(abort: AbortController): Promise<void> {
    const intervalMs = this.deps.outboundPollIntervalMs ?? 3000
    while (!abort.signal.aborted && !this.disposed) {
      await sleep(intervalMs, abort.signal)
      if (abort.signal.aborted || this.disposed) break
      if (!this.config.syncOrcaOutbound || !this.config.enabled) continue
      try {
        await this.syncOrcaBoundChatsOnce()
        this.lastFailures.delete('outboundSync')
      } catch (err) {
        if (abort.signal.aborted || this.disposed) break
        // A failing tick repeats every few seconds; log it again only when the failure changes.
        if (this.isRepeatedFailure('outboundSync', err)) continue
        const msg = err instanceof Error ? err.message : String(err)
        await this.appendLog('warn', 'sync', `Orca outbound sync error: ${msg}`, describeError(err))
        this.emitState()
      }
    }
  }

  async syncOrcaBoundChatsOnce(): Promise<void> {
    if (this.disposed || !this.config.syncOrcaOutbound || this.outboundSyncRunning) return
    const token = await this.readToken()
    if (!token) return
    const allowed = parseAllowedIds(this.config.allowedUserIds)
    if (allowed.size === 0) return

    // Sync only to chats whose Telegram user is still on the allowlist.
    const boundList = this.bindings.filter(
      (b) =>
        Boolean(b.orcaChatId) &&
        (allowed.has(b.tgChatId) || (b.ownerUserId !== undefined && allowed.has(b.ownerUserId)))
    )
    if (boundList.length === 0) return

    this.outboundSyncRunning = true
    try {
      await this.refreshBots()
      const byBot = new Map<string, ChatBinding[]>()
      for (const rawBinding of boundList) {
        const binding = await this.resolveBindingFromCachedBots(rawBinding)
        if (!binding.orcaChatId || !binding.botName) continue
        if (
          this.activeTelegramTgChats.has(binding.tgChatId) ||
          this.activeTelegramOrcaChats.has(binding.orcaChatId)
        ) {
          continue
        }
        const list = byBot.get(binding.botName) ?? []
        list.push(binding)
        byBot.set(binding.botName, list)
      }

      for (const [botName, bindings] of byBot.entries()) {
        if (this.disposed) break
        let chats
        try {
          chats = await this.deps.orcaCli.listBotChats(botName)
          this.lastFailures.delete(`syncChats:${botName}`)
        } catch (err) {
          if (!this.isRepeatedFailure(`syncChats:${botName}`, err)) {
            await this.appendLog(
              'debug',
              'sync',
              `Sync skipped bot ${botName}: listing its chats failed`,
              describeError(err, { bot: botName })
            )
          }
          continue
        }
        const chatMap = new Map(chats.map((c) => [c.id, c]))

        for (const binding of bindings) {
          const orcaChatId = binding.orcaChatId
          if (!orcaChatId) continue
          if (
            this.activeTelegramTgChats.has(binding.tgChatId) ||
            this.activeTelegramOrcaChats.has(orcaChatId)
          ) {
            continue
          }
          const chatMeta = chatMap.get(orcaChatId)
          if (!chatMeta || chatMeta.closed) continue
          await this.syncSingleBoundChat(token, binding, orcaChatId, chatMeta.lastActivityAt)
        }
      }
    } finally {
      this.outboundSyncRunning = false
    }
  }

  private async syncSingleBoundChat(
    token: string,
    binding: ChatBinding,
    orcaChatId: string,
    lastActivityAt: number
  ): Promise<void> {
    const existing = this.syncCursors[orcaChatId]
    if (existing && !existing.pendingWorking && existing.lastActivityAt === lastActivityAt) {
      return
    }

    const startedAt = Date.now()
    let session
    try {
      session = await this.deps.orcaCli.readSession(orcaChatId, 80)
      this.lastFailures.delete(`syncRead:${orcaChatId}`)
    } catch (err) {
      if (!this.isRepeatedFailure(`syncRead:${orcaChatId}`, err)) {
        await this.appendLog(
          'debug',
          'sync',
          `Sync skipped Orca chat ${orcaChatId}: reading it failed`,
          describeError(err, { tgChatId: binding.tgChatId, bot: binding.botName, orcaChatId })
        )
      }
      return
    }

    const items = extractMessageItems(session.entries)
    const isWorking = session.state === 'working'

    if (!existing) {
      this.syncCursors[orcaChatId] = {
        tailHashes: computeTailHashes(items),
        ...(isWorking ? {} : { lastActivityAt }),
        pendingWorking: isWorking
      }
      await this.saveSyncCursors()
      return
    }

    const { matched, unsynced } = findUnsyncedTail(items, existing.tailHashes)
    if (!matched) {
      this.syncCursors[orcaChatId] = {
        tailHashes: computeTailHashes(items),
        ...(isWorking ? {} : { lastActivityAt }),
        pendingWorking: isWorking
      }
      await this.saveSyncCursors()
      return
    }

    if (unsynced.length === 0) {
      this.syncCursors[orcaChatId] = {
        tailHashes: existing.tailHashes,
        ...(isWorking ? {} : { lastActivityAt }),
        pendingWorking: isWorking
      }
      await this.saveSyncCursors()
      return
    }

    let readyItems: OrcaMessageItem[] = unsynced
    if (isWorking) {
      // While the bot is still generating, only flush up to the last user prompt;
      // wait for completion before forwarding assistant messages.
      let lastUserIdx = -1
      for (let i = unsynced.length - 1; i >= 0; i--) {
        if (unsynced[i].role === 'user') {
          lastUserIdx = i
          break
        }
      }
      if (lastUserIdx < 0) {
        this.syncCursors[orcaChatId] = {
          tailHashes: existing.tailHashes,
          pendingWorking: true
        }
        await this.saveSyncCursors()
        return
      }
      readyItems = unsynced.slice(0, lastUserIdx + 1)
    }

    if (readyItems.length === 0) return

    let forwardedUserCount = 0
    let forwardedAssistantCount = 0

    // Group consecutive assistant messages so multi-step tool turns arrive as one clean reply.
    for (let i = 0; i < readyItems.length; i++) {
      const item = readyItems[i]
      if (item.role === 'user') {
        if (!isTelegramOriginatedUserMessage(item.text)) {
          const userPayload = `${this.i18n.orcaUserMessageHeader(binding.botName)}\n\n${item.text}`
          const chunks = splitTelegramMessage(userPayload, 3500)
          for (const chunk of chunks) {
            await this.safeSendTelegram(token, binding.tgChatId, chunk, undefined, true)
          }
          forwardedUserCount++
        }
        continue
      }

      const assistantParts = [item.text]
      while (i + 1 < readyItems.length && readyItems[i + 1].role === 'assistant') {
        i++
        assistantParts.push(readyItems[i].text)
      }
      await this.sendFormattedReplyToTelegram(
        token,
        binding.tgChatId,
        assistantParts.join('\n\n')
      )
      forwardedAssistantCount++
    }

    const unconsumedCount = unsynced.length - readyItems.length
    const syncedPrefix = unconsumedCount > 0 ? items.slice(0, items.length - unconsumedCount) : items
    const stillPending = isWorking || unconsumedCount > 0

    this.syncCursors[orcaChatId] = {
      tailHashes: computeTailHashes(syncedPrefix),
      ...(stillPending ? {} : { lastActivityAt }),
      pendingWorking: stillPending
    }
    await this.saveSyncCursors()

    if (forwardedUserCount > 0 || forwardedAssistantCount > 0) {
      await this.appendLog(
        'info',
        'sync',
        `[Orca -> TG ${binding.tgChatId}] Synced ${forwardedUserCount} user + ${forwardedAssistantCount} assistant message(s) from ${binding.botName}.`
      )
      await this.appendLog(
        'debug',
        'sync',
        `Sync tick for Orca chat ${orcaChatId} forwarded ${readyItems.length} item(s) in ${
          Date.now() - startedAt
        } ms: ${session.entries.length} entries read, state ${session.state ?? 'unknown'}, ${
          stillPending ? 'more pending' : 'caught up'
        }`
      )
      this.emitState()
    }
  }

  private async resetSyncCursors(): Promise<void> {
    this.syncCursors = {}
    await this.saveSyncCursors()
  }

  private async pruneUnusedSyncCursors(): Promise<void> {
    const activeIds = new Set(
      this.bindings.map((b) => b.orcaChatId).filter((id): id is string => Boolean(id))
    )
    let changed = false
    for (const chatId of Object.keys(this.syncCursors)) {
      if (!activeIds.has(chatId)) {
        delete this.syncCursors[chatId]
        changed = true
      }
    }
    if (changed) {
      await this.saveSyncCursors()
    }
  }

  private async saveSyncCursors(): Promise<void> {
    try {
      await this.orca.storage.set(STORAGE_SYNC_CURSORS, toPlainJson(this.syncCursors))
    } catch (err) {
      // Non-fatal in mock/read-only runs.
      await this.appendLog('debug', 'sync', 'Saving sync cursors failed', describeError(err))
    }
  }

  private async runPollLoop(abort: AbortController): Promise<void> {
    await this.appendLog('debug', 'telegram', `Poll loop started at offset ${this.updateOffset}`)
    let stopReason: string | null = null
    try {
      stopReason = await this.pollUntilStopped(abort)
    } finally {
      await this.appendLog(
        'debug',
        'telegram',
        `Poll loop stopped: ${stopReason ?? (this.disposed ? 'disposed' : 'aborted')}`
      )
    }
  }

  // Returns why it stopped on its own, or null when aborted or disposed.
  private async pollUntilStopped(abort: AbortController): Promise<string | null> {
    let backoffMs = this.deps.retryBackoffMs ?? 2000

    while (!abort.signal.aborted && !this.disposed) {
      const token = await this.readToken()
      if (!token) {
        this.status = 'needs_token'
        this.emitState()
        return 'no bot token'
      }

      try {
        if (!this.botUsername) {
          const me = await this.deps.telegram.getMe(token, {
            proxyUrl: this.config.proxyUrl,
            timeoutMs: 12_000,
            signal: abort.signal
          })
          this.botUsername = me.username || null
          this.botDisplayName = me.first_name
        }

        await this.ensureCommandsRegistered(token, abort.signal)

        // While not yet connected, a short poll confirms the connection right away instead of
        // leaving the status on "connecting" for a whole 25s long poll.
        const updates = await this.deps.telegram.getUpdates(
          token,
          {
            offset: this.updateOffset || undefined,
            timeoutSec: this.status === 'connected' ? 25 : 0
          },
          { proxyUrl: this.config.proxyUrl, signal: abort.signal }
        )

        this.lastPollAt = Date.now()
        backoffMs = this.deps.retryBackoffMs ?? 2000

        // Only a successful getUpdates proves the connection (a second poller gets 409 here).
        if (this.status !== 'connected') {
          this.status = 'connected'
          this.lastError = null
          await this.appendLog(
            'info',
            'telegram',
            `Connected to Telegram as @${this.botUsername || 'bot'}.`
          )
          this.emitState()
        }

        for (const update of updates) {
          if (abort.signal.aborted || this.disposed) break
          await this.acceptIncomingUpdate(update, abort.signal)
        }
      } catch (err) {
        if (abort.signal.aborted || this.disposed) break
        const message = err instanceof Error ? err.message : String(err)
        const isAuthError = err instanceof TelegramApiError && err.statusCode === 401
        this.status = 'error'
        this.lastError = message
        await this.appendLog(
          'error',
          'telegram',
          `Polling error: ${message}`,
          describeError(err, { offset: this.updateOffset, backoffMs: isAuthError ? null : backoffMs })
        )
        this.emitState()

        if (isAuthError) {
          return 'Telegram rejected the bot token (401)'
        }
        await this.appendLog('debug', 'telegram', `Poll loop backing off ${backoffMs} ms`)
        await sleep(backoffMs, abort.signal)
        backoffMs = Math.min(30_000, backoffMs * 2)
      }
    }
    return null
  }

  private async loadConfig(): Promise<void> {
    this.cachedToken = await this.readToken()
    const settings = await this.orca.settings.get()

    this.config = {
      hasToken: Boolean(this.cachedToken),
      enabled: typeof settings.enabled === 'boolean' ? settings.enabled : true,
      defaultBot:
        typeof settings.defaultBot === 'string' && settings.defaultBot.trim()
          ? settings.defaultBot.trim()
          : '',
      allowedUserIds: typeof settings.allowedUserIds === 'string' ? settings.allowedUserIds : '',
      proxyUrl: typeof settings.proxyUrl === 'string' ? settings.proxyUrl : '',
      replyTimeoutSec:
        typeof settings.replyTimeoutSec === 'number' && Number.isFinite(settings.replyTimeoutSec)
          ? settings.replyTimeoutSec
          : 300,
      syncOrcaOutbound:
        typeof settings.syncOrcaOutbound === 'boolean' ? settings.syncOrcaOutbound : false,
      debugLogging: typeof settings.debugLogging === 'boolean' ? settings.debugLogging : false,
      replyLanguage: normalizeLanguage(settings.replyLanguage)
    }
  }

  // Runtime state is read once at init; afterwards memory owns it and storage is write-through.
  private async loadRuntimeState(): Promise<void> {
    const savedOffset = await this.orca.storage.get(STORAGE_OFFSET)
    this.updateOffset = typeof savedOffset === 'number' ? savedOffset : 0

    const savedBindings = await this.orca.storage.get(STORAGE_BINDINGS)
    this.bindings = Array.isArray(savedBindings) ? (savedBindings as ChatBinding[]) : []

    // Entries stored by 0.2.0 have no scope or details; they load as they are.
    const savedLogs = await this.orca.storage.get(STORAGE_LOGS)
    this.logs = Array.isArray(savedLogs) ? (savedLogs as BridgeLogEntry[]).slice(0, MAX_LOGS) : []

    const savedBlocked = await this.orca.storage.get(STORAGE_LAST_BLOCKED)
    this.lastBlockedUserId = typeof savedBlocked === 'string' ? savedBlocked : null

    const savedCursors = await this.orca.storage.get(STORAGE_SYNC_CURSORS)
    this.syncCursors =
      savedCursors && typeof savedCursors === 'object' && !Array.isArray(savedCursors)
        ? (savedCursors as Record<string, SyncCursor>)
        : {}
  }

  private async readToken(): Promise<string | null> {
    try {
      const value = await this.orca.secrets.get(SECRET_BOT_TOKEN)
      this.cachedToken = value && value.trim() ? value.trim() : null
      this.lastFailures.delete('readToken')
      return this.cachedToken
    } catch (err) {
      // Read on every poll; a failing secret store is logged again only when the failure changes.
      if (!this.isRepeatedFailure('readToken', err)) {
        await this.appendLog('debug', 'config', 'Reading the bot token failed; using the cached one', describeError(err))
      }
      return this.cachedToken
    }
  }

  // updateOffset, the @username and the command menu belong to one bot; a new token starts them over.
  private async adoptToken(token: string | null): Promise<void> {
    if (token === this.identityToken) return
    this.identityToken = token
    this.updateOffset = 0
    this.botUsername = null
    this.botDisplayName = null
    this.commandsRegistered = false
    await this.orca.storage.set(STORAGE_OFFSET, 0)
  }

  // One shared `orca bot list` call for every caller: sync ticks, messages and panel loads.
  private refreshBots(): Promise<void> {
    if (!this.botsRefresh) {
      this.botsRefresh = this.loadBots().finally(() => {
        this.botsRefresh = null
      })
    }
    return this.botsRefresh
  }

  private async loadBots(): Promise<void> {
    try {
      this.bots = await this.deps.orcaCli.listBots()
      this.lastFailures.delete('listBots')
      if (
        this.bots.length > 0 &&
        !this.bots.some((b) => b.name === this.config.defaultBot)
      ) {
        this.config.defaultBot = this.bots[0].name
      }
    } catch (err) {
      // Refreshed by every message, sync tick and panel load; log a failure again only when it changes.
      if (this.isRepeatedFailure('listBots', err)) return
      const msg = err instanceof Error ? err.message : String(err)
      await this.appendLog('warn', 'orca-cli', `Failed to list Orca bots: ${msg}`, describeError(err))
    }
  }

  // `orca bot list` can hang for the full CLI timeout (30s), longer than the host's 10s
  // ready deadline. Startup and panel loads must not wait for it; message handling
  // refreshes bots itself. One shared call so repeated panel opens do not pile up CLI processes.
  private refreshBotsInBackground(): void {
    if (this.backgroundBotsRefresh) return
    this.backgroundBotsRefresh = this.refreshBots().finally(() => {
      this.backgroundBotsRefresh = null
      if (!this.disposed) this.emitState()
    })
  }

  private async resolveBindingBot(binding: ChatBinding): Promise<ChatBinding> {
    await this.refreshBots()
    return this.resolveBindingFromCachedBots(binding)
  }

  private async resolveBindingFromCachedBots(binding: ChatBinding): Promise<ChatBinding> {
    if (this.bots.length === 0) return binding

    const byName = this.bots.find((b) => b.name === binding.botName)
    if (byName) {
      if (binding.botId !== byName.id) {
        const updated = { ...binding, botId: byName.id, updatedAt: Date.now() }
        await this.upsertBinding(updated)
        return updated
      }
      return binding
    }

    // Bot was renamed in Orca: match by saved botId, or fall back to defaultBot / sole bot.
    const byId = binding.botId ? this.bots.find((b) => b.id === binding.botId) : undefined
    const byDefault = this.bots.find((b) => b.name === this.config.defaultBot)
    const fallback = byId || byDefault || (this.bots.length === 1 ? this.bots[0] : undefined)
    if (fallback) {
      const updated: ChatBinding = {
        ...binding,
        botId: fallback.id,
        botName: fallback.name,
        updatedAt: Date.now()
      }
      await this.upsertBinding(updated)
      await this.appendLog(
        'info',
        'bridge',
        `Updated binding ${binding.tgChatId} from "${binding.botName}" to "${fallback.name}".`
      )
      return updated
    }
    return binding
  }

  private async getOrCreateBinding(tgChatId: string, ownerUserId: string): Promise<ChatBinding> {
    const existing = this.bindings.find((b) => b.tgChatId === tgChatId)
    if (existing) {
      if (existing.ownerUserId === ownerUserId) return existing
      const owned: ChatBinding = { ...existing, ownerUserId }
      await this.upsertBinding(owned)
      return owned
    }
    const defaultMatch = this.bots.find((b) => b.name === this.config.defaultBot) || this.bots[0]
    const created: ChatBinding = {
      tgChatId,
      ownerUserId,
      botId: defaultMatch?.id,
      botName: defaultMatch?.name || this.config.defaultBot || '',
      orcaChatId: null,
      updatedAt: Date.now()
    }
    await this.upsertBinding(created)
    return created
  }

  private async upsertBinding(binding: ChatBinding): Promise<void> {
    const idx = this.bindings.findIndex((b) => b.tgChatId === binding.tgChatId)
    if (idx >= 0) {
      // Callers rebuild bindings field by field; keep the owner unless they set a new one.
      const ownerUserId = binding.ownerUserId ?? this.bindings[idx].ownerUserId
      this.bindings[idx] = ownerUserId === undefined ? binding : { ...binding, ownerUserId }
    } else {
      this.bindings.push(binding)
    }
    await this.orca.storage.set(STORAGE_BINDINGS, toPlainJson(this.bindings))
  }

  // Debug entries are stored only while debugLogging is on and never post state themselves.
  private async appendLog(
    level: BridgeLogEntry['level'],
    scope: LogScope,
    message: string,
    details?: string
  ): Promise<void> {
    if (level === 'debug' && !this.config.debugLogging) return
    const at = Date.now()
    const entry: BridgeLogEntry = {
      id: `${at}-${Math.random().toString(36).slice(2, 7)}`,
      at,
      level,
      scope,
      message: truncateText(this.redact(message), MAX_DETAIL_CHARS),
      ...(details ? { details: truncateText(this.redact(details), MAX_LOG_DETAILS_CHARS) } : {})
    }
    this.logs = [entry, ...this.logs].slice(0, MAX_LOGS)
    this.orca.log(`[${level}] [${scope}] ${entry.message}`)
    // Writing the whole ring per line is too much; batch the writes, orca.log above stays immediate.
    const flushMs = this.deps.logFlushMs ?? LOG_FLUSH_MS
    if (flushMs <= 0) {
      await this.flushLogs()
    } else if (!this.logFlushTimer) {
      const timer = setTimeout(() => {
        this.logFlushTimer = null
        void this.flushLogs()
      }, flushMs)
      // A pending write must not keep the worker process alive; dispose flushes it.
      if (typeof timer === 'object' && 'unref' in timer) timer.unref()
      this.logFlushTimer = timer
    }
  }

  private async flushLogs(): Promise<void> {
    if (this.logFlushTimer) {
      clearTimeout(this.logFlushTimer)
      this.logFlushTimer = null
    }
    try {
      await this.orca.storage.set(STORAGE_LOGS, this.logs)
    } catch (err) {
      // Not through appendLog: that would schedule another write to the failing store.
      const message = err instanceof Error ? err.message : String(err)
      this.orca.log(`[warn] [bridge] Storing logs failed: ${this.redact(message)}`)
    }
  }

  // The bot token must never reach a log line, a detail or an export.
  private redact(text: string): string {
    let out = text.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<redacted>')
    for (const token of [this.cachedToken, this.identityToken]) {
      if (token) out = out.split(token).join('bot<redacted>')
    }
    return out
  }

  private isRepeatedFailure(site: string, err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err)
    if (this.lastFailures.get(site) === message) return true
    this.lastFailures.set(site, message)
    return false
  }

  // Times one Telegram/CLI call into a debug entry. A failure is recorded with its error; the
  // caller's own entry adds the context. `summary` returning null skips a success entry.
  private async traceCall<T>(
    scope: LogScope,
    call: string,
    run: () => Promise<T>,
    summary: (result: T, ms: number) => string | null
  ): Promise<T> {
    if (!this.config.debugLogging) return run()
    const startedAt = Date.now()
    let result: T
    try {
      result = await run()
    } catch (err) {
      await this.appendLog('debug', scope, `${call} failed after ${Date.now() - startedAt} ms`, describeError(err))
      throw err
    }
    const ms = Date.now() - startedAt
    const text = summary(result, ms)
    if (text !== null) {
      await this.appendLog('debug', scope, `${call} ok in ${ms} ms${text ? `: ${text}` : ''}`)
    }
    return result
  }

  // Only ids, sizes and counts are recorded: never message text, captions or callback data.
  private traceTelegram(client: TelegramClient): TelegramClient {
    const trace = <T>(
      call: string,
      run: () => Promise<T>,
      summary: (result: T, ms: number) => string | null = () => ''
    ) => this.traceCall('telegram', call, run, summary)
    return {
      getMe: (token, options) =>
        trace('getMe', () => client.getMe(token, options), (me) => `@${me.username ?? me.id}`),
      setMyCommands: (token, commands, options) =>
        trace(`setMyCommands (${commands.length} commands)`, () =>
          client.setMyCommands(token, commands, options)
        ),
      getUpdates: (token, params, options) =>
        trace(
          `getUpdates offset=${params.offset ?? 0} timeout=${params.timeoutSec ?? 25}s`,
          () => client.getUpdates(token, params, options),
          // Empty long polls are the idle steady state.
          (updates) => (updates.length > 0 ? `${updates.length} update(s)` : null)
        ),
      sendMessage: (token, params, options) =>
        trace(
          `sendMessage chat=${params.chatId} ${params.text.length} chars${params.parseMode ? ` ${params.parseMode}` : ''}`,
          () => client.sendMessage(token, params, options),
          (sent) => `message ${sent.message_id}`
        ),
      answerCallbackQuery: (token, params, options) =>
        trace('answerCallbackQuery', () => client.answerCallbackQuery(token, params, options)),
      sendPhoto: (token, params, options) =>
        trace(
          `sendPhoto chat=${params.chatId} ${params.photo.length} bytes`,
          () => client.sendPhoto(token, params, options),
          (sent) => `message ${sent.message_id}`
        ),
      sendChatAction: (token, params, options) =>
        trace(`sendChatAction chat=${params.chatId} ${params.action}`, () =>
          client.sendChatAction(token, params, options)
        ),
      getFile: (token, fileId, options) =>
        trace(
          'getFile',
          () => client.getFile(token, fileId, options),
          (file) => `${file.file_size ?? 'unknown'} bytes`
        ),
      downloadFile: (token, filePath, options) =>
        trace(
          'downloadFile',
          () => client.downloadFile(token, filePath, options),
          (bytes) => `${bytes.length} bytes`
        )
    }
  }

  // Commands are logged without text values (chat titles, subjects) or the stdin body.
  private traceOrcaCli(cli: OrcaCliRunner): OrcaCliRunner {
    const trace = <T>(
      call: string,
      run: () => Promise<T>,
      summary: (result: T, ms: number) => string | null = () => ''
    ) => this.traceCall('orca-cli', call, run, summary)
    // Sync ticks read every few seconds; their successes are recorded only when slow.
    const whenSlow = (ms: number, text: string) => (ms > SLOW_CLI_CALL_MS ? text : null)
    return {
      listBots: () => trace('orca bot list', () => cli.listBots(), (bots) => `${bots.length} bot(s)`),
      listBotChats: (botName) =>
        trace(
          `orca bot chats --bot ${botName}`,
          () => cli.listBotChats(botName),
          (chats, ms) => whenSlow(ms, `${chats.length} chat(s)`)
        ),
      readSession: (sessionId, limit) =>
        trace(
          `orca agent read ${sessionId}`,
          () => cli.readSession(sessionId, limit),
          (session, ms) => whenSlow(ms, `${session.entries.length} entries, state ${session.state ?? 'unknown'}`)
        ),
      renameChat: (sessionId, name) =>
        trace(`orca chat rename --session ${sessionId}`, () => cli.renameChat(sessionId, name)),
      listAutomations: () =>
        trace('orca automations list', () => cli.listAutomations(), (list) => `${list.length} automation(s)`),
      runAutomation: (id) => trace(`orca automations run ${id}`, () => cli.runAutomation(id)),
      sendToBot: (params) =>
        trace(
          `orca orchestration send --to bot:${params.botName} --chat ${params.chatId}`,
          () => cli.sendToBot(params),
          () => `body ${params.body.length} chars`
        )
    }
  }

  private updateInitialStatus(): void {
    if (!this.config.hasToken) {
      this.status = 'needs_token'
    } else if (!this.config.enabled) {
      this.status = 'stopped'
    } else {
      this.status = 'connecting'
    }
  }

  private emitState(): void {
    const state = this.getState()
    this.orca.panels.post('bridge.stateChanged', state)
    void this.syncStatusBar(state)
  }

  private async syncStatusBar(state: BridgeState): Promise<void> {
    let text = 'TG: Off'
    let tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' = 'neutral'
    let tooltip = 'Telegram Bridge'

    if (state.status === 'needs_token') {
      text = 'TG: Setup'
      tone = 'warning'
      tooltip = 'Telegram Bridge: add Bot Token in the Telegram panel'
    } else if (state.status === 'connecting') {
      text = 'TG: Connecting'
      tone = 'accent'
      tooltip = 'Telegram Bridge: connecting to Telegram...'
    } else if (state.status === 'connected') {
      text = state.botUsername ? `TG: @${state.botUsername}` : 'TG: Online'
      tone = 'success'
      tooltip = `Telegram Bridge connected -> ${state.config.defaultBot} (click to pause)`
    } else if (state.status === 'error') {
      text = 'TG: Error'
      tone = 'danger'
      tooltip = `Telegram Bridge error: ${state.lastError || 'unknown'}`
    } else {
      text = 'TG: Paused'
      tone = 'neutral'
      tooltip = 'Telegram Bridge paused (click to resume)'
    }

    try {
      await this.orca.host.call('statusBar.update', {
        id: STATUS_BAR_ID,
        text,
        tone,
        tooltip
      })
      this.lastFailures.delete('statusBar')
    } catch (err) {
      // Test hosts may not register statusBarItems; emitted on every state change, so logged once.
      if (!this.isRepeatedFailure('statusBar', err)) {
        await this.appendLog('debug', 'bridge', 'Updating the status bar failed', describeError(err))
      }
    }
  }
}

let activeController: TelegramBridgeController | null = null

export async function activateWithDeps(
  orca: OrcaWorkerApi,
  deps: BridgeDeps
): Promise<TelegramBridgeController> {
  const controller = new TelegramBridgeController(orca, deps)
  activeController = controller

  orca.panels.handle('bridge.getState', async () => {
    await controller.reloadFromSettingsAndSecrets()
    return controller.getState()
  })
  orca.panels.handle('bridge.saveConfig', (input) => controller.saveConfig(input))
  orca.panels.handle('bridge.testConnection', () => controller.testConnection())
  orca.panels.handle('bridge.togglePolling', () => controller.togglePolling())
  orca.panels.handle('bridge.allowUserId', ({ userId }) => controller.allowUserId(userId))
  orca.panels.handle('bridge.resetBinding', ({ tgChatId }) => controller.resetBinding(tgChatId))
  orca.panels.handle('bridge.clearLogs', () => controller.clearLogs())
  orca.panels.handle('bridge.setDebugLogging', ({ enabled }) => controller.setDebugLogging(Boolean(enabled)))
  orca.panels.handle('bridge.exportLogs', () => controller.exportLogs())

  orca.commands.register('telegram-bridge.togglePolling', async () => {
    const next = await controller.togglePolling()
    return `Telegram Bridge: ${next.status}`
  })
  orca.commands.register('telegram-bridge.testConnection', async () => {
    const res = await controller.testConnection()
    return res.ok ? `Connected as @${res.username || res.botId}` : `Failed: ${res.error}`
  })

  orca.settings.onDidChange(() => {
    void controller.reloadFromSettingsAndSecrets()
  })

  await controller.init()
  return controller
}

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  await activateWithDeps(orca, {
    telegram: createTelegramClient(),
    orcaCli: createOrcaCliRunner()
  })
}

export async function deactivate(): Promise<void> {
  if (activeController) {
    await activeController.dispose()
    activeController = null
  }
}
