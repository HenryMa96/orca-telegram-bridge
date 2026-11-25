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

export type LogScope = 'bridge' | 'telegram' | 'orca-cli' | 'dispatch' | 'sync' | 'config'

export type BridgeLogEntry = {
  id: string
  at: number
  level: 'debug' | 'info' | 'warn' | 'error'
  // Optional: entries stored by 0.2.0 have none.
  scope?: LogScope
  message: string
  // Multi-line, redacted, at most 3000 chars.
  details?: string
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
  debugLogging: boolean
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
  // The newest 40 stored entries, newest first; logTotal counts every stored entry.
  logs: BridgeLogEntry[]
  logTotal: number
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

export type ExportLogsResult = {
  fileName: string
  text: string
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
    'bridge.setDebugLogging': { input: { enabled: boolean }; output: BridgeState }
    'bridge.exportLogs': { output: ExportLogsResult }
  }
  interface PluginPanelEvents {
    'bridge.stateChanged': BridgeState
  }
}
