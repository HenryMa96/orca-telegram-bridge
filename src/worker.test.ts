import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { assert, mockHost, mountWorker, test, type MockHost } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { t } from './i18n'
import {
  computeTailHashes,
  extractMessageItems,
  findUnsyncedTail,
  OrcaCliError,
  type OrcaChatSummary,
  type OrcaCliRunner,
  type OrcaSessionRead
} from './orca-bridge'
import type { BridgeLogEntry, BridgeState, ExportLogsResult } from './protocol'
import { extractTablesFromMarkdown } from './table-render'
import {
  markdownToTelegramHtml,
  splitTelegramMessage,
  TelegramApiError,
  type TelegramBotCommand,
  type TelegramClient,
  type TelegramInlineKeyboardMarkup,
  type TelegramUpdate
} from './telegram-api'
import * as main from './worker'
import { TelegramBridgeController, type BridgeDeps } from './worker'

function makeMockDeps(overrides: Partial<{ telegram: Partial<TelegramClient>; orcaCli: Partial<OrcaCliRunner> }> = {}) {
  const sentMessages: {
    chatId: number | string
    text: string
    replyToMessageId?: number
    parseMode?: string
    replyMarkup?: TelegramInlineKeyboardMarkup
  }[] = []
  const sentPhotos: { chatId: number | string; bytes: number; caption?: string }[] = []
  const sentActions: { chatId: number | string; action: string }[] = []
  const answeredCallbacks: { callbackQueryId: string; text?: string; showAlert?: boolean }[] = []
  const registeredCommands: TelegramBotCommand[][] = []
  const sentToBots: { botName: string; chatId: string; subject: string; body: string }[] = []
  const renamedChats: { sessionId: string; name: string }[] = []
  const triggeredAutomations: string[] = []

  let chats: OrcaChatSummary[] = [
    {
      id: 'home-chat-1',
      title: 'Home',
      lastActivityAt: 1000,
      lastAsked: null,
      lastSaid: null,
      home: true,
      self: true,
      closed: false
    }
  ]

  const sessions = new Map<string, OrcaSessionRead>()
  let readPollCount = 0

  const telegram: TelegramClient = {
    async getMe() {
      return { id: 100000001, is_bot: true, first_name: 'DemoBot', username: 'demo_orca_bot' }
    },
    async setMyCommands(_token, commands) {
      registeredCommands.push(commands)
      return true
    },
    async getUpdates() {
      return []
    },
    async sendMessage(_token, params) {
      sentMessages.push({
        chatId: params.chatId,
        text: params.text,
        replyToMessageId: params.replyToMessageId,
        parseMode: params.parseMode,
        replyMarkup: params.replyMarkup
      })
      return {
        message_id: 900 + sentMessages.length,
        chat: { id: Number(params.chatId), type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: params.text
      }
    },
    async answerCallbackQuery(_token, params) {
      answeredCallbacks.push({
        callbackQueryId: params.callbackQueryId,
        text: params.text,
        showAlert: params.showAlert
      })
      return true
    },
    async sendPhoto(_token, params) {
      sentPhotos.push({
        chatId: params.chatId,
        bytes: params.photo.length,
        caption: params.caption
      })
      return {
        message_id: 950 + sentPhotos.length,
        chat: { id: Number(params.chatId), type: 'private' },
        date: Math.floor(Date.now() / 1000)
      }
    },
    async sendChatAction(_token, params) {
      sentActions.push({ chatId: params.chatId, action: params.action })
      return true
    },
    async getFile(_token, fileId) {
      return {
        file_id: fileId,
        file_unique_id: `u_${fileId}`,
        file_size: 16,
        file_path: fileId.includes('png') ? 'documents/file_1.png' : 'photos/file_0.jpg'
      }
    },
    async downloadFile() {
      return Buffer.from('fake-image-bytes')
    },
    ...overrides.telegram
  }

  const orcaCli: OrcaCliRunner = {
    async listBots() {
      return [
        { id: 'bot-1', name: 'Assistant', specialty: 'Workspace assistant', agent: 'claude' },
        { id: 'bot-2', name: 'Daily standup notes', specialty: 'Standup summary', agent: 'claude' }
      ]
    },
    async listBotChats() {
      return [...chats]
    },
    async readSession(sessionId) {
      readPollCount++
      const s = sessions.get(sessionId)
      if (!s) {
        return { orcaSessionId: sessionId, state: 'done', entries: [] }
      }
      if (s.state === 'working' && readPollCount >= 2) {
        s.state = 'done'
      }
      return { ...s, entries: [...s.entries] }
    },
    async renameChat(sessionId, name) {
      renamedChats.push({ sessionId, name })
      chats = chats.map((c) => (c.id === sessionId ? { ...c, title: name } : c))
    },
    async listAutomations() {
      return [
        {
          id: 'auto-1',
          name: 'Daily backup',
          enabled: true,
          lastRunStatus: 'completed'
        }
      ]
    },
    async runAutomation(id) {
      triggeredAutomations.push(id)
    },
    async sendToBot({ botName, chatId, subject, body }) {
      sentToBots.push({ botName, chatId, subject, body })
      readPollCount = 0
      let targetId = chatId
      if (chatId === 'new') {
        targetId = `tg-chat-${chats.length + 1}`
        chats = [
          {
            id: targetId,
            title: subject,
            lastActivityAt: Date.now(),
            lastAsked: body,
            lastSaid: null,
            home: false,
            self: false,
            closed: false
          },
          ...chats
        ]
      }
      const existing = sessions.get(targetId) ?? {
        orcaSessionId: targetId,
        state: 'done',
        entries: []
      }
      const replyNum = existing.entries.filter((e) => e.role === 'assistant').length + 1
      existing.entries.push({ kind: 'message', role: 'user', text: body })
      existing.entries.push({
        kind: 'message',
        role: 'assistant',
        text: `Reply #${replyNum} from ${botName}`
      })
      existing.state = 'working'
      sessions.set(targetId, existing)
    },
    ...overrides.orcaCli
  }

  return {
    telegram,
    orcaCli,
    sentMessages,
    sentPhotos,
    sentActions,
    answeredCallbacks,
    registeredCommands,
    sentToBots,
    renamedChats,
    triggeredAutomations
  }
}

const CAPABILITIES = ['storage:own', 'secrets:own', 'settings:own', 'notifications:show']

async function mountController(host: MockHost, deps: BridgeDeps) {
  let controller!: TelegramBridgeController
  const worker = await mountWorker(
    {
      default: async (orca: OrcaWorkerApi) => {
        controller = new TelegramBridgeController(orca, deps)
        await controller.init()
      }
    },
    { host }
  )
  return { controller, worker }
}

// A regression that deadlocks fails the test instead of hanging it (the same guard as the activation test).
async function within<T>(promise: Promise<T>, label: string, ms = 2000): Promise<T> {
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(() => timeout.reject(new Error(`Timed out waiting for ${label}`)), ms)
  try {
    return await Promise.race([promise, timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}

// Yields whole event-loop turns (no clock wait) so in-memory host calls settle between checks.
async function until(ready: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (ready()) return
    await nextTurn()
  }
  throw new Error(`Gave up waiting for ${label}`)
}

// Returns each batch once, then long-polls until the poll loop aborts, like Telegram with no new updates.
function scriptedGetUpdates(
  batches: TelegramUpdate[][],
  onPoll?: (token: string, offset: number | undefined) => void
): TelegramClient['getUpdates'] {
  let call = 0
  return async (token, params, options) => {
    onPoll?.(token, params.offset)
    const batch = batches[call++]
    if (batch) return batch
    const aborted = Promise.withResolvers<void>()
    options?.signal?.addEventListener('abort', () => aborted.resolve(), { once: true })
    if (!options?.signal?.aborted) await aborted.promise
    return []
  }
}

function textUpdate(updateId: number, userId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: 100 + updateId,
      from: { id: userId, is_bot: false, first_name: 'User' },
      chat: { id: userId, type: 'private' },
      date: 1000,
      text
    }
  }
}

test('extractTablesFromMarkdown extracts GFM tables outside code fences', () => {
  const md = [
    '说明：',
    '| 名称 | 状态 |',
    '| --- | --- |',
    '| **DemoWorkspace** | 正常 |',
    '',
    '```md',
    '| code | fence |',
    '| --- | --- |',
    '| a | b |',
    '```'
  ].join('\n')
  const { textWithMarkers, tables } = extractTablesFromMarkdown(md, t('en').tableMarker)
  assert.equal(tables.length, 1)
  assert.deepEqual(tables[0].headers, ['名称', '状态'])
  assert.deepEqual(tables[0].rows, [['DemoWorkspace', '正常']])
  assert.match(textWithMarkers, /📊 \*\*Table 1\*\* \(see image below\)/)
  assert.match(textWithMarkers, /\| code \| fence \|/)
})

test('markdownToTelegramHtml formats headings, bold, italic, strike, quote, tasks, code, and tables', () => {
  const html = markdownToTelegramHtml(
    [
      '### 标题 <test>',
      '**粗体** *斜体* ***粗斜体*** ~~删除~~ `C:\\path` [链接](https://example.com/a_b)',
      '> 第一行引用',
      '> 第二行引用',
      '- [x] 已完成',
      '- [] 未完成',
      '---',
      '| 名称 | 状态 |',
      '| --- | --- |',
      '| km | OK |',
      '| 名称 | 类型 | 状态 | 备注 |',
      '| --- | --- | --- | --- |',
      '| DemoWorkspace | 笔记库 | 正常 | 路径 `/workspace/notes` |',
      '```ts',
      'const a = 1 < 2',
      '```'
    ].join('\n')
  )
  assert.match(html, /<b>标题 &lt;test&gt;<\/b>/)
  assert.match(html, /<b>粗体<\/b> <i>斜体<\/i> <b><i>粗斜体<\/i><\/b> <s>删除<\/s>/)
  assert.match(html, /<code>C:\\path<\/code>/)
  assert.match(html, /<a href="https:\/\/example\.com\/a_b">链接<\/a>/)
  assert.match(html, /<blockquote>第一行引用\n第二行引用<\/blockquote>/)
  assert.match(html, /✅ 已完成/)
  assert.match(html, /⬜ 未完成/)
  assert.match(html, /──────────/)
  assert.match(html, /<pre><code>名称\s+│ 状态/)
  assert.match(html, /• <b>DemoWorkspace<\/b>\n  类型: 笔记库 ｜ 状态: 正常 ｜ 备注: 路径 <code>\/workspace\/notes<\/code>/)
  assert.match(html, /<pre><code class="language-ts">const a = 1 &lt; 2<\/code><\/pre>/)
})

test('splitTelegramMessage splits long messages cleanly', () => {
  const longText = Array.from({ length: 120 }, (_, i) => `Line ${i}: ${'x'.repeat(50)}`).join('\n')
  const parts = splitTelegramMessage(longText, 1000)
  assert.ok(parts.length > 1)
  for (const part of parts) {
    assert.ok(part.length <= 1000)
  }
})

test('worker activates cleanly without token and saves config', async () => {
  const host = mockHost({
    capabilities: ['storage:own', 'secrets:own', 'settings:own', 'notifications:show'],
    settings: { enabled: false, defaultBot: '', allowedUserIds: '', proxyUrl: '', replyTimeoutSec: 300 }
  })
  const worker = await mountWorker(main, { host })
  const initial = (await worker.request('bridge.getState')) as { status: string; config: { hasToken: boolean } }
  assert.equal(initial.status, 'needs_token')
  assert.equal(initial.config.hasToken, false)

  const saved = (await worker.request('bridge.saveConfig', {
    botToken: '123456:TEST_TOKEN',
    enabled: false,
    defaultBot: 'Assistant',
    allowedUserIds: '42',
    proxyUrl: '',
    replyTimeoutSec: 120,
    syncOrcaOutbound: true
  })) as { status: string; config: { hasToken: boolean; allowedUserIds: string; syncOrcaOutbound: boolean } }
  assert.equal(saved.status, 'stopped')
  assert.equal(saved.config.hasToken, true)
  assert.equal(saved.config.allowedUserIds, '42')
  assert.equal(saved.config.syncOrcaOutbound, true)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('worker activates and starts polling while Orca bot discovery hangs', async () => {
  const host = mockHost({
    capabilities: ['storage:own', 'secrets:own', 'settings:own', 'notifications:show'],
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: { enabled: true, defaultBot: '', allowedUserIds: '', proxyUrl: '', replyTimeoutSec: 300 }
  })
  const polled = Promise.withResolvers<void>()
  const deps = makeMockDeps({
    telegram: {
      async getUpdates(_token, _params, options) {
        polled.resolve()
        const aborted = Promise.withResolvers<void>()
        options?.signal?.addEventListener('abort', () => aborted.resolve(), { once: true })
        if (!options?.signal?.aborted) await aborted.promise
        return []
      }
    },
    orcaCli: {
      // `orca bot list --json` can hang on some hosts; startup must not wait for it.
      listBots: () => new Promise(() => {})
    }
  })
  // Real timer on purpose: it stands in for the host's ready deadline, so a regression fails instead of hanging.
  const deadline = Promise.withResolvers<string>()
  const timer = setTimeout(() => deadline.resolve('timed out'), 1000)
  const started = mountWorker(
    {
      default: (orca: OrcaWorkerApi) => main.activateWithDeps(orca, deps).then(() => undefined),
      deactivate: main.deactivate
    },
    { host }
  )
  const outcome = await Promise.race([
    Promise.all([started, polled.promise]).then(() => 'polling'),
    deadline.promise
  ])
  clearTimeout(timer)
  assert.equal(outcome, 'polling')
  await (await started).deactivate()
})

test('findUnsyncedTail aligns sliding windows and repeated messages accurately', () => {
  const items1 = extractMessageItems([
    { kind: 'message', role: 'user', text: 'first' },
    { kind: 'message', role: 'assistant', text: 'reply 1' },
    { kind: 'message', role: 'user', text: 'ok' }
  ])
  const tail = computeTailHashes(items1)

  // User sends the exact same text 'ok' again later
  const items2 = extractMessageItems([
    { kind: 'message', role: 'user', text: 'first' },
    { kind: 'message', role: 'assistant', text: 'reply 1' },
    { kind: 'message', role: 'user', text: 'ok' },
    { kind: 'message', role: 'assistant', text: 'reply 2' },
    { kind: 'message', role: 'user', text: 'ok' }
  ])
  const res = findUnsyncedTail(items2, tail)
  assert.equal(res.matched, true)
  assert.deepEqual(res.unsynced, [
    { role: 'assistant', text: 'reply 2' },
    { role: 'user', text: 'ok' }
  ])

  // Sliding window drops earliest item ('first') but still aligns on trailing suffix
  const slid = items2.slice(1)
  const slidRes = findUnsyncedTail(slid, tail)
  assert.equal(slidRes.matched, true)
  assert.deepEqual(slidRes.unsynced, [
    { role: 'assistant', text: 'reply 2' },
    { role: 'user', text: 'ok' }
  ])
})

test('syncOrcaBoundChatsOnce forwards Orca-side user messages and bot replies without duplicating TG turns', async () => {
  const boundChatId = 'orca-bound-1'
  let chatActivityAt = 1000
  const session: OrcaSessionRead = {
    orcaSessionId: boundChatId,
    state: 'done',
    entries: [
      { kind: 'message', role: 'user', text: 'Old history question' },
      { kind: 'message', role: 'assistant', text: 'Old history reply' }
    ]
  }
  const sentMessages: { chatId: number | string; text: string }[] = []

  const host = mockHost({
    capabilities: ['storage:own', 'secrets:own', 'settings:own', 'notifications:show'],
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: {
      enabled: false,
      defaultBot: 'Assistant',
      allowedUserIds: '777888',
      proxyUrl: '',
      replyTimeoutSec: 300,
      syncOrcaOutbound: true
    },
    storage: {
      'tg.bindings': [
        {
          tgChatId: '777888',
          botId: 'bot-1',
          botName: 'Assistant',
          orcaChatId: boundChatId,
          updatedAt: 1000
        }
      ]
    }
  })

  const deps = makeMockDeps({
    telegram: {
      async sendMessage(_token, params) {
        sentMessages.push({ chatId: params.chatId, text: params.text })
        return {
          message_id: 100 + sentMessages.length,
          chat: { id: Number(params.chatId), type: 'private' },
          date: 1000,
          text: params.text
        }
      }
    },
    orcaCli: {
      async listBotChats() {
        return [
          {
            id: boundChatId,
            title: 'Bound Chat',
            lastActivityAt: chatActivityAt,
            lastAsked: null,
            lastSaid: null,
            home: false,
            self: false,
            closed: false
          }
        ]
      },
      async readSession() {
        return { ...session, entries: [...session.entries] }
      }
    }
  })

  let controller!: TelegramBridgeController
  const capturedWorker = await mountWorker(
    {
      default: async (orca: OrcaWorkerApi) => {
        controller = new TelegramBridgeController(orca, {
          telegram: deps.telegram,
          orcaCli: deps.orcaCli,
          pollIntervalMs: 10
        })
        await controller.init()
      }
    },
    { host }
  )

  // 1. First sync pass establishes baseline without dumping old history
  await controller.syncOrcaBoundChatsOnce()
  assert.equal(sentMessages.length, 0)

  // 2. User sends a message directly in Orca UI while bot is still working
  chatActivityAt = 2000
  session.state = 'working'
  session.entries.push({ kind: 'message', role: 'user', text: 'Check today tasks in Orca' })
  session.entries.push({ kind: 'message', role: 'assistant', text: 'Partial draft...' })

  await controller.syncOrcaBoundChatsOnce()
  // User prompt forwards immediately; partial assistant output waits until done
  assert.equal(sentMessages.length, 1)
  assert.match(sentMessages[0].text, /Check today tasks in Orca/)

  // 3. Bot finishes in Orca -> assistant reply forwards to Telegram
  session.state = 'done'
  session.entries.push({ kind: 'message', role: 'assistant', text: 'Final answer.' })

  await controller.syncOrcaBoundChatsOnce()
  assert.equal(sentMessages.length, 2)
  assert.match(sentMessages[1].text, /Partial draft\.\.\./)
  assert.match(sentMessages[1].text, /Final answer\./)

  // 4. Subsequent poll with no new activity sends nothing
  await controller.syncOrcaBoundChatsOnce()
  assert.equal(sentMessages.length, 2)

  // 5. Turning syncOrcaOutbound off stops forwarding new Orca messages
  await controller.saveConfig({
    enabled: false,
    defaultBot: 'Assistant',
    allowedUserIds: '777888',
    proxyUrl: '',
    replyTimeoutSec: 300,
    syncOrcaOutbound: false
  })
  chatActivityAt = 3000
  session.entries.push({ kind: 'message', role: 'user', text: 'Should stay local' })
  session.entries.push({ kind: 'message', role: 'assistant', text: 'Local reply' })
  await controller.syncOrcaBoundChatsOnce()
  assert.equal(sentMessages.length, 2)

  await controller.dispose()
  await capturedWorker.deactivate()
})

test('controller blocks unauthorized users, auto-picks bot, runs slash commands, and bridges multi-turn chat', async () => {
  const host = mockHost({
    capabilities: ['storage:own', 'secrets:own', 'settings:own', 'notifications:show'],
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: { enabled: false, defaultBot: '', allowedUserIds: '', proxyUrl: '', replyTimeoutSec: 300 }
  })

  const deps = makeMockDeps()
  let controller!: TelegramBridgeController
  const capturedWorker = await mountWorker(
    {
      default: async (orca: OrcaWorkerApi) => {
        controller = new TelegramBridgeController(orca, {
          telegram: deps.telegram,
          orcaCli: deps.orcaCli,
          pollIntervalMs: 10
        })
        await controller.init()
      }
    },
    { host }
  )

  // Empty defaultBot auto-selects first available Orca bot
  assert.equal(controller.getState().config.defaultBot, 'Assistant')

  // 1. Unauthorized message is blocked and notifies sender of their numeric ID
  await controller.testConnection()
  assert.equal(deps.registeredCommands.length, 1)
  assert.ok(deps.registeredCommands[0].some((c) => c.command === 'new'))

  await controller.handleIncomingUpdate({
    update_id: 1,
    message: {
      message_id: 10,
      from: { id: 777888, is_bot: false, first_name: 'Demo', username: 'demouser' },
      chat: { id: 777888, type: 'private' },
      date: 1000,
      text: 'hello'
    }
  })
  assert.equal(deps.sentToBots.length, 0)
  assert.equal(controller.getState().lastBlockedUserId, '777888')
  assert.match(deps.sentMessages[0].text, /777888/)

  // 2. Allow the user ID and send a real message -> creates new Orca chat & replies
  await controller.allowUserId('777888')
  await controller.handleIncomingUpdate({
    update_id: 2,
    message: {
      message_id: 11,
      from: { id: 777888, is_bot: false, first_name: 'Demo', username: 'demouser' },
      chat: { id: 777888, type: 'private' },
      date: 1001,
      text: 'Summarize my recent notes'
    }
  })
  assert.equal(deps.sentToBots.length, 1)
  assert.equal(deps.sentToBots[0].chatId, 'new')
  assert.equal(deps.sentMessages[1].text, 'Reply #1 from Assistant')

  // 3. Follow-up message reuses the bound Orca chat ID
  await controller.handleIncomingUpdate({
    update_id: 3,
    message: {
      message_id: 12,
      from: { id: 777888, is_bot: false, first_name: 'Demo', username: 'demouser' },
      chat: { id: 777888, type: 'private' },
      date: 1002,
      text: 'List folders'
    }
  })
  assert.equal(deps.sentToBots.length, 2)
  assert.equal(deps.sentToBots[1].chatId, 'tg-chat-2')
  assert.equal(deps.sentMessages[2].text, 'Reply #2 from Assistant')

  // 4. /use switches bot and resets chat binding while keeping botId
  await controller.handleIncomingUpdate({
    update_id: 4,
    message: {
      message_id: 13,
      from: { id: 777888, is_bot: false, first_name: 'Demo', username: 'demouser' },
      chat: { id: 777888, type: 'private' },
      date: 1003,
      text: '/use Daily standup notes'
    }
  })
  assert.equal(deps.sentToBots.length, 2)
  assert.match(deps.sentMessages[3].text, /Daily standup notes/)
  assert.equal(controller.getState().bindings[0].botId, 'bot-2')
  assert.equal(controller.getState().bindings[0].botName, 'Daily standup notes')
  assert.equal(controller.getState().bindings[0].orcaChatId, null)

  // 5. /new preserves botId while clearing orcaChatId
  await controller.handleIncomingUpdate({
    update_id: 5,
    message: {
      message_id: 14,
      from: { id: 777888, is_bot: false, first_name: 'Demo', username: 'demouser' },
      chat: { id: 777888, type: 'private' },
      date: 1004,
      text: '/new'
    }
  })
  assert.equal(controller.getState().bindings[0].botId, 'bot-2')
  assert.equal(controller.getState().bindings[0].orcaChatId, null)

  assert.deepEqual(capturedWorker.refusals, [])
  await controller.dispose()
  await capturedWorker.deactivate()
})

test('controller downloads Telegram photo and image document and passes local paths to Orca bot', async () => {
  const tempDownloadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-tg-bridge-test-'))
  const downloadedFileIds: string[] = []
  const host = mockHost({
    capabilities: ['storage:own', 'secrets:own', 'settings:own', 'notifications:show'],
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: {
      enabled: false,
      defaultBot: 'Assistant',
      allowedUserIds: '777888',
      proxyUrl: '',
      replyTimeoutSec: 300,
      syncOrcaOutbound: false
    }
  })

  const deps = makeMockDeps({
    telegram: {
      async getFile(_token, fileId) {
        downloadedFileIds.push(fileId)
        return {
          file_id: fileId,
          file_unique_id: `u_${fileId}`,
          file_path: fileId === 'doc-png-1' ? 'documents/screenshot.png' : 'photos/photo_lg.jpg'
        }
      },
      async downloadFile(_token, filePath) {
        return Buffer.from(`bytes-for-${filePath}`)
      }
    }
  })

  let controller!: TelegramBridgeController
  const capturedWorker = await mountWorker(
    {
      default: async (orca: OrcaWorkerApi) => {
        controller = new TelegramBridgeController(orca, {
          telegram: deps.telegram,
          orcaCli: deps.orcaCli,
          downloadDir: tempDownloadDir,
          pollIntervalMs: 10
        })
        await controller.init()
      }
    },
    { host }
  )

  try {
    // 1. Compressed photo without caption picks largest resolution
    await controller.handleIncomingUpdate({
      update_id: 10,
      message: {
        message_id: 21,
        from: { id: 777888, is_bot: false, first_name: 'Demo', username: 'demouser' },
        chat: { id: 777888, type: 'private' },
        date: 2000,
        photo: [
          { file_id: 'photo-sm', file_unique_id: 'sm', width: 90, height: 90, file_size: 1200 },
          { file_id: 'photo-lg', file_unique_id: 'lg', width: 1280, height: 720, file_size: 48000 }
        ]
      }
    })

    assert.deepEqual(downloadedFileIds, ['photo-lg'])
    assert.equal(deps.sentToBots.length, 1)
    assert.match(deps.sentToBots[0].subject, /\[Image\]/)
    assert.match(deps.sentToBots[0].body, /Attached Telegram image\(s\) saved locally/)
    assert.match(deps.sentToBots[0].body, /\.jpg/)
    assert.equal(deps.sentMessages[0].text, 'Reply #1 from Assistant')

    // 2. Uncompressed image document with caption preserves .png and caption
    await controller.handleIncomingUpdate({
      update_id: 11,
      message: {
        message_id: 22,
        from: { id: 777888, is_bot: false, first_name: 'Demo', username: 'demouser' },
        chat: { id: 777888, type: 'private' },
        date: 2001,
        caption: 'Describe this screenshot',
        document: {
          file_id: 'doc-png-1',
          file_unique_id: 'doc1',
          file_name: '../../evil.png',
          mime_type: 'image/png',
          file_size: 2048
        }
      }
    })

    assert.deepEqual(downloadedFileIds, ['photo-lg', 'doc-png-1'])
    assert.equal(deps.sentToBots.length, 2)
    assert.match(deps.sentToBots[1].body, /\.png/)
    assert.match(deps.sentToBots[1].body, /Describe this screenshot/)
    assert.ok(!deps.sentToBots[1].body.includes('evil.png'))

    const savedFiles = await fs.readdir(tempDownloadDir)
    assert.equal(savedFiles.length, 2)
    assert.deepEqual(capturedWorker.refusals, [])
  } finally {
    await controller.dispose()
    await capturedWorker.deactivate()
    await fs.rm(tempDownloadDir, { recursive: true, force: true })
  }
})

test('controller supports interactive inline buttons, /sync, /home, /rename, and /automations + /run', async () => {
  const host = mockHost({
    capabilities: ['storage:own', 'secrets:own', 'settings:own', 'notifications:show'],
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: {
      enabled: false,
      defaultBot: 'Assistant',
      allowedUserIds: '777888',
      proxyUrl: '',
      replyTimeoutSec: 300,
      syncOrcaOutbound: false
    }
  })

  const deps = makeMockDeps()
  let controller!: TelegramBridgeController
  const capturedWorker = await mountWorker(
    {
      default: async (orca: OrcaWorkerApi) => {
        controller = new TelegramBridgeController(orca, {
          telegram: deps.telegram,
          orcaCli: deps.orcaCli,
          pollIntervalMs: 10
        })
        await controller.init()
      }
    },
    { host }
  )

  // 1. /bots returns inline keyboard buttons and callback switches bot
  await controller.handleIncomingUpdate({
    update_id: 20,
    message: {
      message_id: 30,
      from: { id: 777888, is_bot: false, first_name: 'Demo', username: 'demouser' },
      chat: { id: 777888, type: 'private' },
      date: 2000,
      text: '/bots'
    }
  })
  assert.ok(deps.sentMessages[0].replyMarkup?.inline_keyboard.length)
  assert.equal(deps.sentMessages[0].replyMarkup?.inline_keyboard[0][1].callback_data, 'u:bot-2')

  // Unauthorized callback is rejected
  await controller.handleIncomingUpdate({
    update_id: 21,
    callback_query: {
      id: 'cb-unauth',
      from: { id: 999999, is_bot: false, first_name: 'Stranger' },
      message: {
        message_id: 901,
        chat: { id: 999999, type: 'private' },
        date: 2001
      },
      data: 'u:bot-2'
    }
  })
  assert.equal(deps.answeredCallbacks[0].showAlert, true)
  assert.equal(controller.getState().bindings[0].botName, 'Assistant')

  // Authorized callback switches bot
  await controller.handleIncomingUpdate({
    update_id: 22,
    callback_query: {
      id: 'cb-auth',
      from: { id: 777888, is_bot: false, first_name: 'Demo' },
      message: {
        message_id: 901,
        chat: { id: 777888, type: 'private' },
        date: 2002
      },
      data: 'u:bot-2'
    }
  })
  assert.equal(controller.getState().bindings[0].botName, 'Daily standup notes')
  assert.equal(controller.getState().bindings[0].botId, 'bot-2')

  // 2. /home binds to Home Chat and /rename renames it
  await controller.handleIncomingUpdate({
    update_id: 23,
    message: {
      message_id: 31,
      from: { id: 777888, is_bot: false, first_name: 'Demo' },
      chat: { id: 777888, type: 'private' },
      date: 2003,
      text: '/home'
    }
  })
  assert.equal(controller.getState().bindings[0].orcaChatId, 'home-chat-1')

  await controller.handleIncomingUpdate({
    update_id: 24,
    message: {
      message_id: 32,
      from: { id: 777888, is_bot: false, first_name: 'Demo' },
      chat: { id: 777888, type: 'private' },
      date: 2004,
      text: '/rename Work Sync'
    }
  })
  assert.deepEqual(deps.renamedChats, [{ sessionId: 'home-chat-1', name: 'Work Sync' }])
  assert.equal(controller.getState().bindings[0].title, 'Work Sync')

  // 3. /sync toggles syncOrcaOutbound via text and inline callback
  await controller.handleIncomingUpdate({
    update_id: 25,
    message: {
      message_id: 33,
      from: { id: 777888, is_bot: false, first_name: 'Demo' },
      chat: { id: 777888, type: 'private' },
      date: 2005,
      text: '/sync on'
    }
  })
  assert.equal(controller.getState().config.syncOrcaOutbound, true)

  await controller.handleIncomingUpdate({
    update_id: 26,
    callback_query: {
      id: 'cb-sync-off',
      from: { id: 777888, is_bot: false, first_name: 'Demo' },
      message: {
        message_id: 904,
        chat: { id: 777888, type: 'private' },
        date: 2006
      },
      data: 's:off'
    }
  })
  assert.equal(controller.getState().config.syncOrcaOutbound, false)

  // 4. /automations lists tasks with run buttons, and /run + button trigger them
  await controller.handleIncomingUpdate({
    update_id: 27,
    message: {
      message_id: 34,
      from: { id: 777888, is_bot: false, first_name: 'Demo' },
      chat: { id: 777888, type: 'private' },
      date: 2007,
      text: '/automations'
    }
  })
  const autoMsg = deps.sentMessages[deps.sentMessages.length - 1]
  assert.match(autoMsg.text, /Daily backup/)
  assert.equal(autoMsg.replyMarkup?.inline_keyboard[0][0].callback_data, 'r:auto-1')

  await controller.handleIncomingUpdate({
    update_id: 28,
    callback_query: {
      id: 'cb-run',
      from: { id: 777888, is_bot: false, first_name: 'Demo' },
      message: {
        message_id: 906,
        chat: { id: 777888, type: 'private' },
        date: 2008
      },
      data: 'r:auto-1'
    }
  })
  await controller.handleIncomingUpdate({
    update_id: 29,
    message: {
      message_id: 35,
      from: { id: 777888, is_bot: false, first_name: 'Demo' },
      chat: { id: 777888, type: 'private' },
      date: 2009,
      text: '/run auto-1'
    }
  })
  assert.deepEqual(deps.triggeredAutomations, ['auto-1', 'auto-1'])

  assert.deepEqual(capturedWorker.refusals, [])
  await controller.dispose()
  await capturedWorker.deactivate()
})

test('a slow bot reply in one Telegram chat does not hold up another chat', async () => {
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: { enabled: true, defaultBot: 'Assistant', allowedUserIds: '111, 222', proxyUrl: '', replyTimeoutSec: 300 }
  })
  const deps = makeMockDeps({
    telegram: {
      getUpdates: scriptedGetUpdates([[textUpdate(1, 111, 'slow question'), textUpdate(2, 222, 'quick question')]])
    }
  })
  const releaseA = Promise.withResolvers<void>()
  const replyA = Promise.withResolvers<void>()
  const replyB = Promise.withResolvers<void>()
  const baseSendToBot = deps.orcaCli.sendToBot
  deps.orcaCli.sendToBot = async (params) => {
    if (params.body.includes('chat 111')) await releaseA.promise
    return baseSendToBot(params)
  }
  const baseSendMessage = deps.telegram.sendMessage
  deps.telegram.sendMessage = async (token, params, options) => {
    const sent = await baseSendMessage(token, params, options)
    if (String(params.chatId) === '111') replyA.resolve()
    if (String(params.chatId) === '222') replyB.resolve()
    return sent
  }

  const { controller, worker } = await mountController(host, {
    telegram: deps.telegram,
    orcaCli: deps.orcaCli,
    pollIntervalMs: 1,
    retryBackoffMs: 1
  })
  try {
    await within(replyB.promise, 'chat 222 reply while chat 111 is still waiting')
    assert.ok(!deps.sentMessages.some((m) => String(m.chatId) === '111'))

    releaseA.resolve()
    await within(replyA.promise, 'chat 111 reply after its bot finishes')
    assert.equal(deps.sentMessages.find((m) => String(m.chatId) === '111')?.text, 'Reply #1 from Assistant')
    assert.equal(deps.sentMessages.find((m) => String(m.chatId) === '222')?.text, 'Reply #1 from Assistant')
  } finally {
    releaseA.resolve()
    await controller.dispose()
    await worker.deactivate()
  }
})

test('pausing after Telegram rejects the token (401) does not hang while outbound sync is on', async () => {
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '123456:BAD_TOKEN' },
    settings: {
      enabled: true,
      defaultBot: 'Assistant',
      allowedUserIds: '777888',
      proxyUrl: '',
      replyTimeoutSec: 300,
      syncOrcaOutbound: true
    }
  })
  const deps = makeMockDeps({
    telegram: {
      async getMe() {
        throw new TelegramApiError('Unauthorized', 401)
      }
    }
  })
  const { controller, worker } = await mountController(host, {
    telegram: deps.telegram,
    orcaCli: deps.orcaCli,
    outboundPollIntervalMs: 1,
    retryBackoffMs: 1
  })
  try {
    // The poll loop must have ended on its own before the pause, or stopPolling would abort it itself.
    await until(() => !controller.getState().polling, 'poll loop to exit after 401')
    assert.equal(controller.getState().status, 'error')

    const paused = await within(controller.togglePolling(), 'togglePolling after a 401')
    assert.equal(paused.status, 'stopped')
    assert.equal(paused.config.enabled, false)
  } finally {
    await within(controller.dispose(), 'dispose after a 401')
    await worker.deactivate()
  }
})

test('status turns connected without waiting out a full long poll', async () => {
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: { enabled: true, defaultBot: 'Assistant', allowedUserIds: '777888', proxyUrl: '', replyTimeoutSec: 300 }
  })
  const deps = makeMockDeps({
    telegram: {
      // Like Telegram with no new updates: a long poll holds until the loop aborts, a short poll answers.
      async getUpdates(_token, params, options) {
        if ((params.timeoutSec ?? 0) > 0) {
          const aborted = Promise.withResolvers<void>()
          options?.signal?.addEventListener('abort', () => aborted.resolve(), { once: true })
          if (!options?.signal?.aborted) await aborted.promise
        }
        return []
      }
    }
  })
  const { controller, worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli })
  try {
    await until(() => controller.getState().status === 'connected', 'status connected after the first poll')
  } finally {
    await within(controller.dispose(), 'dispose')
    await worker.deactivate()
  }
})

test('switching to a new bot token polls the new bot from offset 0 and reads its own @username', async () => {
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '111:OLD_BOT' },
    settings: { enabled: true, defaultBot: 'Assistant', allowedUserIds: '777888', proxyUrl: '', replyTimeoutSec: 300 },
    storage: { 'tg.updateOffset': 50 }
  })
  const polls: { token: string; offset: number | undefined }[] = []
  const polledOld = Promise.withResolvers<void>()
  const polledNew = Promise.withResolvers<void>()
  const deps = makeMockDeps({
    telegram: {
      async getMe(token) {
        const isNew = token.startsWith('222:')
        return { id: isNew ? 222 : 111, is_bot: true, first_name: 'Bot', username: isNew ? 'new_bot' : 'old_bot' }
      },
      getUpdates: scriptedGetUpdates([], (token, offset) => {
        polls.push({ token, offset })
        if (token === '111:OLD_BOT') polledOld.resolve()
        if (token === '222:NEW_BOT') polledNew.resolve()
      })
    }
  })
  const { controller, worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli })
  try {
    await within(polledOld.promise, 'first poll with the old token')
    assert.equal(polls[0].offset, 50)

    await within(
      controller.saveConfig({
        botToken: '222:NEW_BOT',
        enabled: true,
        defaultBot: 'Assistant',
        allowedUserIds: '777888',
        proxyUrl: '',
        replyTimeoutSec: 300,
        syncOrcaOutbound: false
      }),
      'saveConfig with a new token'
    )
    await within(polledNew.promise, 'first poll with the new token')

    // The old bot's offset would make Telegram confirm, and so drop, the new bot's pending updates.
    const newPolls = polls.filter((p) => p.token === '222:NEW_BOT')
    assert.ok(newPolls.every((p) => p.offset === undefined))
    assert.equal(controller.getState().botUsername, 'new_bot')
    assert.equal(deps.registeredCommands.length, 2)
  } finally {
    await controller.dispose()
    await worker.deactivate()
  }
})

test('saving settings that do not touch the connection keeps an in-flight reply running', async () => {
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: { enabled: true, defaultBot: 'Assistant', allowedUserIds: '777888', proxyUrl: '', replyTimeoutSec: 300 }
  })
  const deps = makeMockDeps({
    telegram: { getUpdates: scriptedGetUpdates([[textUpdate(1, 777888, 'long task')]]) }
  })
  const entered = Promise.withResolvers<AbortSignal | undefined>()
  const release = Promise.withResolvers<void>()
  const replied = Promise.withResolvers<void>()
  const baseSendToBot = deps.orcaCli.sendToBot
  deps.orcaCli.sendToBot = async (params) => {
    entered.resolve(params.signal)
    await release.promise
    return baseSendToBot(params)
  }
  const baseSendMessage = deps.telegram.sendMessage
  deps.telegram.sendMessage = async (token, params, options) => {
    const sent = await baseSendMessage(token, params, options)
    if (String(params.chatId) === '777888') replied.resolve()
    return sent
  }

  const { controller, worker } = await mountController(host, {
    telegram: deps.telegram,
    orcaCli: deps.orcaCli,
    pollIntervalMs: 1
  })
  try {
    const signal = await within(entered.promise, 'the reply to reach the Orca bot')
    const saved = await within(
      controller.saveConfig({
        enabled: true,
        defaultBot: 'Assistant',
        allowedUserIds: '777888, 42',
        proxyUrl: '',
        replyTimeoutSec: 600,
        syncOrcaOutbound: true
      }),
      'saveConfig while a reply is running'
    )
    assert.equal(saved.config.replyTimeoutSec, 600)
    assert.equal(signal?.aborted, false)

    release.resolve()
    await within(replied.promise, 'the reply to reach Telegram')
    assert.equal(deps.sentMessages[0].text, 'Reply #1 from Assistant')
    assert.ok(!deps.sentMessages.some((m) => m.text.startsWith('Processing failed')))
  } finally {
    release.resolve()
    await controller.dispose()
    await worker.deactivate()
  }
})

test('an Orca CLI failure in /home or a Home button answers the user and keeps polling healthy', async () => {
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: { enabled: true, defaultBot: 'Assistant', allowedUserIds: '777888', proxyUrl: '', replyTimeoutSec: 300 }
  })
  const deps = makeMockDeps({
    telegram: { getUpdates: scriptedGetUpdates([[textUpdate(1, 777888, '/home')]]) },
    orcaCli: {
      async listBotChats() {
        throw new Error('orca bot chats failed: exit 1')
      }
    }
  })
  const replied = Promise.withResolvers<void>()
  const baseSendMessage = deps.telegram.sendMessage
  deps.telegram.sendMessage = async (token, params, options) => {
    const sent = await baseSendMessage(token, params, options)
    replied.resolve()
    return sent
  }

  const { controller, worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli })
  try {
    await within(replied.promise, 'an error reply to /home')
    assert.match(deps.sentMessages[0].text, /Processing failed: orca bot chats failed/)
    assert.equal(controller.getState().status, 'connected')
    assert.equal(controller.getState().lastError, null)

    await controller.handleIncomingUpdate({
      update_id: 2,
      callback_query: {
        id: 'cb-home',
        from: { id: 777888, is_bot: false, first_name: 'Demo' },
        message: { message_id: 900, chat: { id: 777888, type: 'private' }, date: 1001 },
        data: 'c:home'
      }
    })
    const answer = deps.answeredCallbacks[deps.answeredCallbacks.length - 1]
    assert.equal(answer?.callbackQueryId, 'cb-home')
    assert.equal(answer?.showAlert, true)
    assert.equal(controller.getState().status, 'connected')
  } finally {
    await controller.dispose()
    await worker.deactivate()
  }
})

test('outbound sync stops for a chat whose Telegram user was removed from the allowlist', async () => {
  const activity: Record<string, number> = { 'orca-group': 1000, 'orca-private': 1000 }
  const sessions: Record<string, OrcaSessionRead> = {
    // Sync needs earlier history to anchor on; an empty baseline only re-baselines.
    'orca-group': {
      orcaSessionId: 'orca-group',
      state: 'done',
      entries: [{ kind: 'message', role: 'assistant', text: 'Group history' }]
    },
    'orca-private': {
      orcaSessionId: 'orca-private',
      state: 'done',
      entries: [{ kind: 'message', role: 'assistant', text: 'Private history' }]
    }
  }
  const addTurn = (orcaChatId: string, text: string) => {
    activity[orcaChatId] += 1000
    sessions[orcaChatId].entries.push({ kind: 'message', role: 'user', text })
    sessions[orcaChatId].entries.push({ kind: 'message', role: 'assistant', text: `Answer to ${text}` })
  }
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: {
      enabled: false,
      defaultBot: 'Assistant',
      allowedUserIds: '555, 777888',
      proxyUrl: '',
      replyTimeoutSec: 300,
      syncOrcaOutbound: true
    },
    storage: {
      'tg.bindings': [
        // A group chat id is never on the allowlist; the user who used it last is.
        { tgChatId: '-100500', ownerUserId: '555', botId: 'bot-1', botName: 'Assistant', orcaChatId: 'orca-group', updatedAt: 1000 },
        { tgChatId: '777888', botId: 'bot-1', botName: 'Assistant', orcaChatId: 'orca-private', updatedAt: 1000 }
      ]
    }
  })
  const deps = makeMockDeps({
    orcaCli: {
      async listBotChats() {
        return Object.keys(sessions).map((id) => ({
          id,
          title: id,
          lastActivityAt: activity[id],
          lastAsked: null,
          lastSaid: null,
          home: false,
          self: false,
          closed: false
        }))
      },
      async readSession(sessionId) {
        const s = sessions[sessionId]
        return { ...s, entries: [...s.entries] }
      }
    }
  })
  const { controller, worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli })
  try {
    await controller.syncOrcaBoundChatsOnce()
    assert.equal(deps.sentMessages.length, 0)

    addTurn('orca-group', 'group turn 1')
    addTurn('orca-private', 'private turn 1')
    await controller.syncOrcaBoundChatsOnce()
    assert.ok(deps.sentMessages.some((m) => String(m.chatId) === '-100500'))
    assert.ok(deps.sentMessages.some((m) => String(m.chatId) === '777888'))

    await controller.saveConfig({
      enabled: false,
      defaultBot: 'Assistant',
      allowedUserIds: '777888',
      proxyUrl: '',
      replyTimeoutSec: 300,
      syncOrcaOutbound: true
    })
    deps.sentMessages.length = 0
    addTurn('orca-group', 'group turn 2')
    addTurn('orca-private', 'private turn 2')
    await controller.syncOrcaBoundChatsOnce()
    assert.ok(!deps.sentMessages.some((m) => String(m.chatId) === '-100500'))
    assert.ok(deps.sentMessages.some((m) => /private turn 2/.test(m.text)))
  } finally {
    await controller.dispose()
    await worker.deactivate()
  }
})

test('an SVG image document is refused instead of being handed to the bot as .jpg', async () => {
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: { enabled: false, defaultBot: 'Assistant', allowedUserIds: '777888', proxyUrl: '', replyTimeoutSec: 300 }
  })
  const deps = makeMockDeps({
    telegram: {
      async getFile() {
        throw new Error('getFile must not be called for an unsupported image')
      }
    }
  })
  const { controller, worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli })
  try {
    await controller.handleIncomingUpdate({
      update_id: 1,
      message: {
        message_id: 40,
        from: { id: 777888, is_bot: false, first_name: 'Demo' },
        chat: { id: 777888, type: 'private' },
        date: 1000,
        caption: 'What is in this diagram?',
        document: {
          file_id: 'doc-svg',
          file_unique_id: 'svg1',
          file_name: 'diagram.svg',
          mime_type: 'image/svg+xml',
          file_size: 512
        }
      }
    })
    assert.equal(deps.sentToBots.length, 0)
    assert.match(deps.sentMessages[0].text, /This image format is not supported/)
  } finally {
    await controller.dispose()
    await worker.deactivate()
  }
})

test('settings reloads fired by saveConfig own writes do not roll the saved config back', async () => {
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: { enabled: true, defaultBot: 'Assistant', allowedUserIds: '777888', proxyUrl: '', replyTimeoutSec: 300 }
  })
  const deps = makeMockDeps({ telegram: { getUpdates: scriptedGetUpdates([]) } })
  const worker = await mountWorker(
    {
      default: (orca: OrcaWorkerApi) => main.activateWithDeps(orca, deps).then(() => undefined),
      deactivate: main.deactivate
    },
    { host }
  )
  try {
    await worker.request('bridge.saveConfig', {
      enabled: false,
      defaultBot: 'Assistant',
      allowedUserIds: '777888',
      proxyUrl: 'http://127.0.0.1:8080',
      replyTimeoutSec: 120,
      syncOrcaOutbound: true
    })
    // Let the onDidChange reloads from the six settings writes run, then read through the panel path.
    for (let i = 0; i < 20; i++) await nextTurn()
    const state = (await worker.request('bridge.getState')) as {
      status: string
      polling: boolean
      config: { enabled: boolean; proxyUrl: string; replyTimeoutSec: number; syncOrcaOutbound: boolean }
    }
    assert.equal(state.config.enabled, false)
    assert.equal(state.config.proxyUrl, 'http://127.0.0.1:8080')
    assert.equal(state.config.replyTimeoutSec, 120)
    assert.equal(state.config.syncOrcaOutbound, true)
    assert.equal(state.status, 'stopped')
    assert.equal(state.polling, false)
  } finally {
    await worker.deactivate()
  }
})

// A real-looking token: the redaction tests must not pass just because a fake token looks unusual.
const REAL_TOKEN = '7251846039:AAH3kVx9QzLm2pR8sT4uW6yZ0bC1dE5fG7h'

function loggingHost(
  options: {
    debugLogging?: boolean
    storedLogs?: { id: string; at: number; level: string; message: string }[]
  } = {}
) {
  return mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: REAL_TOKEN },
    settings: {
      enabled: false,
      defaultBot: 'Assistant',
      allowedUserIds: '777888',
      proxyUrl: '',
      replyTimeoutSec: 300,
      syncOrcaOutbound: false,
      debugLogging: options.debugLogging ?? false
    },
    ...(options.storedLogs ? { storage: { 'tg.logs': options.storedLogs } } : {})
  })
}

// Activates through the real entry point so the panel handlers are wired; logs are written at once.
async function mountBridge(host: MockHost, deps: ReturnType<typeof makeMockDeps>, extra: Partial<BridgeDeps> = {}) {
  let controller!: TelegramBridgeController
  const worker = await mountWorker(
    {
      default: async (orca: OrcaWorkerApi) => {
        controller = await main.activateWithDeps(orca, {
          telegram: deps.telegram,
          orcaCli: deps.orcaCli,
          pollIntervalMs: 0,
          logFlushMs: 0,
          ...extra
        })
      },
      deactivate: main.deactivate
    },
    { host }
  )
  return { controller, worker }
}

function storedLogs(host: MockHost): BridgeLogEntry[] {
  return host.data().storage['tg.logs'] as BridgeLogEntry[]
}

function failingSendCli() {
  return makeMockDeps({
    orcaCli: {
      async sendToBot() {
        throw new OrcaCliError('orchestration send failed', {
          kind: 'exit',
          args: ['orchestration', 'send', '--to', 'bot:Assistant', '--chat', 'new', '--body-file', '-', '--json'],
          exitCode: 2,
          stderr: 'Error: bot "Assistant" is not running',
          durationMs: 41
        })
      }
    }
  })
}

test('a failing orca CLI call shows its args, exit code and stderr in the panel log', async () => {
  const host = loggingHost()
  const deps = failingSendCli()
  const { controller, worker } = await mountBridge(host, deps)
  try {
    await controller.handleIncomingUpdate(textUpdate(1, 777888, 'Summarize my notes'))
    const entry = controller.getState().logs.find((e) => e.level === 'error')
    assert.ok(entry, 'an error entry is logged')
    assert.equal(entry.scope, 'dispatch')
    assert.match(entry.message, /Failed handling message for Assistant: orchestration send failed/)
    assert.match(entry.details ?? '', /command: orca orchestration send --to bot:Assistant --chat new/)
    assert.match(entry.details ?? '', /exit code: 2/)
    assert.match(entry.details ?? '', /bot "Assistant" is not running/)
    assert.match(entry.details ?? '', /tgChatId=777888/)
    assert.match(entry.details ?? '', /bot=Assistant/)
    assert.match(entry.details ?? '', /elapsedMs=\d+/)
    // The user is still told it failed.
    assert.match(deps.sentMessages.at(-1)?.text ?? '', /Processing failed/)
  } finally {
    await worker.deactivate()
  }
})

test('the bot token never reaches log messages, details, storage, orca.log or the export', async () => {
  const host = loggingHost({ debugLogging: true })
  const deps = makeMockDeps({
    orcaCli: {
      async sendToBot() {
        throw new Error(
          `request https://api.telegram.org/bot123:ABC-def_9/getMe failed; token=${REAL_TOKEN}; url=https://api.telegram.org/bot${REAL_TOKEN}/sendMessage`
        )
      }
    }
  })
  const { controller, worker } = await mountBridge(host, deps)
  try {
    await controller.handleIncomingUpdate(textUpdate(1, 777888, 'hello'))
    const exported = await controller.exportLogs()
    const surfaces = {
      state: JSON.stringify(controller.getState().logs),
      storage: JSON.stringify(storedLogs(host)),
      orcaLog: worker.logs.join('\n'),
      export: exported.text
    }
    for (const [name, text] of Object.entries(surfaces)) {
      assert.ok(!text.includes(REAL_TOKEN), `${name} holds the token`)
      assert.ok(!text.includes(REAL_TOKEN.split(':')[1]), `${name} holds the token secret`)
      assert.ok(!text.includes('bot123:ABC'), `${name} holds a bot<id>:<secret> URL`)
    }
    assert.match(surfaces.state, /bot<redacted>/)
    assert.match(surfaces.export, /bot<redacted>/)
    const reply = deps.sentMessages.at(-1)?.text ?? ''
    assert.match(reply, /^Processing failed: /)
    assert.ok(!reply.includes(REAL_TOKEN) && !reply.includes('bot123:ABC'), 'the Telegram reply holds the token')
  } finally {
    await worker.deactivate()
  }
})

test('debug entries are stored only while debug logging is on, and a dispatch then logs its timings', async () => {
  const host = loggingHost()
  const deps = makeMockDeps()
  const { controller, worker } = await mountBridge(host, deps)
  try {
    await controller.handleIncomingUpdate(textUpdate(1, 777888, 'first'))
    assert.equal(deps.sentMessages.at(-1)?.text, 'Reply #1 from Assistant')
    assert.ok(controller.getState().logs.every((e) => e.level !== 'debug'))
    assert.ok(storedLogs(host).every((e) => e.level !== 'debug'))

    const state = (await worker.request('bridge.setDebugLogging', { enabled: true })) as BridgeState
    assert.equal(state.config.debugLogging, true)
    assert.equal(host.data().settings.debugLogging, true)
    assert.equal(state.logs[0].message, 'Debug logging enabled')

    await controller.handleIncomingUpdate(textUpdate(2, 777888, 'second'))
    assert.equal(deps.sentMessages.at(-1)?.text, 'Reply #2 from Assistant')
    const debug = controller.getState().logs.filter((e) => e.level === 'debug').map((e) => e.message)
    assert.ok(
      debug.some((m) => /^Dispatch start: bot Assistant, tg chat 777888, bound Orca chat tg-chat-2, body 6 chars/.test(m)),
      `no dispatch start entry in ${JSON.stringify(debug)}`
    )
    assert.ok(
      debug.some((m) => /^Dispatch finished in \d+ ms: Orca chat tg-chat-2, [1-9]\d* poll\(s\), state done/.test(m)),
      `no dispatch finish entry in ${JSON.stringify(debug)}`
    )
    // The user's text itself is never logged, only its length.
    assert.ok(!JSON.stringify(controller.getState().logs).includes('second'))
  } finally {
    await worker.deactivate()
  }
})

test('a failing typing indicator on an image message is logged as debug and the reply still goes out', async () => {
  const downloadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-tg-bridge-test-'))
  const host = loggingHost({ debugLogging: true })
  const deps = makeMockDeps({
    telegram: {
      async sendChatAction() {
        throw new TelegramApiError('Bad Request: chat not found', 400, false, undefined, 'sendChatAction')
      }
    }
  })
  const { controller, worker } = await mountBridge(host, deps, { downloadDir })
  try {
    await controller.handleIncomingUpdate({
      update_id: 1,
      message: {
        message_id: 21,
        from: { id: 777888, is_bot: false, first_name: 'Demo' },
        chat: { id: 777888, type: 'private' },
        date: 2000,
        photo: [{ file_id: 'photo-lg', file_unique_id: 'lg', width: 1280, height: 720, file_size: 48000 }]
      }
    })
    assert.equal(deps.sentToBots.length, 1)
    assert.equal(deps.sentMessages.at(-1)?.text, 'Reply #1 from Assistant')
    const entry = controller.getState().logs.find((e) => e.message === 'Typing indicator failed for chat 777888')
    assert.ok(entry, 'the swallowed typing failure is recorded')
    assert.equal(entry.level, 'debug')
    assert.match(entry.details ?? '', /TelegramApiError: Bad Request: chat not found/)
    assert.match(entry.details ?? '', /method: sendChatAction/)
    assert.match(entry.details ?? '', /HTTP status: 400/)
  } finally {
    await worker.deactivate()
    await fs.rm(downloadDir, { recursive: true, force: true })
  }
})

test('exported logs carry the diagnostics header and every entry with its details', async () => {
  const host = loggingHost()
  const deps = failingSendCli()
  const { controller, worker } = await mountBridge(host, deps)
  try {
    await controller.handleIncomingUpdate(textUpdate(1, 777888, 'Summarize my notes'))
    const exported = (await worker.request('bridge.exportLogs')) as ExportLogsResult
    assert.match(exported.fileName, /^telegram-bridge-logs-\d{8}-\d{6}\.txt$/)
    const text = exported.text
    assert.match(text, /^Telegram Bridge diagnostics$/m)
    assert.match(text, /^Plugin: .+ (?:\d+\.\d+\.\d+|unknown)$/m)
    assert.match(text, /^Platform: \S+ \S+$/m)
    assert.match(text, /^Node: v\d+/m)
    assert.match(text, /^Orca CLI: \S+/m)
    assert.match(text, /^Status: stopped$/m)
    assert.match(text, /^Config: .*"hasToken":true/m)
    assert.match(text, /^Bindings: 1$/m)
    assert.match(text, /^Log entries: \d+$/m)
    assert.match(text, /Z ERROR \[dispatch\] Failed handling message for Assistant: orchestration send failed\n/)
    assert.match(text, /\n {2}command: orca orchestration send --to bot:Assistant/)
    assert.match(text, /\n {2}exit code: 2\n/)
    assert.ok(!text.includes(REAL_TOKEN))
    // Oldest first: the error comes after the earlier info entry about the incoming message.
    assert.ok(text.indexOf('[TG ') < text.indexOf('ERROR [dispatch]'))
  } finally {
    await worker.deactivate()
  }
})

test('the panel state carries the newest 40 entries while storage keeps at most 200', async () => {
  const old = Array.from({ length: 250 }, (_, i) => ({
    id: `old-${i}`,
    at: 1_000_000 - i,
    level: 'info',
    message: `old entry ${i}`
  }))
  const host = loggingHost({ storedLogs: old })
  const { controller, worker } = await mountBridge(host, makeMockDeps())
  try {
    const state = await controller.allowUserId('5')
    assert.equal(state.logs.length, 40)
    assert.equal(state.logTotal, 200)
    assert.equal(state.logs[0].message, 'Added Telegram user 5 to allowlist.')
    assert.equal(storedLogs(host).length, 200)
    const lastPost = worker.posts.filter((p) => p.event === 'bridge.stateChanged').at(-1)?.payload as BridgeState
    assert.ok(lastPost.logs.length <= 40)
    assert.equal((await controller.exportLogs()).text.match(/ \[(?:-|config)\] /g)?.length, 200)
  } finally {
    await worker.deactivate()
  }
})

test('entries stored by 0.2.0 without a scope load into state and export', async () => {
  const old = [
    { id: 'b', at: Date.UTC(2026, 0, 2), level: 'error', message: 'old failure' },
    { id: 'a', at: Date.UTC(2026, 0, 1), level: 'info', message: 'old entry one' }
  ]
  const host = loggingHost({ storedLogs: old })
  const { controller, worker } = await mountBridge(host, makeMockDeps())
  try {
    const state = controller.getState()
    assert.deepEqual(
      state.logs.map((e) => [e.id, e.level, e.scope, e.message]),
      [
        ['b', 'error', undefined, 'old failure'],
        ['a', 'info', undefined, 'old entry one']
      ]
    )
    assert.equal(state.logTotal, 2)
    const text = (await controller.exportLogs()).text
    assert.match(text, /2026-01-01T00:00:00\.000Z INFO \[-\] old entry one\n2026-01-02T00:00:00\.000Z ERROR \[-\] old failure\n/)
  } finally {
    await worker.deactivate()
  }
})

const CJK = /[\u4e00-\u9fff]/

// What a stranger reads after messaging the bot while the allowlist is empty.
async function unauthorizedReply(
  replyLanguage?: string
): Promise<{ reply: string; language: string }> {
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: {
      enabled: false,
      defaultBot: 'Assistant',
      allowedUserIds: '',
      proxyUrl: '',
      replyTimeoutSec: 300,
      ...(replyLanguage === undefined ? {} : { replyLanguage })
    }
  })
  const deps = makeMockDeps()
  const { controller, worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli })
  try {
    await controller.handleIncomingUpdate(textUpdate(1, 777888, 'hello'))
    return { reply: deps.sentMessages[0]?.text ?? '', language: controller.getState().config.replyLanguage }
  } finally {
    await controller.dispose()
    await worker.deactivate()
  }
}

test('by default the bridge answers a stranger in English with their Telegram ID', async () => {
  const { reply, language } = await unauthorizedReply()
  assert.equal(language, 'en')
  assert.match(reply, /^Access denied\. Your Telegram ID is 777888\./)
  assert.ok(!CJK.test(reply), `the English reply holds Chinese text: ${reply}`)
})

test('with Portuguese chosen the bridge answers a stranger in Portuguese', async () => {
  const { reply } = await unauthorizedReply('pt-BR')
  assert.match(reply, /^Acesso negado\. Seu ID do Telegram é 777888\./)
})

test('with Chinese chosen the bridge keeps its original Chinese text', async () => {
  const { reply } = await unauthorizedReply('zh-CN')
  assert.equal(reply, '未授权访问。你的 Telegram ID 是 777888，请先在 Orca 的 Telegram 面板中将其加入白名单。')
})

test('an unknown stored reply language falls back to English', async () => {
  const { reply, language } = await unauthorizedReply('fr')
  assert.equal(language, 'en')
  assert.match(reply, /^Access denied\./)
})

test('saving a new reply language sends the Telegram command menu again in that language', async () => {
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: { enabled: true, defaultBot: 'Assistant', allowedUserIds: '777888', proxyUrl: '', replyTimeoutSec: 300 }
  })
  // Each long poll stays open until the test answers it, as Telegram does while no message arrives.
  const polls: PromiseWithResolvers<TelegramUpdate[]>[] = []
  const deps = makeMockDeps({
    telegram: {
      getUpdates(_token, _params, options) {
        const poll = Promise.withResolvers<TelegramUpdate[]>()
        polls.push(poll)
        options?.signal?.addEventListener('abort', () => poll.resolve([]), { once: true })
        return poll.promise
      }
    }
  })
  const { controller, worker } = await mountController(host, { telegram: deps.telegram, orcaCli: deps.orcaCli })
  try {
    await until(() => polls.length === 1, 'the first poll')
    assert.equal(deps.registeredCommands.length, 1)
    assert.equal(deps.registeredCommands[0].find((c) => c.command === 'help')?.description, 'Show available commands')

    await within(
      controller.saveConfig({
        enabled: true,
        defaultBot: 'Assistant',
        allowedUserIds: '777888',
        proxyUrl: '',
        replyTimeoutSec: 300,
        syncOrcaOutbound: false,
        replyLanguage: 'pt-BR'
      }),
      'saveConfig with a new language'
    )
    polls[0].resolve([])
    await until(() => deps.registeredCommands.length === 2, 'the command menu in Portuguese')

    const [english, portuguese] = deps.registeredCommands
    assert.deepEqual(
      portuguese.map((c) => c.command),
      english.map((c) => c.command)
    )
    assert.equal(portuguese.find((c) => c.command === 'help')?.description, 'Mostrar os comandos disponíveis')
    assert.equal(controller.getState().config.replyLanguage, 'pt-BR')
  } finally {
    await controller.dispose()
    await worker.deactivate()
  }
})

test('a reply that Orca shortened ends with the note in the chosen language', async () => {
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets: { botToken: '123456:TEST_TOKEN' },
    settings: {
      enabled: false,
      defaultBot: 'Assistant',
      allowedUserIds: '777888',
      proxyUrl: '',
      replyTimeoutSec: 300,
      replyLanguage: 'pt-BR'
    }
  })
  const deps = makeMockDeps()
  const baseReadSession = deps.orcaCli.readSession
  deps.orcaCli.readSession = async (sessionId, limit) => {
    const session = await baseReadSession(sessionId, limit)
    return {
      ...session,
      entries: session.entries.map((e) => (e.role === 'assistant' ? { ...e, shortened: true } : e))
    }
  }
  const { controller, worker } = await mountController(host, {
    telegram: deps.telegram,
    orcaCli: deps.orcaCli,
    pollIntervalMs: 1
  })
  try {
    await controller.handleIncomingUpdate(textUpdate(1, 777888, 'Write the full report'))
    const reply = deps.sentMessages.at(-1)?.text ?? ''
    assert.ok(reply.startsWith('Reply #1 from Assistant'), reply)
    assert.ok(
      reply.endsWith('(A resposta era longa demais e foi encurtada. Abra o Orca para ver o texto completo.)'),
      reply
    )
    assert.ok(!CJK.test(reply), `the Portuguese reply holds Chinese text: ${reply}`)
  } finally {
    await controller.dispose()
    await worker.deactivate()
  }
})
