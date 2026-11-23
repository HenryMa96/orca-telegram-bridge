import type { OrcaWorkerApi } from 'orca/worker'
import {
  createOrcaCliRunner,
  dispatchToOrcaBotAndWait,
  type OrcaCliRunner
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
  type TelegramClient,
  type TelegramMessage,
  type TelegramUpdate
} from './telegram-api'

const SECRET_BOT_TOKEN = 'botToken'
const STORAGE_OFFSET = 'tg.updateOffset'
const STORAGE_BINDINGS = 'tg.bindings'
const STORAGE_LOGS = 'tg.logs'
const STORAGE_LAST_BLOCKED = 'tg.lastBlockedUserId'
const STATUS_BAR_ID = 'telegram-status'
const MAX_LOGS = 60

export const TELEGRAM_COMMANDS: TelegramBotCommand[] = [
  { command: 'help', description: 'Show available commands' },
  { command: 'new', description: 'Start a fresh Orca chat session' },
  { command: 'bots', description: 'List available Orca bots' },
  { command: 'use', description: 'Switch target Orca bot (/use <name>)' },
  { command: 'chats', description: 'List recent chats of current bot' },
  { command: 'bind', description: 'Bind to an Orca chat (/bind <id>)' },
  { command: 'status', description: 'Show connection and session status' }
]

export type BridgeDeps = {
  telegram: TelegramClient
  orcaCli: OrcaCliRunner
  renderTable?: (table: ExtractedTable) => Promise<Buffer | null>
  pollIntervalMs?: number
  retryBackoffMs?: number
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
  private logs: BridgeLogEntry[] = []
  private updateOffset = 0
  private config: BridgeConfig = {
    hasToken: false,
    enabled: true,
    defaultBot: '',
    allowedUserIds: '',
    proxyUrl: '',
    replyTimeoutSec: 300
  }

  private cachedToken: string | null = null
  private commandsRegistered = false
  private pollAbort: AbortController | null = null
  private pollLoopPromise: Promise<void> | null = null
  private readonly chatQueues = new Map<string, Promise<void>>()
  private disposed = false

  constructor(orca: OrcaWorkerApi, deps: BridgeDeps) {
    this.orca = orca
    this.deps = deps
  }

  async init(): Promise<void> {
    await this.loadPersistedState()
    await this.refreshBots()
    this.updateInitialStatus()
    this.emitState()
    if (this.config.hasToken && this.config.enabled) {
      this.startPolling()
    }
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
    await this.loadPersistedState()
    await this.refreshBots()
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
      this.emitState()
    }
  }

  async saveConfig(input: SaveConfigInput): Promise<BridgeState> {
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

    await this.orca.settings.set('enabled', Boolean(input.enabled))
    await this.orca.settings.set('defaultBot', defaultBot)
    await this.orca.settings.set('allowedUserIds', input.allowedUserIds.trim())
    await this.orca.settings.set('proxyUrl', input.proxyUrl.trim())
    await this.orca.settings.set('replyTimeoutSec', timeout)

    this.config = {
      hasToken: Boolean(this.cachedToken),
      enabled: Boolean(input.enabled),
      defaultBot,
      allowedUserIds: input.allowedUserIds.trim(),
      proxyUrl: input.proxyUrl.trim(),
      replyTimeoutSec: timeout
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

    const msg = update.message
    if (!msg) return
    const text = (msg.text ?? msg.caption ?? '').trim()
    if (!text) return

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

    await this.enqueueChatWork(tgChatId, () => this.processAuthorizedMessage(msg, text))
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

  private async processAuthorizedMessage(msg: TelegramMessage, text: string): Promise<void> {
    const token = await this.readToken()
    if (!token) return

    const tgChatId = String(msg.chat.id)
    const senderLabel = formatSenderLabel(msg)

    if (text.startsWith('/')) {
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
    await this.appendLog('info', `[TG ${senderLabel} -> ${binding.botName}] ${text.slice(0, 120)}`)
    this.emitState()

    try {
      const result = await dispatchToOrcaBotAndWait(this.deps.orcaCli, {
        botName: binding.botName,
        boundChatId: binding.orcaChatId,
        tgChatId,
        senderLabel,
        userText: text,
        timeoutMs: this.config.replyTimeoutSec * 1000,
        pollIntervalMs: this.deps.pollIntervalMs,
        signal: this.pollAbort?.signal,
        onChatBound: async (chatId, title) => {
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

      await this.upsertBinding({
        tgChatId,
        botId: binding.botId,
        botName: binding.botName,
        orcaChatId: result.chatId,
        title: result.title || binding.title,
        updatedAt: Date.now()
      })

      const renderTable = this.deps.renderTable ?? renderTableToPng
      const { textWithMarkers, tables } = extractTablesFromMarkdown(result.replyText)
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
          : result.replyText

      const chunks = splitTelegramMessage(finalText, 3500)
      for (let i = 0; i < chunks.length; i++) {
        await this.safeSendTelegram(
          token,
          msg.chat.id,
          chunks[i],
          i === 0 ? msg.message_id : undefined,
          true
        )
      }

      if (renderedImages.length === tables.length) {
        for (const img of renderedImages) {
          await this.safeSendTelegramPhoto(
            token,
            msg.chat.id,
            img.png,
            `table-${img.index}.png`,
            tables.length > 1 ? `表格 ${img.index}` : undefined
          )
        }
      }

      await this.appendLog(
        'info',
        `[${binding.botName} -> TG ${tgChatId}] Sent ${chunks.length} message(s)${
          renderedImages.length === tables.length && renderedImages.length > 0
            ? ` + ${renderedImages.length} table image(s)`
            : ''
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
    }
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
        `当前连接 Bot：${binding.botName}`,
        `当前会话：${binding.orcaChatId || '(新会话，将在下一条消息创建)'}`,
        '',
        '可用指令：',
        '/bots - 列出本机所有 Orca Bot',
        '/use <名称> - 切换目标 Bot',
        '/new - 清空当前上下文，开启新对话',
        '/chats - 查看当前 Bot 的历史会话',
        '/bind <chatId> - 绑定到指定的 Orca 会话',
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
      await this.safeSendTelegram(token, msg.chat.id, lines.join('\n'), msg.message_id)
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
      await this.upsertBinding({
        tgChatId,
        botId: match.id,
        botName: match.name,
        orcaChatId: null,
        updatedAt: Date.now()
      })
      await this.appendLog('info', `Switched Telegram chat ${tgChatId} to bot "${match.name}".`)
      this.emitState()
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        `已切换到 Bot：${match.name}（下一条消息将新建会话）`,
        msg.message_id
      )
      return true
    }

    if (cmd === '/new') {
      await this.upsertBinding({
        tgChatId,
        botId: binding.botId,
        botName: binding.botName,
        orcaChatId: null,
        updatedAt: Date.now()
      })
      await this.appendLog('info', `Started fresh session binding for Telegram chat ${tgChatId}.`)
      this.emitState()
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        `已重置上下文，下一条消息将在 ${binding.botName} 中创建新会话。`,
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
              `• ${c.title || '(无标题)'}${c.id === binding.orcaChatId ? ' (当前)' : ''}\n  ID: ${c.id}`
          )
        : ['暂无可用会话。']
      await this.safeSendTelegram(token, msg.chat.id, lines.join('\n'), msg.message_id)
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
      await this.upsertBinding({
        tgChatId,
        botId: binding.botId,
        botName: binding.botName,
        orcaChatId: target.id,
        title: target.title,
        updatedAt: Date.now()
      })
      this.emitState()
      await this.safeSendTelegram(
        token,
        msg.chat.id,
        `已绑定到 ${binding.botName} 的会话：${target.title || target.id}`,
        msg.message_id
      )
      return true
    }

    if (cmd === '/status') {
      const lines = [
        `Telegram Bot: ${this.botUsername ? `@${this.botUsername}` : '未知'}`,
        `目标 Orca Bot: ${binding.botName}`,
        `绑定会话 ID: ${binding.orcaChatId || '(未创建，发消息自动新建)'}`,
        `轮询状态: ${this.status}`
      ]
      await this.safeSendTelegram(token, msg.chat.id, lines.join('\n'), msg.message_id)
      return true
    }

    return false
  }

  private async safeSendTelegram(
    token: string,
    chatId: number | string,
    text: string,
    replyToMessageId?: number,
    formatMarkdown = false
  ): Promise<void> {
    if (formatMarkdown) {
      const html = markdownToTelegramHtml(text)
      if (html.length <= 4096) {
        try {
          await this.deps.telegram.sendMessage(
            token,
            { chatId, text: html, replyToMessageId, parseMode: 'HTML' },
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
        { chatId, text, replyToMessageId },
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
  }

  private async stopPolling(): Promise<void> {
    if (this.pollAbort) {
      this.pollAbort.abort()
      this.pollAbort = null
    }
    if (this.pollLoopPromise) {
      await this.pollLoopPromise
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
          : 300
    }

    const savedOffset = await this.orca.storage.get(STORAGE_OFFSET)
    this.updateOffset = typeof savedOffset === 'number' ? savedOffset : 0

    const savedBindings = await this.orca.storage.get(STORAGE_BINDINGS)
    this.bindings = Array.isArray(savedBindings) ? (savedBindings as ChatBinding[]) : []

    const savedLogs = await this.orca.storage.get(STORAGE_LOGS)
    this.logs = Array.isArray(savedLogs) ? (savedLogs as BridgeLogEntry[]) : []

    const savedBlocked = await this.orca.storage.get(STORAGE_LAST_BLOCKED)
    this.lastBlockedUserId = typeof savedBlocked === 'string' ? savedBlocked : null
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
