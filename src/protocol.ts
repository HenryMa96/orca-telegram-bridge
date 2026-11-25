// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
export {}

export type BridgeConnectionStatus =
  | 'needs_token'
  | 'stopped'
  | 'connecting'
  | 'connected'
  | 'error'

export type ChatBinding = {
  tgChatId: string
  // Telegram user who last used this binding; outbound sync stops once they leave the allowlist.
  ownerUserId?: string
  botId?: string
  botName: string
  orcaChatId: string | null
  title?: string
  updatedAt: number
}

export type BridgeLogEntry = {
  id: string
  at: number
  level: 'info' | 'warn' | 'error'
  message: string
}

export type BotSummary = {
  id: string
  name: string
  specialty: string
  agent: string
}

export type BridgeConfig = {
  hasToken: boolean
  enabled: boolean
  defaultBot: string
  allowedUserIds: string
  proxyUrl: string
  replyTimeoutSec: number
  syncOrcaOutbound: boolean
}

export type BridgeState = {
  status: BridgeConnectionStatus
  polling: boolean
  botUsername: string | null
  botDisplayName: string | null
  lastError: string | null
  lastBlockedUserId: string | null
  lastPollAt: number | null
  config: BridgeConfig
  bots: BotSummary[]
  bindings: ChatBinding[]
  logs: BridgeLogEntry[]
}

export type SaveConfigInput = {
  botToken?: string
  clearToken?: boolean
  enabled: boolean
  defaultBot: string
  allowedUserIds: string
  proxyUrl: string
  replyTimeoutSec: number
  syncOrcaOutbound: boolean
}

export type TestConnectionResult = {
  ok: boolean
  username?: string
  botId?: number
  error?: string
  state: BridgeState
}

declare module 'orca' {
  interface PluginRequests {
    'bridge.getState': { output: BridgeState }
    'bridge.saveConfig': { input: SaveConfigInput; output: BridgeState }
    'bridge.testConnection': { output: TestConnectionResult }
    'bridge.togglePolling': { output: BridgeState }
    'bridge.allowUserId': { input: { userId: string }; output: BridgeState }
    'bridge.resetBinding': { input: { tgChatId: string }; output: BridgeState }
    'bridge.clearLogs': { output: BridgeState }
  }
  interface PluginPanelEvents {
    'bridge.stateChanged': BridgeState
  }
}
