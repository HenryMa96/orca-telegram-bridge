import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  computeTailHashes,
  extractMessageItems,
  findUnsyncedTail,
  type OrcaChatSummary,
  type OrcaCliRunner,
  type OrcaSessionRead
} from './orca-bridge'
import { extractTablesFromMarkdown } from './table-render'
import {
  markdownToTelegramHtml,
  splitTelegramMessage,
  type TelegramBotCommand,
  type TelegramClient,
  type TelegramInlineKeyboardMarkup
} from './telegram-api'
import * as main from './worker'
import { TelegramBridgeController } from './worker'

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
  const { textWithMarkers, tables } = extractTablesFromMarkdown(md)
  assert.equal(tables.length, 1)
  assert.deepEqual(tables[0].headers, ['名称', '状态'])
  assert.deepEqual(tables[0].rows, [['DemoWorkspace', '正常']])
  assert.match(textWithMarkers, /📊 \*\*表格 1\*\*/)
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
