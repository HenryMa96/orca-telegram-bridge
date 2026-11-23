import { defineCheck } from 'orca/testing'

export default defineCheck({
  needsToken: {
    settings: {
      enabled: true,
      defaultBot: '',
      allowedUserIds: '',
      proxyUrl: '',
      replyTimeoutSec: 300,
      syncOrcaOutbound: false
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
      syncOrcaOutbound: true
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
          id: 'log-1',
          at: 1795400000000,
          level: 'info',
          message: 'Telegram polling paused.'
        }
      ]
    }
  }
})
