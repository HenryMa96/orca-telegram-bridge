import { assert, mockHost, mount, test } from 'orca/testing'
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
      syncOrcaOutbound: false
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
      { id: '1', at: Date.now(), level: 'info', message: 'Connected to Telegram as @demo_orca_bot.' }
    ],
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
