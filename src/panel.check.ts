import { defineCheck } from 'orca/testing'

export default defineCheck({
  needsToken: {
    settings: {
      enabled: true,
      defaultBot: '',
      allowedUserIds: '',
      proxyUrl: '',
      replyTimeoutSec: 300,
      syncOrcaOutbound: false,
      debugLogging: false,
      replyLanguage: 'en'
    }
  },
  configuredPaused: {
    secrets: {
      botToken: '123456:CHECK_TOKEN'
    },
    settings: {
      enabled: false,
      defaultBot: 'Assistant',
      allowedUserIds: '123456789',
      proxyUrl: 'http://127.0.0.1:7890',
      replyTimeoutSec: 300,
      syncOrcaOutbound: true,
      debugLogging: true,
      replyLanguage: 'pt-BR'
    },
    storage: {
      'tg.bindings': [
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
          id: 'log-2',
          at: 1795400060000,
          level: 'error',
          scope: 'orca-cli',
          message: 'Failed handling Telegram message in chat 123456789: orca exited with code 1',
          details: 'OrcaCliError: orca exited with code 1\ncommand: orca bot chats --bot Assistant --json\nkind: exit\nexit code: 1\nduration: 412 ms\nstderr: bot not found'
        },
        {
          id: 'log-1',
          at: 1795400000000,
          level: 'info',
          message: 'Telegram polling paused.'
        }
      ]
    }
  }
})
