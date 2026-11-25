// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
import type { ReplyLanguage } from './i18n'

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
  // The bridge the entry belongs to; absent for plugin-wide entries and entries from before 0.5.0.
  bridgeId?: string
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

// One bridge: one Telegram bot token and the one Orca bot it talks to. Everything here is per bridge.
export type BridgeConfig = {
  id: string
  name: string
  hasToken: boolean
  enabled: boolean
  // The Orca bot this Telegram bot is pinned to ('' = the first Orca bot found).
  orcaBot: string
  allowedUserIds: string
  proxyUrl: string
  replyTimeoutSec: number
  syncOrcaOutbound: boolean
  replyLanguage: ReplyLanguage
}

export type BridgeView = {
  id: string
  name: string
  status: BridgeConnectionStatus
  polling: boolean
  botUsername: string | null
  botDisplayName: string | null
  lastError: string | null
  lastBlockedUserId: string | null
  lastPollAt: number | null
  config: BridgeConfig
  bindings: ChatBinding[]
}

export type GlobalConfig = {
  debugLogging: boolean
}

export type BridgeState = {
  // In creation order.
  bridges: BridgeView[]
  // The Orca bots on this computer; shared by every bridge.
  bots: BotSummary[]
  global: GlobalConfig
  // The newest 40 stored entries of every bridge, newest first; logTotal counts every stored entry.
  logs: BridgeLogEntry[]
  logTotal: number
}

export type SaveConfigInput = {
  bridgeId: string
  name: string
  botToken?: string
  clearToken?: boolean
  // Absent keeps the current state; the panel switches a bridge with `bridge.setEnabled`.
  enabled?: boolean
  orcaBot: string
  allowedUserIds: string
  proxyUrl: string
  replyTimeoutSec: number
  syncOrcaOutbound: boolean
  replyLanguage?: ReplyLanguage
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
    // A new bridge starts without a token and switched off.
    'bridge.add': { input: { name?: string }; output: { bridgeId: string; state: BridgeState } }
    'bridge.remove': { input: { bridgeId: string }; output: BridgeState }
    'bridge.saveConfig': { input: SaveConfigInput; output: BridgeState }
    'bridge.testConnection': { input: { bridgeId: string }; output: TestConnectionResult }
    'bridge.setEnabled': { input: { bridgeId: string; enabled: boolean }; output: BridgeState }
    'bridge.allowUserId': { input: { bridgeId: string; userId: string }; output: BridgeState }
    'bridge.resetBinding': { input: { bridgeId: string; tgChatId: string }; output: BridgeState }
    'bridge.clearLogs': { output: BridgeState }
    'bridge.setDebugLogging': { input: { enabled: boolean }; output: BridgeState }
    'bridge.exportLogs': { output: ExportLogsResult }
  }
  interface PluginPanelEvents {
    'bridge.stateChanged': BridgeState
  }
}
