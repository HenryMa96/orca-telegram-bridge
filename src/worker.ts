import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  computeTailHashes,
  createOrcaCliRunner,
  dispatchToOrcaBotAndWait,
  extractMessageItems,
  findUnsyncedTail,
  isTelegramOriginatedUserMessage,
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
const MAX_LOGS = 60

type SyncCursor = {
  tailHashes: string[]
  lastActivityAt?: number
  pendingWorking?: boolean
}

export const TELEGRAM_COMMANDS: TelegramBotCommand[] = [
  { command: 'help', description: 'Show available commands' },
  { command: 'new', description: 'Start a fresh Orca chat session' },
  { command: 'home', description: 'Bind to current bot Home Chat' },
  { command: 'bots', description: 'List & switch Orca bots' },
  { command: 'use', description: 'Switch target Orca bot (/use <name>)' },
  { command: 'chats', description: 'List & switch recent Orca chats' },
  { command: 'bind', description: 'Bind to an Orca chat (/bind <id>)' },
  { command: 'rename', description: 'Rename bound Orca chat (/rename <title>)' },
  { command: 'sync', description: 'Toggle Orca -> TG sync (/sync on|off)' },
  { command: 'automations', description: 'List & trigger Orca automations' },
  { command: 'run', description: 'Run an automation now (/run <id>)' },
  { command: 'status', description: 'Show connection and session status' }
]

export type BridgeDeps = {
  telegram: TelegramClient
  orcaCli: OrcaCliRunner
  renderTable?: (table: ExtractedTable) => Promise<Buffer | null>
  downloadDir?: string
  pollIntervalMs?: number
  outboundPollIntervalMs?: number
  retryBackoffMs?: number
}

type IncomingTelegramImage = {
  fileId: string
  mimeType?: string
  preferredExt?: string
}

const ALLOWED_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'])

function extractIncomingImage(msg: TelegramMessage): IncomingTelegramImage | null {
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo.reduce((best, item) => {
      const bestScore = best.file_size ?? best.width * best.height
      const itemScore = item.file_size ?? item.width * item.height
      return itemScore >= bestScore ? item : best
    })
    return { fileId: largest.file_id, preferredExt: '.jpg' }
  }
  if (msg.document && msg.document.mime_type?.toLowerCase().startsWith('image/')) {
    const docExt = msg.document.file_name
      ? path.extname(msg.document.file_name).toLowerCase()
      : ''
    return {
      fileId: msg.document.file_id,
      mimeType: msg.document.mime_type,
      preferredExt: ALLOWED_IMAGE_EXTS.has(docExt) ? docExt : undefined
    }
  }
  return null
}

function resolveSafeImageExt(
  filePath?: string,
  mimeType?: string,
  preferredExt?: string
): string {
  const fromPath = filePath ? path.extname(filePath).toLowerCase() : ''
  if (ALLOWED_IMAGE_EXTS.has(fromPath)) return fromPath
  if (preferredExt && ALLOWED_IMAGE_EXTS.has(preferredExt)) return preferredExt
  const mime = mimeType?.toLowerCase()
  if (mime === 'image/png') return '.png'
  if (mime === 'image/webp') return '.webp'
  if (mime === 'image/gif') return '.gif'
  if (mime === 'image/bmp') return '.bmp'
  return '.jpg'
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
    syncOrcaOutbound: false
  }

  private cachedToken: string | null = null
  private commandsRegistered = false
  private pollAbort: AbortController | null = null
  private pollLoopPromise: Promise<void> | null = null
  private outboundLoopPromise: Promise<void> | null = null
  private readonly chatQueues = new Map<string, Promise<void>>()
  private readonly activeTelegramTgChats = new Set<string>()
  private readonly activeTelegramOrcaChats = new Set<string>()
  private outboundSyncRunning = false
  private disposed = false
  private backgroundBotsRefresh: Promise<void> | null = null

  constructor(orca: OrcaWorkerApi, deps: BridgeDeps) {
    this.orca = orca
    this.deps = deps
  }

  async init(): Promise<void> {
    await this.loadPersistedState()
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
  }

  getState(): BridgeState {
    return {
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
      logs: [...this.logs]
    }
  }

  async reloadFromSettingsAndSecrets(): Promise<void> {
    const prevSync = this.config.syncOrcaOutbound
    await this.loadPersistedState()
    this.refreshBotsInBackground()
    if (!prevSync && this.config.syncOrcaOutbound) {
      await this.resetSyncCursors()
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
      if (this.config.syncOrcaOutbound && !this.outboundLoopPromise) {
        this.ensureOutboundLoopStarted(this.pollAbort)
      }
      this.emitState()
    }
  }

  async saveConfig(input: SaveConfigInput): Promise<BridgeState> {
    const prevSync = this.config.syncOrcaOutbound
    if (input.clearToken) {
      try {
        await this.orca.secrets.delete(SECRET_BOT_TOKEN)
      } catch {
        // Ignore if secret backend unavailable.
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

    await this.orca.settings.set('enabled', Boolean(input.enabled))
    await this.orca.settings.set('defaultBot', defaultBot)
    await this.orca.settings.set('allowedUserIds', input.allowedUserIds.trim())
    await this.orca.settings.set('proxyUrl', input.proxyUrl.trim())
    await this.orca.settings.set('replyTimeoutSec', timeout)
    await this.orca.settings.set('syncOrcaOutbound', syncOrcaOutbound)

    this.config = {
      hasToken: Boolean(this.cachedToken),
      enabled: Boolean(input.enabled),
      defaultBot,
      allowedUserIds: input.allowedUserIds.trim(),
      proxyUrl: input.proxyUrl.trim(),
      replyTimeoutSec: timeout,
      syncOrcaOutbound
    }
    if (!prevSync && syncOrcaOutbound) {
      await this.resetSyncCursors()
    }
    this.lastError = null
    await this.refreshBots()
    await this.appendLog('info', 'Configuration saved.')

    await this.stopPolling()
    if (!this.config.hasToken) {
      this.status = 'needs_token'
      this.botUsername = null
      this.botDisplayName = null
    } else if (this.config.enabled) {
      this.startPolling()
    } else {
      this.status = 'stopped'
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
      await this.appendLog('info', `Verified Telegram bot @${me.username || me.id}`)
      this.emitState()
      return { ok: true, username: me.username, botId: me.id, state: this.getState() }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.lastError = message
      this.status = 'error'
      await this.appendLog('error', `Telegram connection test failed: ${message}`)
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
      await this.appendLog('info', 'Telegram polling resumed.')
    } else {
      await this.stopPolling()
      this.status = 'stopped'
      await this.appendLog('info', 'Telegram polling paused.')
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
    await this.appendLog('info', `Added Telegram user ${clean} to allowlist.`)
    this.emitState()
    return this.getState()
  }

  async resetBinding(tgChatId: string): Promise<BridgeState> {
    this.bindings = this.bindings.filter((b) => b.tgChatId !== tgChatId)
    await this.orca.storage.set(STORAGE_BINDINGS, this.bindings)
    await this.pruneUnusedSyncCursors()
    await this.appendLog('info', `Reset Orca chat binding for Telegram chat ${tgChatId}.`)
    this.emitState()
    return this.getState()
  }

  async clearLogs(): Promise<BridgeState> {
    this.logs = []
    await this.orca.storage.set(STORAGE_LOGS, [])
    this.emitState()
    return this.getState()
  }

  async handleIncomingUpdate(update: TelegramUpdate): Promise<void> {
    if (update.update_id >= this.updateOffset) {
      this.updateOffset = update.update_id + 1
      await this.orca.storage.set(STORAGE_OFFSET, this.updateOffset)
    }

    if (update.callback_query) {
      await this.handleIncomingCallbackQuery(update.callback_query)
      return
    }

    const msg = update.message
    if (!msg) return
    const text = (msg.text ?? msg.caption ?? '').trim()
    const image = extractIncomingImage(msg)
    if (!text && !image) return

    const tgChatId = String(msg.chat.id)
    const fromId = msg.from ? String(msg.from.id) : tgChatId
    const allowed = parseAllowedIds(this.config.allowedUserIds)

    if (!allowed.has(fromId) && !allowed.has(tgChatId)) {
      this.lastBlockedUserId = fromId
      await this.orca.storage.set(STORAGE_LAST_BLOCKED, fromId)
      await this.appendLog('warn', `Blocked unauthorized Telegram user ${fromId} (${formatSenderLabel(msg)}).`)
      this.emitState()

      const token = await this.readToken()
      if (token && allowed.size === 0) {
        await this.safeSendTelegram(
          token,
          msg.chat.id,
          `未授权访问。你的 Telegram ID 是 ${fromId}，请先在 Orca 的 Telegram 面板中将其加入白名单。`,
          msg.message_id
        )
      }
      return
    }

    await this.enqueueChatWork(tgChatId, () => this.processAuthorizedMessage(msg, text, image))
  }

  private async handleIncomingCallbackQuery(cq: TelegramCallbackQuery): Promise<void> {
    const fromId = String(cq.from.id)
    const tgChatId = cq.message ? String(cq.message.chat.id) : fromId
    const allowed = parseAllowedIds(this.config.allowedUserIds)
    const token = await this.readToken()

    if (!allowed.has(fromId) && !allowed.has(tgChatId)) {
      this.lastBlockedUserId = fromId
      await this.orca.storage.set(STORAGE_LAST_BLOCKED, fromId)
      await this.appendLog('warn', `Blocked unauthorized Telegram callback from ${fromId}.`)
      this.emitState()
      if (token) {
        await this.safeAnswerCallbackQuery(token, cq.id, '未授权访问，请先加入白名单。', true)
      }
      return
    }

    if (!token || !cq.message || !cq.data) {
      if (token) {
        await this.safeAnswerCallbackQuery(token, cq.id)
      }
      return
    }

    await this.enqueueChatWork(tgChatId, () => this.processCallbackQuery(token, cq))
  }

  private enqueueChatWork(tgChatId: string, work: () => Promise<void>): Promise<void> {
    const prev = this.chatQueues.get(tgChatId) ?? Promise.resolve()
    const next = prev
      .catch(() => {})
      .then(work)
      .finally(() => {
        if (this.chatQueues.get(tgChatId) === next) {
          this.chatQueues.delete(tgChatId)
        }
      })
    this.chatQueues.set(tgChatId, next)
    return next
  }

  private async processAuthorizedMessage(
    msg: TelegramMessage,
    text: string,
    image: IncomingTelegramImage | null = null
  ): Promise<void> {
    const token = await this.readToken()
    if (!token) return

    const tgChatId = String(msg.chat.id)
    const senderLabel = formatSenderLabel(msg)

    if (!image && text.startsWith('/')) {
      const handled = await this.handleSlashCommand(token, msg, text)
      if (handled) return
    }

    const binding = await this.resolveBindingBot(await this.getOrCreateBinding(tgChatId))
    if (!binding.botName) {
      await this.appendLog('error', 'No Orca bots found to route incoming Telegram message.')
      this.emitState()
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        '当前未检测到可用的 Orca Bot，请先在 Orca 中创建至少一个 Bot。',
        msg.message_id
      )
      return
    }
    const logPreview = text ? text.slice(0, 120) : '[Image]'
    await this.appendLog(
      'info',
      `[TG ${senderLabel} -> ${binding.botName}] ${image && text ? `[Image] ${logPreview}` : logPreview}`
    )
    this.emitState()

    this.activeTelegramTgChats.add(tgChatId)
    if (binding.orcaChatId) {
      this.activeTelegramOrcaChats.add(binding.orcaChatId)
    }

    let boundOrcaChatId = binding.orcaChatId
    try {
      const imagePaths: string[] = []
      if (image) {
        try {
          await this.deps.telegram.sendChatAction(
            token,
            { chatId: msg.chat.id, action: 'typing' },
            { proxyUrl: this.config.proxyUrl, timeoutMs: 8000 }
          )
        } catch {
          // Non-fatal typing failure.
        }
        const savedPath = await this.downloadTelegramImage(token, image, msg.message_id)
        imagePaths.push(savedPath)
      }

      const result = await dispatchToOrcaBotAndWait(this.deps.orcaCli, {
        botName: binding.botName,
        boundChatId: binding.orcaChatId,
        tgChatId,
        senderLabel,
        userText: text,
        imagePaths,
        timeoutMs: this.config.replyTimeoutSec * 1000,
        pollIntervalMs: this.deps.pollIntervalMs,
        signal: this.pollAbort?.signal,
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
        onWorkingTick: async () => {
          try {
            await this.deps.telegram.sendChatAction(
              token,
              { chatId: msg.chat.id, action: 'typing' },
              { proxyUrl: this.config.proxyUrl, timeoutMs: 8000 }
            )
          } catch {
            // Non-fatal typing failure.
          }
        }
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
        result.replyText,
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
        `[${binding.botName} -> TG ${tgChatId}] Sent ${delivery.messageCount} message(s)${
          delivery.imageCount > 0 ? ` + ${delivery.imageCount} table image(s)` : ''
        }.`
      )
      this.emitState()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.appendLog('error', `Failed handling message for ${binding.botName}: ${message}`)
      this.emitState()
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        `处理失败：${message}`,
        msg.message_id
      )
    } finally {
      this.activeTelegramTgChats.delete(tgChatId)
      if (boundOrcaChatId) {
        this.activeTelegramOrcaChats.delete(boundOrcaChatId)
      }
    }
  }

  private async downloadTelegramImage(
    token: string,
    image: IncomingTelegramImage,
    messageId: number
  ): Promise<string> {
    const fileMeta = await this.deps.telegram.getFile(token, image.fileId, {
      proxyUrl: this.config.proxyUrl,
      timeoutMs: 15_000,
      signal: this.pollAbort?.signal
    })
    if (!fileMeta.file_path) {
      throw new Error('Telegram did not return a downloadable file_path for this image.')
    }
    const bytes = await this.deps.telegram.downloadFile(token, fileMeta.file_path, {
      proxyUrl: this.config.proxyUrl,
      timeoutMs: 30_000,
      signal: this.pollAbort?.signal
    })

    const dir = this.deps.downloadDir ?? path.join(os.tmpdir(), 'orca-telegram-bridge', 'images')
    await fs.mkdir(dir, { recursive: true })
    await this.cleanupOldDownloadedImages(dir)

    const ext = resolveSafeImageExt(fileMeta.file_path, image.mimeType, image.preferredExt)
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
        } catch {
          // Best-effort cleanup.
        }
      }
    } catch {
      // Best-effort cleanup.
    }
  }

  private async sendFormattedReplyToTelegram(
    token: string,
    chatId: number | string,
    rawMarkdown: string,
    replyToMessageId?: number
  ): Promise<{ messageCount: number; imageCount: number }> {
    const renderTable = this.deps.renderTable ?? renderTableToPng
    const { textWithMarkers, tables } = extractTablesFromMarkdown(rawMarkdown)
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
          tables.length > 1 ? `表格 ${img.index}` : undefined
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
    const binding = await this.resolveBindingBot(await this.getOrCreateBinding(tgChatId))

    if (cmd === '/start' || cmd === '/help') {
      const helpText = [
        `当前连接 Bot：${binding.botName || '(未检测到)'}`,
        `当前会话：${binding.orcaChatId || '(新会话，将在下一条消息创建)'}`,
        `双向同步 (Orca -> TG)：${this.config.syncOrcaOutbound ? '开启' : '关闭'}`,
        '',
        '可用指令：',
        '/bots - 列出并点击切换 Orca Bot',
        '/use <名称> - 切换目标 Bot',
        '/chats - 查看并点击绑定历史会话',
        '/home - 绑定当前 Bot 的 Home Chat',
        '/new - 清空当前上下文，开启新对话',
        '/bind <chatId> - 绑定到指定的 Orca 会话',
        '/rename <新标题> - 重命名当前绑定的会话',
        '/sync [on|off] - 开关 Orca 端消息双向同步',
        '/automations - 查看并触发自动化任务',
        '/run <id> - 立即执行指定自动化任务',
        '/status - 查看连接与会话状态'
      ].join('\n')
      await this.safeSendTelegram(token, msg.chat.id, helpText, msg.message_id)
      return true
    }

    if (cmd === '/bots') {
      await this.refreshBots()
      const lines = this.bots.length
        ? this.bots.map(
            (b) => `• ${b.name}${b.name === binding.botName ? ' (当前)' : ''}${b.specialty ? ` — ${b.specialty}` : ''}`
          )
        : ['未检测到 Orca Bot。']
      const keyboardRows: TelegramInlineKeyboardButton[][] = []
      for (let i = 0; i < this.bots.length; i += 2) {
        keyboardRows.push(
          this.bots.slice(i, i + 2).map((b) => ({
            text: `${b.name === binding.botName ? '✓ ' : ''}${b.name.slice(0, 24)}`,
            callback_data: `u:${b.id}`
          }))
        )
      }
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        lines.join('\n'),
        msg.message_id,
        false,
        keyboardRows.length > 0 ? { inline_keyboard: keyboardRows } : undefined
      )
      return true
    }

    if (cmd === '/use') {
      if (!arg) {
        await this.safeSendTelegram(token, msg.chat.id, '用法：/use <Bot名称>', msg.message_id)
        return true
      }
      await this.refreshBots()
      const match = this.bots.find((b) => b.name.toLowerCase() === arg.toLowerCase())
      if (!match) {
        const names = this.bots.map((b) => b.name).join('、') || '无'
        await this.safeSendTelegram(
          token,
          msg.chat.id,
          `未找到名为 "${arg}" 的 Bot。可用 Bot：${names}`,
          msg.message_id
        )
        return true
      }
      await this.switchBotForChat(tgChatId, match)
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        `已切换到 Bot：${match.name}（下一条消息将新建会话）`,
        msg.message_id
      )
      return true
    }

    if (cmd === '/new') {
      await this.resetChatSessionForBinding(tgChatId, binding)
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        `已重置上下文，下一条消息将在 ${binding.botName} 中创建新会话。`,
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
          `未找到 ${binding.botName} 的可用 Home Chat。`,
          msg.message_id
        )
        return true
      }
      await this.bindSpecificChat(tgChatId, binding, homeChat)
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        `已绑定到 ${binding.botName} 的 Home Chat（${homeChat.id}）。`,
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
              `• ${c.title || '(无标题)'}${c.home ? ' [Home]' : ''}${c.id === binding.orcaChatId ? ' (当前)' : ''}\n  ID: ${c.id}`
          )
        : ['暂无可用会话。']
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
        { text: '➕ 新建会话', callback_data: 'c:new' }
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
        await this.safeSendTelegram(token, msg.chat.id, '用法：/bind <Orca chatId>', msg.message_id)
        return true
      }
      const chats = await this.deps.orcaCli.listBotChats(binding.botName)
      const target = chats.find((c) => c.id === arg && !c.closed)
      if (!target) {
        await this.safeSendTelegram(
          token,
          msg.chat.id,
          `在 ${binding.botName} 中未找到未关闭的会话 ${arg}。`,
          msg.message_id
        )
        return true
      }
      await this.bindSpecificChat(tgChatId, binding, target)
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        `已绑定到 ${binding.botName} 的会话：${target.title || target.id}`,
        msg.message_id
      )
      return true
    }

    if (cmd === '/rename') {
      if (!arg) {
        await this.safeSendTelegram(token, msg.chat.id, '用法：/rename <新标题>', msg.message_id)
        return true
      }
      if (!binding.orcaChatId) {
        await this.safeSendTelegram(
          token,
          msg.chat.id,
          '当前还没有绑定的 Orca 会话，请先发送一条消息或用 /bind 绑定会话。',
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
        await this.appendLog('info', `Renamed Orca chat ${binding.orcaChatId} to "${arg}".`)
        this.emitState()
        await this.safeSendTelegram(token, msg.chat.id, `已将当前会话重命名为：${arg}`, msg.message_id)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await this.safeSendTelegram(token, msg.chat.id, `重命名失败：${message}`, msg.message_id)
      }
      return true
    }

    if (cmd === '/sync') {
      const normalized = arg.toLowerCase()
      if (!normalized) {
        await this.safeSendTelegram(
          token,
          msg.chat.id,
          `双向同步 (Orca -> TG) 当前状态：${this.config.syncOrcaOutbound ? '开启' : '关闭'}`,
          msg.message_id,
          false,
          {
            inline_keyboard: [
              [
                {
                  text: `${this.config.syncOrcaOutbound ? '✓ ' : ''}开启双向同步`,
                  callback_data: 's:on'
                },
                {
                  text: `${!this.config.syncOrcaOutbound ? '✓ ' : ''}关闭双向同步`,
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
        await this.safeSendTelegram(token, msg.chat.id, '已开启 Orca -> Telegram 双向同步。', msg.message_id)
        return true
      }
      if (['off', 'false', '0', 'disable'].includes(normalized)) {
        await this.setSyncOrcaOutbound(false)
        await this.safeSendTelegram(token, msg.chat.id, '已关闭 Orca -> Telegram 双向同步。', msg.message_id)
        return true
      }
      await this.safeSendTelegram(token, msg.chat.id, '用法：/sync [on|off]', msg.message_id)
      return true
    }

    if (cmd === '/automations') {
      try {
        const automations = await this.deps.orcaCli.listAutomations()
        if (automations.length === 0) {
          await this.safeSendTelegram(token, msg.chat.id, '当前没有已配置的自动化任务。', msg.message_id)
          return true
        }
        const slice = automations.slice(0, 8)
        const lines = slice.map((a) => {
          const stateText = a.enabled ? '启用' : '停用'
          const lastText = a.lastRunStatus ? `，上次：${a.lastRunStatus}` : ''
          return `• ${a.name} (${stateText}${lastText})\n  ID: ${a.id}`
        })
        const keyboardRows: TelegramInlineKeyboardButton[][] = slice.map((a) => [
          {
            text: `▶️ 运行：${a.name.slice(0, 26)}`,
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
        await this.safeSendTelegram(token, msg.chat.id, `获取自动化任务失败：${message}`, msg.message_id)
      }
      return true
    }

    if (cmd === '/run') {
      if (!arg) {
        await this.safeSendTelegram(
          token,
          msg.chat.id,
          '用法：/run <automationId>（可先用 /automations 查看任务 ID 或直接点击按钮运行）',
          msg.message_id
        )
        return true
      }
      try {
        await this.deps.orcaCli.runAutomation(arg)
        await this.appendLog('info', `Triggered Orca automation ${arg} from Telegram.`)
        this.emitState()
        await this.safeSendTelegram(token, msg.chat.id, `已触发自动化任务：${arg}`, msg.message_id)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await this.safeSendTelegram(token, msg.chat.id, `触发失败：${message}`, msg.message_id)
      }
      return true
    }

    if (cmd === '/status') {
      const lines = [
        `Telegram Bot: ${this.botUsername ? `@${this.botUsername}` : '未知'}`,
        `目标 Orca Bot: ${binding.botName}`,
        `绑定会话 ID: ${binding.orcaChatId || '(未创建，发消息自动新建)'}`,
        `双向同步 (Orca -> TG): ${this.config.syncOrcaOutbound ? '开启' : '关闭'}`,
        `轮询状态: ${this.status}`
      ]
      await this.safeSendTelegram(token, msg.chat.id, lines.join('\n'), msg.message_id)
      return true
    }

    return false
  }

  private async processCallbackQuery(token: string, cq: TelegramCallbackQuery): Promise<void> {
    const msg = cq.message
    const data = cq.data || ''
    if (!msg) return
    const tgChatId = String(msg.chat.id)
    const binding = await this.resolveBindingBot(await this.getOrCreateBinding(tgChatId))

    if (data.startsWith('u:')) {
      const botId = data.slice(2)
      await this.refreshBots()
      const match = this.bots.find((b) => b.id === botId)
      if (!match) {
        await this.safeAnswerCallbackQuery(token, cq.id, '未找到该 Bot，请重新运行 /bots。', true)
        return
      }
      await this.switchBotForChat(tgChatId, match)
      await this.safeAnswerCallbackQuery(token, cq.id, `已切换到 ${match.name}`)
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        `已切换到 Bot：${match.name}（下一条消息将新建会话）`
      )
      return
    }

    if (data.startsWith('b:')) {
      const chatId = data.slice(2)
      const chats = await this.deps.orcaCli.listBotChats(binding.botName)
      const target = chats.find((c) => c.id === chatId && !c.closed)
      if (!target) {
        await this.safeAnswerCallbackQuery(token, cq.id, '会话已关闭或不存在，请重新运行 /chats。', true)
        return
      }
      await this.bindSpecificChat(tgChatId, binding, target)
      await this.safeAnswerCallbackQuery(token, cq.id, '已绑定会话')
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        `已绑定到 ${binding.botName} 的会话：${target.title || target.id}`
      )
      return
    }

    if (data === 'c:new') {
      await this.resetChatSessionForBinding(tgChatId, binding)
      await this.safeAnswerCallbackQuery(token, cq.id, '已重置上下文')
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        `已重置上下文，下一条消息将在 ${binding.botName} 中创建新会话。`
      )
      return
    }

    if (data === 'c:home') {
      const chats = await this.deps.orcaCli.listBotChats(binding.botName)
      const homeChat = chats.find((c) => c.home && !c.closed)
      if (!homeChat) {
        await this.safeAnswerCallbackQuery(token, cq.id, '未找到 Home Chat。', true)
        return
      }
      await this.bindSpecificChat(tgChatId, binding, homeChat)
      await this.safeAnswerCallbackQuery(token, cq.id, '已绑定 Home Chat')
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        `已绑定到 ${binding.botName} 的 Home Chat（${homeChat.id}）。`
      )
      return
    }

    if (data === 's:on' || data === 's:off') {
      const enabled = data === 's:on'
      await this.setSyncOrcaOutbound(enabled)
      await this.safeAnswerCallbackQuery(
        token,
        cq.id,
        enabled ? '已开启双向同步' : '已关闭双向同步'
      )
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        enabled ? '已开启 Orca -> Telegram 双向同步。' : '已关闭 Orca -> Telegram 双向同步。'
      )
      return
    }

    if (data.startsWith('r:')) {
      const automationId = data.slice(2)
      try {
        await this.deps.orcaCli.runAutomation(automationId)
        await this.appendLog('info', `Triggered Orca automation ${automationId} via Telegram button.`)
        this.emitState()
        await this.safeAnswerCallbackQuery(token, cq.id, '已触发自动化任务')
        await this.safeSendTelegram(token, msg.chat.id, `已触发自动化任务：${automationId}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await this.safeAnswerCallbackQuery(token, cq.id, `触发失败：${message.slice(0, 120)}`, true)
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
    await this.appendLog('info', `Switched Telegram chat ${tgChatId} to bot "${match.name}".`)
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
    await this.appendLog('info', `Started fresh session binding for Telegram chat ${tgChatId}.`)
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
    } catch {
      // Cursor will baseline on next sync tick if needed.
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
    if (enabled && this.pollAbort && !this.outboundLoopPromise) {
      this.ensureOutboundLoopStarted(this.pollAbort)
    }
    await this.appendLog(
      'info',
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
    } catch {
      // Non-fatal callback ack failure.
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
        } catch {
          // Fall back to plain text below if HTML formatting or length fails.
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
      await this.appendLog('error', `Failed sending Telegram reply: ${message}`)
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
      await this.appendLog('error', `Failed sending Telegram table image: ${message}`)
    }
  }

  private async ensureCommandsRegistered(token: string, signal?: AbortSignal): Promise<void> {
    if (this.commandsRegistered) return
    try {
      await this.deps.telegram.setMyCommands(token, TELEGRAM_COMMANDS, {
        proxyUrl: this.config.proxyUrl,
        timeoutMs: 10_000,
        signal
      })
      this.commandsRegistered = true
      await this.appendLog('info', 'Registered Telegram slash command menu.')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.orca.log(`[warn] Failed to register Telegram commands: ${message}`)
    }
  }

  private startPolling(): void {
    if (this.disposed || this.pollAbort) return
    const abort = new AbortController()
    this.pollAbort = abort
    this.status = 'connecting'
    this.lastError = null
    this.emitState()

    this.pollLoopPromise = this.runPollLoop(abort).finally(() => {
      if (this.pollAbort === abort) {
        this.pollAbort = null
      }
      this.pollLoopPromise = null
    })

    if (this.config.syncOrcaOutbound) {
      this.ensureOutboundLoopStarted(abort)
    }
  }

  private ensureOutboundLoopStarted(abort: AbortController): void {
    if (this.disposed || this.outboundLoopPromise) return
    this.outboundLoopPromise = this.runOutboundSyncLoop(abort).finally(() => {
      this.outboundLoopPromise = null
    })
  }

  private async stopPolling(): Promise<void> {
    if (this.pollAbort) {
      this.pollAbort.abort()
      this.pollAbort = null
    }
    if (this.pollLoopPromise) {
      await this.pollLoopPromise
    }
    if (this.outboundLoopPromise) {
      await this.outboundLoopPromise
    }
  }

  private async runOutboundSyncLoop(abort: AbortController): Promise<void> {
    const intervalMs = this.deps.outboundPollIntervalMs ?? 3000
    while (!abort.signal.aborted && !this.disposed) {
      await sleep(intervalMs, abort.signal)
      if (abort.signal.aborted || this.disposed) break
      if (!this.config.syncOrcaOutbound || !this.config.enabled) continue
      try {
        await this.syncOrcaBoundChatsOnce()
      } catch (err) {
        if (abort.signal.aborted || this.disposed) break
        const msg = err instanceof Error ? err.message : String(err)
        this.orca.log(`[warn] Orca outbound sync error: ${msg}`)
      }
    }
  }

  async syncOrcaBoundChatsOnce(): Promise<void> {
    if (this.disposed || !this.config.syncOrcaOutbound || this.outboundSyncRunning) return
    const token = await this.readToken()
    if (!token) return
    const allowed = parseAllowedIds(this.config.allowedUserIds)
    if (allowed.size === 0) return

    const boundList = this.bindings.filter((b) => Boolean(b.orcaChatId))
    if (boundList.length === 0) return

    this.outboundSyncRunning = true
    try {
      const byBot = new Map<string, ChatBinding[]>()
      for (const rawBinding of boundList) {
        const binding = await this.resolveBindingBot(rawBinding)
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
        } catch {
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

    let session
    try {
      session = await this.deps.orcaCli.readSession(orcaChatId, 80)
    } catch {
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
          const userPayload = `🗣️ **你在 Orca (${binding.botName}) 发送：**\n\n${item.text}`
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
        `[Orca -> TG ${binding.tgChatId}] Synced ${forwardedUserCount} user + ${forwardedAssistantCount} assistant message(s) from ${binding.botName}.`
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
      await this.orca.storage.set(STORAGE_SYNC_CURSORS, this.syncCursors)
    } catch {
      // Non-fatal in mock/read-only runs.
    }
  }

  private async runPollLoop(abort: AbortController): Promise<void> {
    let backoffMs = this.deps.retryBackoffMs ?? 2000

    while (!abort.signal.aborted && !this.disposed) {
      const token = await this.readToken()
      if (!token) {
        this.status = 'needs_token'
        this.emitState()
        break
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

        if (this.status !== 'connected') {
          this.status = 'connected'
          this.lastError = null
          await this.appendLog(
            'info',
            `Connected to Telegram as @${this.botUsername || 'bot'}.`
          )
          this.emitState()
        }

        const updates = await this.deps.telegram.getUpdates(
          token,
          { offset: this.updateOffset || undefined, timeoutSec: 25 },
          { proxyUrl: this.config.proxyUrl, signal: abort.signal }
        )

        this.lastPollAt = Date.now()
        backoffMs = this.deps.retryBackoffMs ?? 2000

        for (const update of updates) {
          if (abort.signal.aborted || this.disposed) break
          await this.handleIncomingUpdate(update)
        }
      } catch (err) {
        if (abort.signal.aborted || this.disposed) break
        const message = err instanceof Error ? err.message : String(err)
        const isAuthError = err instanceof TelegramApiError && err.statusCode === 401
        this.status = 'error'
        this.lastError = message
        await this.appendLog('error', `Polling error: ${message}`)
        this.emitState()

        if (isAuthError) {
          break
        }
        await sleep(backoffMs, abort.signal)
        backoffMs = Math.min(30_000, backoffMs * 2)
      }
    }
  }

  private async loadPersistedState(): Promise<void> {
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
        typeof settings.syncOrcaOutbound === 'boolean' ? settings.syncOrcaOutbound : false
    }

    const savedOffset = await this.orca.storage.get(STORAGE_OFFSET)
    this.updateOffset = typeof savedOffset === 'number' ? savedOffset : 0

    const savedBindings = await this.orca.storage.get(STORAGE_BINDINGS)
    this.bindings = Array.isArray(savedBindings) ? (savedBindings as ChatBinding[]) : []

    const savedLogs = await this.orca.storage.get(STORAGE_LOGS)
    this.logs = Array.isArray(savedLogs) ? (savedLogs as BridgeLogEntry[]) : []

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
      return this.cachedToken
    } catch {
      return this.cachedToken
    }
  }

  private async refreshBots(): Promise<void> {
    try {
      this.bots = await this.deps.orcaCli.listBots()
      if (
        this.bots.length > 0 &&
        !this.bots.some((b) => b.name === this.config.defaultBot)
      ) {
        this.config.defaultBot = this.bots[0].name
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.orca.log(`[warn] Failed to list Orca bots: ${msg}`)
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
        `Updated binding ${binding.tgChatId} from "${binding.botName}" to "${fallback.name}".`
      )
      return updated
    }
    return binding
  }

  private async getOrCreateBinding(tgChatId: string): Promise<ChatBinding> {
    const existing = this.bindings.find((b) => b.tgChatId === tgChatId)
    if (existing) return existing
    const defaultMatch = this.bots.find((b) => b.name === this.config.defaultBot) || this.bots[0]
    const created: ChatBinding = {
      tgChatId,
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
      this.bindings[idx] = binding
    } else {
      this.bindings.push(binding)
    }
    await this.orca.storage.set(STORAGE_BINDINGS, this.bindings)
  }

  private async appendLog(level: BridgeLogEntry['level'], message: string): Promise<void> {
    const entry: BridgeLogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      at: Date.now(),
      level,
      message
    }
    this.logs = [entry, ...this.logs].slice(0, MAX_LOGS)
    this.orca.log(`[${level}] ${message}`)
    try {
      await this.orca.storage.set(STORAGE_LOGS, this.logs)
    } catch {
      // Non-fatal in mock/read-only runs.
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
    } catch {
      // Ignored in test hosts that do not register statusBarItems.
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
