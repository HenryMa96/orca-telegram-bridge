import { assert, mockHost, mount, test, type TestPanel } from 'orca/testing'
import * as panel from './panel'
import type { BridgeState } from './protocol'

function makeState(overrides: Partial<BridgeState> = {}): BridgeState {
  return {
    status: 'connected',
    polling: true,
    botUsername: 'demo_orca_bot',
    botDisplayName: 'DemoBot',
    lastError: null,
    lastBlockedUserId: null,
    lastPollAt: Date.now(),
    config: {
      hasToken: true,
      enabled: true,
      defaultBot: 'Assistant',
      allowedUserIds: '123456',
      proxyUrl: 'http://127.0.0.1:7890',
      replyTimeoutSec: 300,
      syncOrcaOutbound: false,
      debugLogging: false,
      replyLanguage: 'en'
    },
    bots: [
      { id: 'bot-1', name: 'Assistant', specialty: 'Workspace assistant', agent: 'claude' }
    ],
    bindings: [
      {
        tgChatId: '123456',
        botId: 'bot-1',
        botName: 'Assistant',
        orcaChatId: 'chat-abc',
        updatedAt: Date.now()
      }
    ],
    logs: [
      {
        id: '1',
        at: Date.now(),
        level: 'info',
        scope: 'telegram',
        message: 'Connected to Telegram as @demo_orca_bot.'
      }
    ],
    logTotal: 1,
    ...overrides
  }
}

test('renders bridge status, allows saving config, and handles unauthorized user banner', async () => {
  let currentState = makeState({ lastBlockedUserId: '999000' })
  let lastSavedInput: Record<string, unknown> | null = null
  const host = mockHost({
    requests: {
      'bridge.getState': () => currentState,
      'bridge.saveConfig': (input: Record<string, unknown>) => {
        lastSavedInput = input
        currentState = makeState({
          config: {
            ...currentState.config,
            syncOrcaOutbound: Boolean(input.syncOrcaOutbound)
          }
        })
        return currentState
      },
      'bridge.allowUserId': ({ userId }: { userId: string }) => {
        currentState = makeState({
          lastBlockedUserId: null,
          config: { ...currentState.config, allowedUserIds: `123456, ${userId}` }
        })
        return currentState
      },
      'bridge.testConnection': () => ({
        ok: true,
        username: 'demo_orca_bot',
        botId: 100000001,
        state: currentState
      })
    }
  })

  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'Connected' }))
  assert.ok(view.find({ text: 'Allow 999000' }))

  await view.press({ text: 'Allow 999000' })
  assert.equal(view.find({ text: 'Allow 999000' }), null)

  await view.press({ text: 'Save Settings' })
  assert.ok(lastSavedInput !== null)
  assert.equal('botToken' in lastSavedInput!, false)
  assert.ok(view.find({ text: 'Settings saved.' }))

  await view.press({ text: 'Test Connection' })
  assert.ok(view.find({ text: /Connected to @demo_orca_bot/ }))

  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

function findOptions(node: unknown): Array<{ value: string; label: string }> | null {
  if (!node || typeof node !== 'object') return null
  const rec = node as Record<string, unknown>
  if (Array.isArray(rec.options)) return rec.options as Array<{ value: string; label: string }>
  for (const v of Object.values(rec)) {
    const found = findOptions(v)
    if (found) return found
  }
  return null
}

test('default bot select offers auto with a non-empty value and saves it as empty defaultBot', async () => {
  let saved: Record<string, unknown> | null = null
  const state = makeState({ config: { ...makeState().config, defaultBot: '' } })
  const host = mockHost({
    requests: {
      'bridge.getState': () => state,
      'bridge.saveConfig': (input: Record<string, unknown>) => {
        saved = input
        return state
      }
    }
  })
  const view = await mount(panel, { host })
  const options = findOptions(view.tree())
  assert.ok(options && options.length >= 2)
  assert.equal(options!.some((o) => o.value === ''), false)
  assert.equal(view.valueOf(view.find({ label: 'Default Orca Bot' })!), '__auto__')

  await view.select({ label: 'Default Orca Bot' }, 'Assistant')
  await view.select({ label: 'Default Orca Bot' }, '__auto__')
  await view.press({ text: 'Save Settings' })
  assert.equal(saved!.defaultBot, '')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('the reply language select shows the saved language and saves the chosen one', async () => {
  let saved: Record<string, unknown> | null = null
  const state = makeState({ config: { ...makeState().config, replyLanguage: 'zh-CN' } })
  const host = mockHost({
    requests: {
      'bridge.getState': () => state,
      'bridge.saveConfig': (input: Record<string, unknown>) => {
        saved = input
        return state
      }
    }
  })
  const view = await mount(panel, { host })
  assert.equal(view.valueOf(view.find({ label: 'Telegram reply language' })!), 'zh-CN')

  await view.select({ label: 'Telegram reply language' }, 'pt-BR')
  await view.press({ text: 'Save Settings' })
  assert.equal(saved!.replyLanguage, 'pt-BR')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('failing worker request shows feedback and refresh keeps unsaved edits', async () => {
  let failToggle = true
  const host = mockHost({
    requests: {
      'bridge.getState': () => makeState(),
      'bridge.togglePolling': () => {
        if (failToggle) throw new Error('worker exploded')
        return makeState()
      }
    }
  })
  const view = await mount(panel, { host })
  await view.type({ label: 'HTTP Proxy URL (optional)' }, 'http://10.0.0.1:8080', { replace: true })

  await view.press({ text: 'Pause Polling' })
  assert.ok(view.find({ text: /worker exploded/ }))
  // busy must be released so controls stay usable after the failure
  failToggle = false
  await view.press({ text: 'Refresh' })
  assert.equal(view.valueOf(view.find({ label: 'HTTP Proxy URL (optional)' })!), 'http://10.0.0.1:8080')
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

test('debug logging switch asks the worker to turn debug logging on', async () => {
  let current = makeState()
  let sent: { enabled: boolean } | null = null
  const host = mockHost({
    requests: {
      'bridge.getState': () => current,
      'bridge.setDebugLogging': (input: { enabled: boolean }) => {
        sent = input
        current = makeState({ config: { ...current.config, debugLogging: input.enabled } })
        return current
      }
    }
  })
  const view = await mount(panel, { host })
  await view.select({ label: 'Telegram Bridge sections' }, 'logs')
  assert.equal(view.valueOf({ label: 'Debug logging' }), false)

  await view.toggle({ label: 'Debug logging' })
  assert.deepEqual(sent, { enabled: true })
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
  const state = makeState({ config: { ...makeState().config, allowedUserIds, syncOrcaOutbound } })
  const host = mockHost({ requests: { 'bridge.getState': () => state } })
  const view = await mount(panel, { host })
  await view.select({ label: 'Telegram Bridge sections' }, 'setup')
  return view
}

// A Callout's title is a prop, not part of the text the finders match.
function openWarning(view: TestPanel) {
  return view.findAll({ type: 'Callout' }).find((c) => c.props.title === 'Open to everyone') ?? null
}

test('an empty allowlist shows the open to everyone warning naming the bot', async () => {
  const view = await mountWithAllowed('')
  assert.ok(openWarning(view))
  assert.ok(view.find({ text: /Anyone who finds @demo_orca_bot on Telegram/ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a list with only a negative group ID hides the open warning', async () => {
  const view = await mountWithAllowed('-1001234567890')
  assert.equal(openWarning(view), null)
  await view.unmount()
})

test('an allowlist with no valid ID still counts as open', async () => {
  const view = await mountWithAllowed('abc, ,')
  assert.ok(openWarning(view))
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
