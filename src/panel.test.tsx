import { assert, mockHost, mount, test, type TestPanel } from 'orca/testing'
import * as panel from './panel'
import type {
  BridgeConfig,
  BridgeState,
  BridgeView,
  ChatBinding,
  SaveConfigInput
} from './protocol'

const ORCA_BOT_LABEL = 'Orca bot (this Telegram bot talks only to it)'

type BridgeOverrides = Partial<Omit<BridgeView, 'config'>> & { config?: Partial<BridgeConfig> }

function binding(tgChatId: string, botName: string, orcaChatId: string | null): ChatBinding {
  return { tgChatId, botId: `bot-${botName}`, botName, orcaChatId, updatedAt: Date.now() }
}

function makeBridge(id: string, overrides: BridgeOverrides = {}): BridgeView {
  const { config, ...rest } = overrides
  const name = rest.name ?? 'Main'
  return {
    id,
    name,
    status: 'connected',
    polling: true,
    botUsername: 'demo_orca_bot',
    botDisplayName: 'DemoBot',
    lastError: null,
    lastBlockedUserId: null,
    lastPollAt: Date.now(),
    bindings: [binding('123456', 'Assistant', 'chat-abc')],
    ...rest,
    config: {
      id,
      name,
      hasToken: true,
      enabled: true,
      orcaBot: 'Assistant',
      allowedUserIds: '123456',
      proxyUrl: 'http://127.0.0.1:7890',
      replyTimeoutSec: 300,
      syncOrcaOutbound: false,
      replyLanguage: 'en',
      ...config
    }
  }
}

function makeState(overrides: Partial<BridgeState> = {}): BridgeState {
  return {
    bridges: [makeBridge('b1')],
    bots: [
      { id: 'bot-1', name: 'Assistant', specialty: 'Workspace assistant', agent: 'claude' },
      { id: 'bot-2', name: 'BabyShark', specialty: 'CI', agent: 'claude' },
      { id: 'bot-3', name: 'VerissimaDev', specialty: '', agent: 'codex' }
    ],
    global: { debugLogging: false },
    logs: [
      {
        id: '1',
        at: Date.now(),
        level: 'info',
        scope: 'telegram',
        bridgeId: 'b1',
        message: 'Connected to Telegram as @demo_orca_bot.'
      }
    ],
    logTotal: 1,
    ...overrides
  }
}

// @ci_bot is pinned to BabyShark and restricted; @dev_bot is pinned to the first Orca bot and open.
function twoBridges(): BridgeView[] {
  return [
    makeBridge('ci', {
      name: 'CI',
      botUsername: 'ci_bot',
      config: { orcaBot: 'BabyShark', allowedUserIds: '111' },
      bindings: [binding('111', 'BabyShark', 'chat-ci')]
    }),
    makeBridge('dev', {
      name: 'Dev',
      botUsername: 'dev_bot',
      config: { orcaBot: '', allowedUserIds: '' },
      bindings: [binding('222', 'Assistant', 'chat-dev'), binding('333', 'Assistant', null)]
    })
  ]
}

function withBridge(state: BridgeState, bridgeId: string, patch: BridgeOverrides): BridgeState {
  return {
    ...state,
    bridges: state.bridges.map((b) =>
      b.id === bridgeId
        ? { ...b, ...patch, config: { ...b.config, ...patch.config } }
        : b
    )
  }
}

async function openEditor(view: TestPanel, bridgeId: string): Promise<void> {
  await view.press({ testId: `edit:${bridgeId}` })
}

test('renders bridge status, allows saving config, and handles unauthorized user banner', async () => {
  let currentState = makeState({ bridges: [makeBridge('b1', { lastBlockedUserId: '999000' })] })
  const allowed: Array<{ bridgeId: string; userId: string }> = []
  const saved: SaveConfigInput[] = []
  const tested: Array<{ bridgeId: string }> = []
  const host = mockHost({
    requests: {
      'bridge.getState': () => currentState,
      'bridge.saveConfig': (input: SaveConfigInput) => {
        saved.push(input)
        currentState = withBridge(currentState, 'b1', {
          config: { syncOrcaOutbound: input.syncOrcaOutbound }
        })
        return currentState
      },
      'bridge.allowUserId': (input: { bridgeId: string; userId: string }) => {
        allowed.push(input)
        currentState = withBridge(currentState, 'b1', {
          lastBlockedUserId: null,
          config: { allowedUserIds: `123456, ${input.userId}` }
        })
        return currentState
      },
      'bridge.testConnection': (input: { bridgeId: string }) => {
        tested.push(input)
        return { ok: true, username: 'demo_orca_bot', botId: 100000001, state: currentState }
      }
    }
  })

  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'Connected' }))
  assert.ok(view.find({ text: 'Allow 999000' }))

  await view.press({ text: 'Allow 999000' })
  assert.deepEqual(allowed, [{ bridgeId: 'b1', userId: '999000' }])
  assert.equal(view.find({ text: 'Allow 999000' }), null)

  await openEditor(view, 'b1')
  await view.press({ text: 'Save Settings' })
  assert.equal(saved.length, 1)
  assert.equal(saved[0].bridgeId, 'b1')
  assert.equal('botToken' in saved[0], false)
  // Bot on/off lives only in the bridge card; saving the form must not touch it.
  assert.equal('enabled' in saved[0], false)
  assert.ok(view.find({ text: 'Settings saved.' }))

  await view.press({ text: 'Test Connection' })
  assert.deepEqual(tested, [{ bridgeId: 'b1' }])
  assert.ok(view.find({ text: /Connected to @demo_orca_bot/ }))

  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('two bridges render one card each with name, @username and pinned Orca bot', async () => {
  const host = mockHost({
    requests: { 'bridge.getState': () => makeState({ bridges: twoBridges() }) }
  })
  const view = await mount(panel, { host })
  const cards = view.findAll({ type: 'Card' })
  assert.deepEqual(
    cards.map((c) => c.label),
    ['CI', 'Dev']
  )
  assert.deepEqual(
    cards.map((c) => c.props.description),
    ['@ci_bot → BabyShark', '@dev_bot → first Orca bot']
  )
  assert.equal(view.findAll({ label: 'Bot active' }).length, 2)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('Bot active on one bridge switches only that bridge', async () => {
  let current = makeState({ bridges: twoBridges() })
  const sent: Array<{ bridgeId: string; enabled: boolean }> = []
  const host = mockHost({
    requests: {
      'bridge.getState': () => current,
      'bridge.setEnabled': (input: { bridgeId: string; enabled: boolean }) => {
        sent.push(input)
        current = withBridge(current, input.bridgeId, {
          status: input.enabled ? 'connected' : 'stopped',
          polling: input.enabled,
          config: { enabled: input.enabled }
        })
        return current
      }
    }
  })
  const view = await mount(panel, { host })
  await view.toggle({ testId: 'active:dev' })
  assert.deepEqual(sent, [{ bridgeId: 'dev', enabled: false }])
  assert.equal(view.valueOf({ testId: 'active:dev' }), false)
  assert.equal(view.valueOf({ testId: 'active:ci' }), true)
  assert.ok(view.find({ text: 'Paused' }))
  assert.ok(view.find({ text: 'Connected' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Add bridge asks the worker and opens the new bridge in the editor', async () => {
  let current = makeState({ bridges: twoBridges() })
  const added: unknown[] = []
  const host = mockHost({
    requests: {
      'bridge.getState': () => current,
      'bridge.add': (input: { name?: string }) => {
        added.push(input)
        const fresh = makeBridge('b3', {
          name: 'Bridge 3',
          status: 'needs_token',
          polling: false,
          botUsername: null,
          bindings: [],
          config: { hasToken: false, enabled: false, orcaBot: '', allowedUserIds: '' }
        })
        current = { ...current, bridges: [...current.bridges, fresh] }
        return { bridgeId: 'b3', state: current }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: 'Add bridge' })
  assert.equal(added.length, 1)
  assert.ok(view.find({ type: 'Card', label: 'Bridge 3' }))
  assert.ok(view.find({ type: 'Card', label: 'Edit Bridge 3' }))
  assert.equal(view.valueOf({ label: 'Name' }), 'Bridge 3')
  // a new bridge has no token yet, so it cannot be tested or switched on
  assert.equal(view.find({ text: 'Test Connection' })!.disabled, true)
  assert.equal(view.find({ testId: 'active:b3' })!.props.disabled, true)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Save sends the edited bridge id and never the on/off state', async () => {
  const state = makeState({ bridges: twoBridges() })
  const saved: SaveConfigInput[] = []
  const host = mockHost({
    requests: {
      'bridge.getState': () => state,
      'bridge.saveConfig': (input: SaveConfigInput) => {
        saved.push(input)
        return state
      }
    }
  })
  const view = await mount(panel, { host })
  await openEditor(view, 'dev')
  assert.equal(view.valueOf({ label: 'Name' }), 'Dev')
  await view.type({ label: 'Name' }, 'Dev box', { replace: true })
  await view.select({ label: ORCA_BOT_LABEL }, 'VerissimaDev')
  await view.press({ text: 'Save Settings' })
  assert.deepEqual(saved, [
    {
      bridgeId: 'dev',
      name: 'Dev box',
      orcaBot: 'VerissimaDev',
      allowedUserIds: '',
      proxyUrl: 'http://127.0.0.1:7890',
      replyTimeoutSec: 300,
      syncOrcaOutbound: false,
      replyLanguage: 'en'
    }
  ])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a duplicate token refused by the worker shows in feedback and keeps the editor', async () => {
  const state = makeState({ bridges: twoBridges() })
  const host = mockHost({
    requests: {
      'bridge.getState': () => state,
      'bridge.saveConfig': () => {
        throw new Error('This bot token is already used by bridge "CI".')
      }
    }
  })
  const view = await mount(panel, { host })
  await openEditor(view, 'dev')
  await view.type({ label: 'Telegram Bot Token' }, '123456:DUPLICATE')
  await view.press({ text: 'Save Settings' })
  assert.ok(view.find({ text: /already used by bridge "CI"/ }))
  assert.equal(view.find({ text: 'Settings saved.' }), null)
  assert.ok(view.find({ type: 'Card', label: 'Edit Dev' }))
  // the typed token stays so the user can fix it
  assert.equal(view.valueOf({ label: 'Telegram Bot Token' }), '123456:DUPLICATE')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Remove needs a second press on Confirm remove before asking the worker', async () => {
  let current = makeState({ bridges: twoBridges() })
  const removed: Array<{ bridgeId: string }> = []
  const host = mockHost({
    requests: {
      'bridge.getState': () => current,
      'bridge.remove': (input: { bridgeId: string }) => {
        removed.push(input)
        current = { ...current, bridges: current.bridges.filter((b) => b.id !== input.bridgeId) }
        return current
      }
    }
  })
  const view = await mount(panel, { host })

  await view.press({ testId: 'remove:ci' })
  assert.ok(view.find({ testId: 'confirm-remove:ci' }))
  await view.press({ testId: 'keep:ci' })
  assert.equal(view.find({ testId: 'confirm-remove:ci' }), null)

  await view.press({ testId: 'remove:dev' })
  assert.deepEqual(removed, [])
  assert.equal(view.find({ testId: 'confirm-remove:dev' })!.text, 'Confirm remove')
  await view.press({ testId: 'confirm-remove:dev' })
  assert.deepEqual(removed, [{ bridgeId: 'dev' }])
  assert.equal(view.find({ type: 'Card', label: 'Dev' }), null)
  assert.ok(view.find({ type: 'Card', label: 'CI' }))
  assert.ok(view.find({ text: 'Removed Dev.' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Chats tab groups bindings under each bridge and resets on the right bridge', async () => {
  const state = makeState({ bridges: twoBridges() })
  const resets: Array<{ bridgeId: string; tgChatId: string }> = []
  const host = mockHost({
    requests: {
      'bridge.getState': () => state,
      'bridge.resetBinding': (input: { bridgeId: string; tgChatId: string }) => {
        resets.push(input)
        return state
      }
    }
  })
  const view = await mount(panel, { host })
  await view.select({ label: 'Telegram Bridge sections' }, 'bindings')
  const headings = view
    .findAll({ type: 'Heading' })
    .filter((h) => h.props.level === 3)
    .map((h) => h.text)
  assert.deepEqual(headings, ['CI', 'Dev'])
  assert.ok(view.find({ label: 'TG 222 -> Assistant' }))
  assert.ok(view.find({ label: 'TG 111 -> BabyShark' }))

  await view.press({ testId: 'reset:dev:222' })
  assert.deepEqual(resets, [{ bridgeId: 'dev', tgChatId: '222' }])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('logs bridge filter shows one bridge, or plugin entries without a bridge', async () => {
  const at = Date.now()
  const host = mockHost({
    requests: {
      'bridge.getState': () =>
        makeState({
          bridges: twoBridges(),
          logTotal: 3,
          logs: [
            { id: 'c', at, level: 'info', scope: 'telegram', bridgeId: 'ci', message: 'CI polled' },
            { id: 'd', at, level: 'info', scope: 'telegram', bridgeId: 'dev', message: 'Dev polled' },
            { id: 'p', at, level: 'info', scope: 'config', message: 'Plugin started' }
          ]
        })
    }
  })
  const view = await mount(panel, { host })
  await view.select({ label: 'Telegram Bridge sections' }, 'logs')
  assert.ok(view.find({ text: 'Showing 3 of 3 entries' }))
  assert.equal(view.find({ label: 'Dev polled' })!.props.description, 'INFO · telegram · Dev')

  await view.select({ label: 'Bridge' }, 'dev')
  assert.ok(view.find({ label: 'Dev polled' }))
  assert.equal(view.find({ label: 'CI polled' }), null)
  assert.equal(view.find({ label: 'Plugin started' }), null)
  assert.ok(view.find({ text: 'Showing 1 of 3 entries' }))

  await view.select({ label: 'Bridge' }, '__plugin__')
  assert.ok(view.find({ label: 'Plugin started' }))
  assert.equal(view.find({ label: 'Dev polled' }), null)
  assert.equal(view.find({ label: 'CI polled' }), null)

  await view.select({ label: 'Bridge' }, 'all')
  assert.ok(view.find({ text: 'Showing 3 of 3 entries' }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('default bot select offers auto with a non-empty value and saves it as empty orcaBot', async () => {
  const saved: SaveConfigInput[] = []
  const state = makeState({ bridges: [makeBridge('b1', { config: { orcaBot: '' } })] })
  const host = mockHost({
    requests: {
      'bridge.getState': () => state,
      'bridge.saveConfig': (input: SaveConfigInput) => {
        saved.push(input)
        return state
      }
    }
  })
  const view = await mount(panel, { host })
  await openEditor(view, 'b1')
  const options = view.find({ label: ORCA_BOT_LABEL })!.props.options as Array<{ value: string }>
  assert.ok(options.length >= 2)
  assert.equal(options.some((o) => o.value === ''), false)
  assert.equal(view.valueOf({ label: ORCA_BOT_LABEL }), '__auto__')

  await view.select({ label: ORCA_BOT_LABEL }, 'Assistant')
  await view.select({ label: ORCA_BOT_LABEL }, '__auto__')
  await view.press({ text: 'Save Settings' })
  assert.equal(saved[0].orcaBot, '')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('the reply language select shows the saved language and saves the chosen one', async () => {
  const saved: SaveConfigInput[] = []
  const state = makeState({ bridges: [makeBridge('b1', { config: { replyLanguage: 'zh-CN' } })] })
  const host = mockHost({
    requests: {
      'bridge.getState': () => state,
      'bridge.saveConfig': (input: SaveConfigInput) => {
        saved.push(input)
        return state
      }
    }
  })
  const view = await mount(panel, { host })
  await openEditor(view, 'b1')
  assert.equal(view.valueOf({ label: 'Telegram reply language' }), 'zh-CN')

  await view.select({ label: 'Telegram reply language' }, 'pt-BR')
  await view.press({ text: 'Save Settings' })
  assert.equal(saved[0].replyLanguage, 'pt-BR')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('failing worker request shows feedback and refresh keeps unsaved edits', async () => {
  let failSetEnabled = true
  const host = mockHost({
    requests: {
      'bridge.getState': () => makeState(),
      'bridge.setEnabled': () => {
        if (failSetEnabled) throw new Error('worker exploded')
        return makeState()
      }
    }
  })
  const view = await mount(panel, { host })
  await openEditor(view, 'b1')
  await view.type({ label: 'HTTP Proxy URL (optional)' }, 'http://10.0.0.1:8080', { replace: true })

  await view.toggle({ label: 'Bot active' })
  assert.ok(view.find({ text: /worker exploded/ }))
  // the switch shows the worker's state, so a failed request leaves it on
  assert.equal(view.valueOf({ label: 'Bot active' }), true)
  // busy must be released so controls stay usable after the failure
  assert.equal(view.find({ label: 'Bot active' })!.props.disabled, false)
  failSetEnabled = false
  await view.press({ text: 'Refresh' })
  assert.equal(view.valueOf({ label: 'HTTP Proxy URL (optional)' }), 'http://10.0.0.1:8080')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('turning Bot active off asks the worker at once and shows the paused state', async () => {
  let current = makeState()
  const sent: Array<{ bridgeId: string; enabled: boolean }> = []
  const host = mockHost({
    requests: {
      'bridge.getState': () => current,
      'bridge.setEnabled': (input: { bridgeId: string; enabled: boolean }) => {
        sent.push(input)
        current = withBridge(current, input.bridgeId, {
          status: input.enabled ? 'connected' : 'stopped',
          polling: input.enabled,
          config: { enabled: input.enabled }
        })
        return current
      }
    }
  })
  const view = await mount(panel, { host })
  assert.equal(view.valueOf({ label: 'Bot active' }), true)
  assert.ok(view.find({ text: 'Connected' }))

  await view.toggle({ label: 'Bot active' })
  assert.deepEqual(sent, [{ bridgeId: 'b1', enabled: false }])
  assert.equal(view.valueOf({ label: 'Bot active' }), false)
  assert.ok(view.find({ text: 'Paused' }))
  assert.equal(view.find({ text: 'Connected' }), null)
  // the old header toggle must not come back as 'Start Polling' once paused
  assert.equal(view.find({ text: 'Start Polling' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('bot on/off has one control per bridge: no polling button and no switch in the editor', async () => {
  const host = mockHost({
    requests: { 'bridge.getState': () => makeState({ bridges: twoBridges() }) }
  })
  const view = await mount(panel, { host })
  await openEditor(view, 'dev')
  assert.equal(view.find({ text: 'Pause Polling' }), null)
  assert.equal(view.find({ text: 'Start Polling' }), null)
  assert.equal(view.find({ label: 'Enable automatic polling' }), null)
  assert.equal(view.findAll({ label: 'Bot active' }).length, 2)
  await view.unmount()
})

test('without a saved token the Bot active switch is disabled and says why', async () => {
  const state = makeState({
    bridges: [
      makeBridge('b1', {
        status: 'needs_token',
        polling: false,
        botUsername: null,
        config: { hasToken: false }
      })
    ]
  })
  const host = mockHost({ requests: { 'bridge.getState': () => state } })
  const view = await mount(panel, { host })
  assert.equal(view.find({ label: 'Bot active' })!.props.disabled, true)
  assert.ok(view.find({ text: 'Save a bot token first.' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('long log messages are truncated below the label limit', async () => {
  const long = 'x'.repeat(5000)
  const host = mockHost({
    requests: {
      'bridge.getState': () =>
        makeState({ logs: [{ id: '1', at: Date.now(), level: 'error', message: long }] })
    }
  })
  const view = await mount(panel, { host })
  await view.select({ label: 'Telegram Bridge sections' }, 'logs')
  const item = view.find({ label: /^x+…$/ })
  assert.ok(item)
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('log level filter hides entries outside the chosen level', async () => {
  const at = Date.now()
  const host = mockHost({
    requests: {
      'bridge.getState': () =>
        makeState({
          logTotal: 4,
          logs: [
            { id: 'e', at, level: 'error', scope: 'orca-cli', message: 'Orca CLI call failed' },
            { id: 'w', at, level: 'warn', scope: 'telegram', message: 'Telegram answered slowly' },
            { id: 'i', at, level: 'info', scope: 'bridge', message: 'Polling started' },
            { id: 'd', at, level: 'debug', scope: 'dispatch', message: 'Dispatch finished in 12 ms' }
          ]
        })
    }
  })
  const view = await mount(panel, { host })
  await view.select({ label: 'Telegram Bridge sections' }, 'logs')
  assert.ok(view.find({ label: 'Polling started' }))
  assert.ok(view.find({ text: 'Showing 4 of 4 entries' }))

  await view.select({ label: 'Log level filter' }, 'errors')
  assert.ok(view.find({ label: 'Orca CLI call failed' }))
  assert.equal(view.find({ label: 'Telegram answered slowly' }), null)
  assert.equal(view.find({ label: 'Polling started' }), null)
  assert.equal(view.find({ label: 'Dispatch finished in 12 ms' }), null)
  assert.ok(view.find({ text: 'Showing 1 of 4 entries' }))

  await view.select({ label: 'Log level filter' }, 'warnings')
  assert.ok(view.find({ label: 'Orca CLI call failed' }))
  assert.ok(view.find({ label: 'Telegram answered slowly' }))
  assert.equal(view.find({ label: 'Polling started' }), null)

  await view.select({ label: 'Log level filter' }, 'debug')
  assert.ok(view.find({ label: 'Dispatch finished in 12 ms' }))
  assert.equal(view.find({ label: 'Orca CLI call failed' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('an entry with details shows them after expanding, between plain entries', async () => {
  const at = Date.now()
  const details = 'OrcaCliError: orca exited with code 2\nargs: bot send --json\nexitCode: 2\nstderr: unknown bot'
  const host = mockHost({
    requests: {
      'bridge.getState': () =>
        makeState({
          logTotal: 3,
          logs: [
            { id: 'a', at, level: 'info', scope: 'dispatch', message: 'Reply sent' },
            { id: 'b', at, level: 'error', scope: 'orca-cli', message: 'Orca CLI call failed', details },
            { id: 'c', at, level: 'info', scope: 'bridge', message: 'Polling started' }
          ]
        })
    }
  })
  const view = await mount(panel, { host })
  await view.select({ label: 'Telegram Bridge sections' }, 'logs')
  assert.ok(view.find({ label: 'Reply sent' }))
  assert.ok(view.find({ label: 'Polling started' }))
  assert.equal(view.find({ type: 'CodeView' }), null)

  const entry = view.find({ type: 'Collapsible', label: 'Orca CLI call failed' })
  assert.ok(entry)
  assert.match(String(entry!.props.description), /^ERROR · orca-cli · /)
  await view.toggle(entry!)
  const code = view.find({ type: 'CodeView' })
  assert.ok(code)
  assert.equal(code!.props.code, details)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('export logs saves the worker text as a file and reports only a real save', async () => {
  const exported = { fileName: 'telegram-bridge-logs-2026-11-25.txt', text: 'Telegram Bridge 0.2.0\n\n[error] boom' }
  let exportCalls = 0
  const host = mockHost({
    results: { 'files.saveAs': { status: 'cancelled' } },
    requests: {
      'bridge.getState': () => makeState(),
      'bridge.exportLogs': () => {
        exportCalls += 1
        return exported
      }
    }
  })
  const view = await mount(panel, { host })
  await view.select({ label: 'Telegram Bridge sections' }, 'logs')

  await view.press({ text: 'Export logs' })
  assert.equal(exportCalls, 1)
  assert.deepEqual(
    host.calls.filter((c) => c.method === 'files.saveAs').map((c) => c.params),
    [{ suggestedName: exported.fileName, mimeType: 'text/plain', data: exported.text }]
  )
  assert.equal(view.find({ text: 'Logs exported.' }), null)

  host.respond('files.saveAs', { status: 'saved' })
  await view.press({ text: 'Export logs' })
  assert.equal(exportCalls, 2)
  assert.ok(view.find({ text: 'Logs exported.' }))
  assert.deepEqual(view.refusals, [])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('debug logging switch asks the worker to turn global debug logging on', async () => {
  let current = makeState()
  const sent: Array<{ enabled: boolean }> = []
  const host = mockHost({
    requests: {
      'bridge.getState': () => current,
      'bridge.setDebugLogging': (input: { enabled: boolean }) => {
        sent.push(input)
        current = makeState({ global: { debugLogging: input.enabled } })
        return current
      }
    }
  })
  const view = await mount(panel, { host })
  await view.select({ label: 'Telegram Bridge sections' }, 'logs')
  assert.equal(view.valueOf({ label: 'Debug logging' }), false)

  await view.toggle({ label: 'Debug logging' })
  assert.deepEqual(sent, [{ enabled: true }])
  assert.equal(view.valueOf({ label: 'Debug logging' }), true)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('entries stored by 0.2.0 without scope render as bridge entries', async () => {
  const host = mockHost({
    requests: {
      'bridge.getState': () =>
        makeState({
          logs: [{ id: 'old', at: Date.now(), level: 'warn', message: 'Telegram polling paused.' }]
        })
    }
  })
  const view = await mount(panel, { host })
  await view.select({ label: 'Telegram Bridge sections' }, 'logs')
  const item = view.find({ label: 'Telegram polling paused.' })
  assert.ok(item)
  assert.equal(item!.props.description, 'WARN · bridge')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

async function mountWithAllowed(allowedUserIds: string, syncOrcaOutbound = false) {
  const state = makeState({
    bridges: [makeBridge('b1', { config: { allowedUserIds, syncOrcaOutbound } })]
  })
  const host = mockHost({ requests: { 'bridge.getState': () => state } })
  const view = await mount(panel, { host })
  await view.select({ label: 'Telegram Bridge sections' }, 'setup')
  await openEditor(view, 'b1')
  return view
}

// A Callout's title is a prop, not part of the text the finders match.
function openWarnings(view: TestPanel) {
  return view.findAll({ type: 'Callout' }).filter((c) => c.props.title === 'Open to everyone')
}

test('an empty allowlist shows the open to everyone warning naming the bot', async () => {
  const view = await mountWithAllowed('')
  assert.equal(openWarnings(view).length, 1)
  assert.ok(view.find({ text: /Anyone who finds @demo_orca_bot on Telegram/ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a list with only a negative group ID hides the open warning', async () => {
  const view = await mountWithAllowed('-1001234567890')
  assert.equal(openWarnings(view).length, 0)
  await view.unmount()
})

test('an allowlist with no valid ID still counts as open', async () => {
  const view = await mountWithAllowed('abc, ,')
  assert.equal(openWarnings(view).length, 1)
  await view.unmount()
})

test('the open warning is per bridge: only the open bridge shows it', async () => {
  const host = mockHost({
    requests: { 'bridge.getState': () => makeState({ bridges: twoBridges() }) }
  })
  const view = await mount(panel, { host })
  assert.equal(openWarnings(view).length, 1)
  assert.ok(view.find({ text: /Anyone who finds @dev_bot on Telegram/ }))
  assert.equal(view.find({ text: /Anyone who finds @ci_bot/ }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('sync on with an open allowlist says sync is paused, restricted list does not', async () => {
  const paused = /Sync is paused while the bot is open to everyone/
  const open = await mountWithAllowed('', true)
  assert.ok(open.find({ text: paused }))
  await open.unmount()

  const restricted = await mountWithAllowed('123456', true)
  assert.equal(restricted.find({ text: paused }), null)
  await restricted.unmount()

  const syncOff = await mountWithAllowed('', false)
  assert.equal(syncOff.find({ text: paused }), null)
  await syncOff.unmount()
})
