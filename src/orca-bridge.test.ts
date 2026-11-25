import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assert, test } from 'orca/testing'
import {
  dispatchToOrcaBotAndWait,
  getOrcaBinary,
  isTelegramOriginatedUserMessage,
  listBotsLocalFirst,
  listLocalBots,
  OrcaCliError,
  runOrcaJson,
  type OrcaChatSummary,
  type OrcaCliRunner,
  type OrcaSessionEntry,
  type OrcaSessionRead
} from './orca-bridge'
import type { BotSummary } from './protocol'

const BOUND_CHAT: OrcaChatSummary = {
  id: 'chat-1',
  title: 'Bound',
  lastActivityAt: 1000,
  lastAsked: null,
  lastSaid: null,
  home: false,
  self: false,
  closed: false
}

const user = (text: string): OrcaSessionEntry => ({ kind: 'message', role: 'user', text })
const assistant = (text: string, shortened?: boolean): OrcaSessionEntry =>
  shortened ? { kind: 'message', role: 'assistant', text, shortened } : { kind: 'message', role: 'assistant', text }

/**
 * Fake runner for an existing bound chat. `afterSend(poll, ourUser)` scripts each read made after
 * the message was sent; reads before the send see `beforeSend`. Reads honor `limit` like the CLI.
 */
function makeRunner(options: {
  beforeSend?: OrcaSessionRead
  afterSend: (poll: number, ourUser: OrcaSessionEntry) => OrcaSessionRead
  onRead?: (poll: number) => void
}) {
  const sentBodies: string[] = []
  const readLimits: number[] = []
  let postSendReads = 0
  const runner: OrcaCliRunner = {
    async listBots() {
      return []
    },
    async listBotChats() {
      return [BOUND_CHAT]
    },
    async readSession(_sessionId, limit = 40) {
      readLimits.push(limit)
      let session: OrcaSessionRead
      if (sentBodies.length === 0) {
        session = options.beforeSend ?? { orcaSessionId: BOUND_CHAT.id, state: 'done', entries: [] }
      } else {
        const poll = postSendReads++
        options.onRead?.(poll)
        session = options.afterSend(poll, user(sentBodies[0]))
      }
      return { ...session, entries: session.entries.slice(-limit) }
    },
    async renameChat() {},
    async listAutomations() {
      return []
    },
    async runAutomation() {},
    async sendToBot({ body }) {
      sentBodies.push(body)
    }
  }
  return { runner, sentBodies, readLimits, postSendReads: () => postSendReads }
}

const dispatchParams = {
  botName: 'Assistant',
  boundChatId: BOUND_CHAT.id,
  tgChatId: '777',
  senderLabel: 'Ann (123)',
  userText: 'status?',
  timeoutMs: 2000,
  pollIntervalMs: 1
}

test('dispatch does not return the reply of the turn that was running when we sent', async () => {
  const oldTurn = [user('Earlier question'), assistant('Old partial')]
  const { runner } = makeRunner({
    beforeSend: { orcaSessionId: BOUND_CHAT.id, state: 'working', entries: oldTurn },
    afterSend: (poll, ourUser) => {
      const finishedOld = [...oldTurn, assistant('Old final answer')]
      if (poll === 0) return { orcaSessionId: BOUND_CHAT.id, state: 'done', entries: finishedOld }
      if (poll === 1) {
        return {
          orcaSessionId: BOUND_CHAT.id,
          state: 'working',
          entries: [...finishedOld, ourUser, assistant('Let me look')]
        }
      }
      return {
        orcaSessionId: BOUND_CHAT.id,
        state: 'done',
        entries: [...finishedOld, ourUser, assistant('Let me look'), assistant('Our answer')]
      }
    }
  })

  const result = await dispatchToOrcaBotAndWait(runner, dispatchParams)

  assert.equal(result.replyText, 'Let me look\n\nOur answer')
})

test('dispatch with an unknown turn state waits until the reply stops changing', async () => {
  const { runner } = makeRunner({
    afterSend: (poll, ourUser) => ({
      orcaSessionId: BOUND_CHAT.id,
      entries:
        poll === 0
          ? [ourUser, assistant('Let me check…')]
          : [ourUser, assistant('Let me check…'), assistant('Final answer')]
    })
  })

  const result = await dispatchToOrcaBotAndWait(runner, dispatchParams)

  assert.equal(result.replyText, 'Let me check…\n\nFinal answer')
  assert.equal(result.shortened, false)
})

test('dispatch finds the reply after a tool-heavy turn pushed our message out of the read window', async () => {
  const tools: OrcaSessionEntry[] = Array.from({ length: 150 }, () => ({ kind: 'tool' }))
  const { runner, readLimits } = makeRunner({
    afterSend: (poll, ourUser) =>
      poll === 0
        ? { orcaSessionId: BOUND_CHAT.id, state: 'working', entries: [ourUser, assistant('Working on it')] }
        : {
            orcaSessionId: BOUND_CHAT.id,
            state: 'done',
            entries: [ourUser, assistant('Working on it'), ...tools, assistant('Final summary')],
            limited: true
          }
  })

  const result = await dispatchToOrcaBotAndWait(runner, dispatchParams)

  assert.equal(result.replyText, 'Final summary')
  assert.ok(readLimits.every((limit) => limit === 100))
})

test('dispatch tells the Telegram user when Orca shortened the reply', async () => {
  const { runner } = makeRunner({
    afterSend: (_poll, ourUser) => ({
      orcaSessionId: BOUND_CHAT.id,
      state: 'done',
      entries: [ourUser, assistant('Very long reply', true)]
    })
  })

  const result = await dispatchToOrcaBotAndWait(runner, dispatchParams)

  assert.equal(result.replyText, 'Very long reply')
  assert.equal(result.shortened, true)
})

test('dispatch stops polling as soon as the signal aborts', { timeout: 5000 }, async () => {
  const controller = new AbortController()
  const { runner, postSendReads } = makeRunner({
    afterSend: (_poll, ourUser) => ({
      orcaSessionId: BOUND_CHAT.id,
      state: 'working',
      entries: [ourUser]
    }),
    onRead: (poll) => {
      if (poll === 1) controller.abort()
    }
  })

  await assert.rejects(
    dispatchToOrcaBotAndWait(runner, { ...dispatchParams, timeoutMs: 60_000, signal: controller.signal })
  )
  assert.equal(postSendReads(), 2)
})

test('dispatch does not send to the bot when aborted before sending', async () => {
  const controller = new AbortController()
  const { runner, sentBodies } = makeRunner({
    afterSend: () => ({ orcaSessionId: BOUND_CHAT.id, state: 'done', entries: [] })
  })
  const listBotChats = runner.listBotChats
  runner.listBotChats = async (botName) => {
    controller.abort()
    return listBotChats(botName)
  }

  await assert.rejects(dispatchToOrcaBotAndWait(runner, { ...dispatchParams, signal: controller.signal }))
  assert.equal(sentBodies.length, 0)
})

test('bridge-sent message is recognised when the sender label contains parentheses', async () => {
  const { runner, sentBodies } = makeRunner({
    afterSend: (_poll, ourUser) => ({
      orcaSessionId: BOUND_CHAT.id,
      state: 'done',
      entries: [ourUser, assistant('ok')]
    })
  })

  await dispatchToOrcaBotAndWait(runner, dispatchParams)

  assert.equal(isTelegramOriginatedUserMessage(sentBodies[0]), true)
  assert.equal(
    isTelegramOriginatedUserMessage('Did the Telegram message from owner (Ann, chat 1) [tg:1:2]. arrive?'),
    false
  )
})

test('getOrcaBinary uses orca-ide on Linux, never the GNOME screen reader', () => {
  const env: NodeJS.ProcessEnv = {}
  const bundled = '/opt/Orca/resources/bin/orca-ide'
  assert.equal(getOrcaBinary('linux', '/opt/Orca/orca', env, (f) => f === bundled), bundled)
  assert.equal(getOrcaBinary('linux', '/opt/Orca/orca', env, () => false), 'orca-ide')
  assert.equal(getOrcaBinary('darwin', '/Applications/Orca.app/Contents/MacOS/Orca', env, () => false), 'orca')
  assert.equal(
    getOrcaBinary('linux', '/opt/Orca/orca', { ORCA_CLI: '/custom/orca' }, (f) => f === '/custom/orca'),
    '/custom/orca'
  )
})

async function withOrcaCli<T>(bin: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.ORCA_CLI
  process.env.ORCA_CLI = bin
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.ORCA_CLI
    else process.env.ORCA_CLI = previous
  }
}

test('runOrcaJson with an already-aborted signal rejects as aborted', async () => {
  const controller = new AbortController()
  controller.abort()
  await withOrcaCli(process.execPath, () =>
    assert.rejects(runOrcaJson(['-e', ''], { signal: controller.signal }), /aborted/)
  )
})

test('runOrcaJson survives a CLI that exits without reading its stdin', { timeout: 10_000 }, async () => {
  // Several MB of stdin to a process that exits at once raises EPIPE/EOF on the pipe.
  await withOrcaCli(process.execPath, () =>
    assert.rejects(
      runOrcaJson(['-e', 'process.exit(0)'], { stdinText: 'x'.repeat(4 * 1024 * 1024) }),
      /non-JSON/
    )
  )
  // Give a late pipe error the chance to surface as an uncaught exception inside this test.
  await new Promise((resolve) => setImmediate(resolve))
})

async function cliErrorOf(run: Promise<unknown>): Promise<OrcaCliError> {
  try {
    await run
  } catch (err) {
    if (err instanceof OrcaCliError) return err
    throw err
  }
  throw new Error('runOrcaJson resolved; expected an OrcaCliError')
}

test('a CLI that exits non-zero rejects with its args, exit code and stderr', { timeout: 10_000 }, async () => {
  const args = ['-e', "process.stderr.write('bot not found: Ghost'); process.exit(3)"]
  const err = await withOrcaCli(process.execPath, () => cliErrorOf(runOrcaJson(args)))
  assert.equal(err.kind, 'exit')
  assert.equal(err.exitCode, 3)
  assert.equal(err.stderr, 'bot not found: Ghost')
  assert.equal(err.message, 'bot not found: Ghost')
  assert.deepEqual(err.args, args)
  assert.ok(err.durationMs >= 0)
})

test('non-JSON CLI output is reported by size, never by content', { timeout: 10_000 }, async () => {
  const err = await withOrcaCli(process.execPath, () =>
    cliErrorOf(runOrcaJson(['-e', "process.stdout.write('session secret text')"]))
  )
  assert.equal(err.kind, 'json')
  assert.equal(err.exitCode, 0)
  assert.equal(err.stdoutBytes, Buffer.byteLength('session secret text'))
  assert.match(err.message, /non-JSON/)
  assert.ok(!err.message.includes('session secret text'))
})

test('an already-aborted signal rejects with kind aborted and masks text arguments', async () => {
  const controller = new AbortController()
  controller.abort()
  const err = await cliErrorOf(
    runOrcaJson(['orchestration', 'send', '--subject', 'Telegram: my private words', '--json'], {
      signal: controller.signal
    })
  )
  assert.equal(err.kind, 'aborted')
  assert.equal(err.exitCode, null)
  assert.deepEqual(err.args, ['orchestration', 'send', '--subject', '<26 chars>', '--json'])
})

async function withBotsRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tg-bridge-bots-'))
  try {
    return await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function writeBotFolder(root: string, folder: string, files: Record<string, string>): Promise<void> {
  await mkdir(path.join(root, folder), { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(root, folder, name), content, 'utf8')
  }
}

test('local bot folders list only valid bots, sorted, with SOUL.md specialty', async () => {
  await withBotsRoot(async (root) => {
    // Folder order (babyshark, zed) and case-sensitive order (B < a) both differ from the wanted order.
    await writeBotFolder(root, 'zed', {
      'bot.json': JSON.stringify({ id: 'id-alpha', name: 'alpha', agent: 'codex' }),
      'SOUL.md': '# Alpha\n\n## Role\n\nWatches the  deploys\nand reports.\n\nSecond paragraph.\n'
    })
    await writeBotFolder(root, 'babyshark', {
      'bot.json': JSON.stringify({ id: 'id-shark', name: 'BabyShark', avatar: 'x' })
    })
    await writeBotFolder(root, 'no-meta', { 'SOUL.md': 'Not a bot.' })
    await writeBotFolder(root, 'broken', { 'bot.json': '{ not json' })
    await writeBotFolder(root, 'no-name', { 'bot.json': JSON.stringify({ id: 'id-anon' }) })

    const bots = await listLocalBots(root)

    assert.deepEqual(bots, [
      { id: 'id-alpha', name: 'alpha', specialty: 'Watches the deploys and reports.', agent: 'codex' },
      { id: 'id-shark', name: 'BabyShark', specialty: '', agent: 'claude' }
    ])
  })
})

test('a long SOUL.md paragraph is cut so the panel list stays short', async () => {
  await withBotsRoot(async (root) => {
    await writeBotFolder(root, 'talker', {
      'bot.json': JSON.stringify({ id: 'id-talk', name: 'Talker' }),
      'SOUL.md': 'word '.repeat(100)
    })
    const [bot] = await listLocalBots(root)
    assert.ok(bot.specialty.length <= 200, `specialty has ${bot.specialty.length} chars`)
    assert.match(bot.specialty, /^word word .*…$/)
  })
})

test('a missing or empty bots folder yields no local bots', async () => {
  await withBotsRoot(async (root) => {
    assert.deepEqual(await listLocalBots(root), [])
    assert.deepEqual(await listLocalBots(path.join(root, 'does-not-exist')), [])
  })
})

const CLI_BOT: BotSummary = { id: 'id-remote', name: 'Remote', specialty: 'From CLI', agent: 'claude' }

test('listing bots uses local folders and never waits on the CLI when any exist', async () => {
  await withBotsRoot(async (root) => {
    await writeBotFolder(root, 'babyshark', {
      'bot.json': JSON.stringify({ id: 'id-shark', name: 'BabyShark', agent: 'claude' })
    })
    let cliCalls = 0
    const bots = await listBotsLocalFirst(root, async () => {
      cliCalls++
      return [CLI_BOT]
    })
    assert.deepEqual(bots.map((b) => b.name), ['BabyShark'])
    assert.equal(cliCalls, 0)
  })
})

test('listing bots falls back to the CLI when no local bot is readable', async () => {
  await withBotsRoot(async (root) => {
    await writeBotFolder(root, 'broken', { 'bot.json': '{ not json' })
    const bots = await listBotsLocalFirst(root, async () => [CLI_BOT])
    assert.deepEqual(bots, [CLI_BOT])
  })
})
