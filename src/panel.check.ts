import { defineCheck } from 'orca/testing'
import type { FocusedBot } from './protocol'

// The panel shows the bridges of the bot selected in Orca's sidebar; a check has no sidebar.
const ASSISTANT_SELECTED: FocusedBot = { kind: 'bot', bot: { id: 'bot-1', name: 'Assistant' } }
const FOCUS_UNKNOWN: FocusedBot = { kind: 'unknown', reason: 'This Orca does not name the focused workspace.' }

export default defineCheck({
  // A new install: no bridges, no token, no logs.
  fresh: {},
  // Orca did not say which bot is selected: every bridge, with the bridge filter in Logs.
  focusUnknown: {
    requests: { 'bridge.focusedBot': FOCUS_UNKNOWN }
  },
  twoBridges: {
    requests: { 'bridge.focusedBot': ASSISTANT_SELECTED },
    settings: {
      debugLogging: true
    },
    secrets: {
      'botToken.b1': '123456:CHECK_TOKEN',
      'voiceKey.b1': 'sk-CHECK_VOICE_KEY'
    },
    storage: {
      bridges: [
        {
          id: 'b1',
          name: 'CI',
          enabled: false,
          orcaBot: 'Assistant',
          allowedUserIds: '123456789, -1001234567890',
          proxyUrl: 'http://127.0.0.1:7890',
          replyTimeoutSec: 300,
          syncOrcaOutbound: true,
          replyLanguage: 'pt-BR',
          allowGroups: true,
          voiceEnabled: true,
          voiceProvider: 'openai',
          voiceModel: '',
          groupMode: 'all'
        },
        {
          id: 'b2',
          name: 'Dev',
          enabled: false,
          orcaBot: '',
          allowedUserIds: '',
          proxyUrl: '',
          replyTimeoutSec: 300,
          syncOrcaOutbound: false,
          replyLanguage: 'en',
          allowGroups: false,
          voiceEnabled: false,
          voiceProvider: 'openrouter',
          voiceModel: '',
          groupMode: 'addressed'
        }
      ],
      'tg.b1.bindings': [
        {
          tgChatId: '123456789',
          botId: 'bot-1',
          botName: 'Assistant',
          orcaChatId: 'chat-demo-1',
          updatedAt: 1795400000000
        }
      ],
      'tg.logs': [
        {
          id: 'log-3',
          at: 1795400090000,
          level: 'info',
          scope: 'config',
          message: 'Migrated the single bridge setup into Bridge 1.'
        },
        {
          id: 'log-2',
          at: 1795400060000,
          level: 'error',
          scope: 'orca-cli',
          bridgeId: 'b1',
          message: 'Failed handling Telegram message in chat 123456789: orca exited with code 1',
          details: 'OrcaCliError: orca exited with code 1\ncommand: orca bot chats --bot Assistant --json\nkind: exit\nexit code: 1\nduration: 412 ms\nstderr: bot not found'
        },
        {
          id: 'log-1',
          at: 1795400000000,
          level: 'info',
          bridgeId: 'b2',
          message: 'Telegram polling paused.'
        }
      ]
    }
  }
})
