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
  const host = mockHost({
    requests: {
      'bridge.getState': () => currentState,
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

  await view.press({ text: 'Test Connection' })
  assert.ok(view.find({ text: /Connected to @demo_orca_bot/ }))

  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})
