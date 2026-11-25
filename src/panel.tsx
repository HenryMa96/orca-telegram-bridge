import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  Code,
  CodeView,
  Collapsible,
  EmptyState,
  files,
  Heading,
  host,
  Input,
  List,
  ListItem,
  plugin,
  read,
  RelativeTime,
  Row,
  Select,
  set,
  Spinner,
  Stack,
  Switch,
  Tab,
  Tabs,
  Text,
  type Atom,
  type IconName,
  type PanelContext
} from 'orca'
import type {
  BridgeConnectionStatus,
  BridgeLogEntry,
  BridgeState,
  SaveConfigInput
} from './protocol'
import type { ReplyLanguage } from './i18n'

type LogFilter = 'all' | 'errors' | 'warnings' | 'debug'

const bridgeState = atom<BridgeState | null>(null)
const activeTab = atom<'setup' | 'bindings' | 'logs'>('setup', 'setup', { persist: 'plugin' })
const logFilter = atom<LogFilter>('logFilter', 'all', { persist: 'plugin' })

const tokenDraft = atom('')
const defaultBotDraft = atom('')
const allowedIdsDraft = atom('')
const proxyUrlDraft = atom('')
const timeoutDraft = atom('300')
const syncOrcaOutboundDraft = atom(false)
const replyLanguageDraft = atom<ReplyLanguage>('en')
const busy = atom(false)
const feedback = atom<{ tone: 'success' | 'danger' | 'accent'; text: string } | null>(null)
const formHydrated = atom(false)
// Set by any form edit; worker refreshes must not overwrite unsaved drafts.
const formDirty = atom(false)

// Select option values must be non-empty; '' (auto) is stored as this sentinel in the draft.
const AUTO_BOT = '__auto__'
const MAX_LABEL = 500

const LOG_FILTERS: Array<{ value: LogFilter; label: string }> = [
  { value: 'all', label: 'All levels' },
  { value: 'errors', label: 'Errors' },
  { value: 'warnings', label: 'Warnings and errors' },
  { value: 'debug', label: 'Debug only' }
]
const REPLY_LANGUAGE_OPTIONS: Array<{ value: ReplyLanguage; label: string }> = [
  { value: 'en', label: 'English' },
  { value: 'pt-BR', label: 'Português (Brasil)' },
  { value: 'zh-CN', label: '中文' }
]
const EXPORT_UNAVAILABLE = 'Export needs the Orca desktop app'

function clip(text: string): string {
  return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL)}…` : text
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function edit<T>(draft: Atom<T>, value: T): void {
  set(draft, value)
  set(formDirty, true)
}

function hydrateForm(state: BridgeState, force = false): void {
  if (!force && read(formHydrated)) return
  set(defaultBotDraft, state.config.defaultBot || AUTO_BOT)
  set(allowedIdsDraft, state.config.allowedUserIds)
  set(proxyUrlDraft, state.config.proxyUrl)
  set(timeoutDraft, String(state.config.replyTimeoutSec))
  set(syncOrcaOutboundDraft, state.config.syncOrcaOutbound)
  set(replyLanguageDraft, state.config.replyLanguage)
  set(formHydrated, true)
  set(formDirty, false)
}

function statusMeta(status: BridgeConnectionStatus): {
  label: string
  tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
} {
  switch (status) {
    case 'connected':
      return { label: 'Connected', tone: 'success' }
    case 'connecting':
      return { label: 'Connecting', tone: 'accent' }
    case 'needs_token':
      return { label: 'Needs Token', tone: 'warning' }
    case 'error':
      return { label: 'Error', tone: 'danger' }
    case 'stopped':
      return { label: 'Paused', tone: 'neutral' }
  }
}

async function refresh(): Promise<void> {
  try {
    const next = await plugin.request('bridge.getState')
    set(bridgeState, next)
    hydrateForm(next, !read(formDirty))
  } catch (err) {
    set(feedback, { tone: 'danger', text: errorText(err) })
  }
}

async function saveConfig(): Promise<void> {
  set(busy, true)
  set(feedback, null)
  try {
    const parsedTimeout = Number.parseInt(read(timeoutDraft), 10)
    const cleanToken = read(tokenDraft).trim()
    const payload: SaveConfigInput = {
      defaultBot: read(defaultBotDraft) === AUTO_BOT ? '' : read(defaultBotDraft).trim(),
      allowedUserIds: read(allowedIdsDraft).trim(),
      proxyUrl: read(proxyUrlDraft).trim(),
      replyTimeoutSec: Number.isFinite(parsedTimeout) ? parsedTimeout : 300,
      syncOrcaOutbound: read(syncOrcaOutboundDraft),
      replyLanguage: read(replyLanguageDraft),
      ...(cleanToken ? { botToken: cleanToken } : {})
    }
    const next = await plugin.request('bridge.saveConfig', payload)
    set(tokenDraft, '')
    set(bridgeState, next)
    hydrateForm(next, true)
    set(feedback, { tone: 'success', text: 'Settings saved.' })
  } catch (err) {
    set(feedback, {
      tone: 'danger',
      text: errorText(err)
    })
  } finally {
    set(busy, false)
  }
}

async function testConnection(): Promise<void> {
  set(busy, true)
  set(feedback, null)
  try {
    const res = await plugin.request('bridge.testConnection')
    set(bridgeState, res.state)
    if (res.ok) {
      set(feedback, {
        tone: 'success',
        text: `Connected to @${res.username || res.botId}`
      })
    } else {
      set(feedback, { tone: 'danger', text: res.error || 'Connection failed' })
    }
  } catch (err) {
    set(feedback, {
      tone: 'danger',
      text: err instanceof Error ? err.message : String(err)
    })
  } finally {
    set(busy, false)
  }
}

async function setEnabled(enabled: boolean): Promise<void> {
  set(busy, true)
  set(feedback, null)
  try {
    const next = await plugin.request('bridge.setEnabled', { enabled })
    set(bridgeState, next)
    hydrateForm(next, !read(formDirty))
  } catch (err) {
    set(feedback, { tone: 'danger', text: errorText(err) })
  } finally {
    set(busy, false)
  }
}

async function allowBlockedUser(userId: string): Promise<void> {
  set(busy, true)
  try {
    const next = await plugin.request('bridge.allowUserId', { userId })
    set(bridgeState, next)
    if (read(formDirty)) set(allowedIdsDraft, next.config.allowedUserIds)
    else hydrateForm(next, true)
    set(feedback, { tone: 'success', text: `Allowed Telegram ID ${userId}` })
  } catch (err) {
    set(feedback, { tone: 'danger', text: errorText(err) })
  } finally {
    set(busy, false)
  }
}

async function resetBinding(tgChatId: string): Promise<void> {
  try {
    const next = await plugin.request('bridge.resetBinding', { tgChatId })
    set(bridgeState, next)
  } catch (err) {
    set(feedback, { tone: 'danger', text: errorText(err) })
  }
}

async function clearLogs(): Promise<void> {
  try {
    const next = await plugin.request('bridge.clearLogs')
    set(bridgeState, next)
  } catch (err) {
    set(feedback, { tone: 'danger', text: errorText(err) })
  }
}

async function setDebugLogging(enabled: boolean): Promise<void> {
  try {
    const next = await plugin.request('bridge.setDebugLogging', { enabled })
    set(bridgeState, next)
  } catch (err) {
    set(feedback, { tone: 'danger', text: errorText(err) })
  }
}

// files.saveAs is desktop-only and needs the Export press's gesture, so nothing else is awaited
// between the worker's answer and the save dialog.
async function exportLogs(): Promise<void> {
  if (!host.has('files.saveAs')) {
    set(feedback, { tone: 'danger', text: EXPORT_UNAVAILABLE })
    return
  }
  try {
    const { fileName, text } = await plugin.request('bridge.exportLogs')
    const res = await files.saveAs({ suggestedName: fileName, mimeType: 'text/plain', data: text })
    if (res.status === 'saved') set(feedback, { tone: 'success', text: 'Logs exported.' })
  } catch (err) {
    set(feedback, { tone: 'danger', text: errorText(err) })
  }
}

function matchesFilter(entry: BridgeLogEntry, filter: LogFilter): boolean {
  switch (filter) {
    case 'errors':
      return entry.level === 'error'
    case 'warnings':
      return entry.level === 'error' || entry.level === 'warn'
    case 'debug':
      return entry.level === 'debug'
    case 'all':
      return true
  }
}

function levelIcon(level: BridgeLogEntry['level']): IconName {
  switch (level) {
    case 'error':
      return 'error'
    case 'warn':
      return 'warning'
    case 'debug':
      return 'bug'
    case 'info':
      return 'info'
  }
}

// Entries stored by 0.2.0 have no scope; they all came from the bridge itself.
function logMeta(entry: BridgeLogEntry): string {
  return `${entry.level.toUpperCase()} · ${entry.scope ?? 'bridge'}`
}

function formatTime(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// A List takes only ListItems, so runs of plain entries share a List and each entry with
// details becomes its own Collapsible, keeping newest-first order.
type LogBlock = BridgeLogEntry[] | { entry: BridgeLogEntry; details: string }

function logBlocks(entries: BridgeLogEntry[]): LogBlock[] {
  const blocks: LogBlock[] = []
  for (const entry of entries) {
    const last = blocks[blocks.length - 1]
    if (entry.details) blocks.push({ entry, details: entry.details })
    else if (Array.isArray(last)) last.push(entry)
    else blocks.push([entry])
  }
  return blocks
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('bridge.stateChanged', (next) => {
      set(bridgeState, next)
      hydrateForm(next, false)
    })
  )
  void refresh()
}

function hasAllowedIds(raw: string): boolean {
  return raw.split(/[\s,;]+/).some((id) => /^-?\d+$/.test(id))
}

export default function Panel() {
  const state = read(bridgeState)
  const tab = read(activeTab)
  const isBusy = read(busy)
  const notice = read(feedback)
  const filter = read(logFilter)

  if (!state) {
    if (notice) {
      return (
        <Callout tone="danger" title="Telegram Bridge failed to load">
          <Text size="xs">{notice.text}</Text>
        </Callout>
      )
    }
    return (
      <Stack gap="md">
        <Row gap="sm" align="center">
          <Spinner label="Loading Telegram Bridge" />
          <Text muted>Loading Telegram Bridge...</Text>
        </Row>
      </Stack>
    )
  }

  const badge = statusMeta(state.status)
  const shownLogs = state.logs.filter((entry) => matchesFilter(entry, filter))
  const canExport = host.has('files.saveAs')
  const botOptions = [
    { value: AUTO_BOT, label: '(Auto-select first Orca bot)' },
    ...state.bots
      .filter((b) => b.name)
      .map((b) => ({
        value: b.name,
        label: clip(b.specialty ? `${b.name} — ${b.specialty}` : b.name)
      }))
  ]
  const draftBot = read(defaultBotDraft)
  if (draftBot !== AUTO_BOT && !botOptions.some((o) => o.value === draftBot)) {
    botOptions.push({ value: draftBot, label: clip(draftBot) })
  }

  const targetDisplay = state.config.defaultBot || 'auto'
  const openToEveryone = !hasAllowedIds(state.config.allowedUserIds)

  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Stack gap="xs">
          <Heading level={2}>Telegram Bridge</Heading>
          <Text muted size="xs">
            {state.botUsername
              ? `@${state.botUsername} -> ${targetDisplay}`
              : `Default target: ${targetDisplay}`}
          </Text>
        </Stack>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </Row>

      {state.lastError && (
        <Callout tone="danger" title="Connection Error" icon="error">
          <Text size="xs">{state.lastError}</Text>
        </Callout>
      )}

      {state.lastBlockedUserId && (
        <Callout tone="warning" title="Unauthorized Telegram User" icon="warning">
          <Stack gap="xs">
            <Text size="xs">
              User <Code>{state.lastBlockedUserId}</Code> messaged your bot but is not in the
              allowlist.
            </Text>
            <Button
              size="xs"
              variant="outline"
              disabled={isBusy}
              onPress={() => void allowBlockedUser(state.lastBlockedUserId!)}
            >
              Allow {state.lastBlockedUserId}
            </Button>
          </Stack>
        </Callout>
      )}

      {notice && (
        <Callout tone={notice.tone} title={clip(notice.text)} />
      )}

      <Row gap="xs" wrap>
        <Button
          size="sm"
          variant="outline"
          disabled={isBusy || !state.config.hasToken}
          onPress={testConnection}
        >
          Test Connection
        </Button>
        <Button size="sm" variant="ghost" disabled={isBusy} onPress={refresh}>
          Refresh
        </Button>
      </Row>

      <Tabs
        label="Telegram Bridge sections"
        value={tab}
        onChange={(v) => set(activeTab, v as 'setup' | 'bindings' | 'logs')}
      >
        <Tab value="setup" label="Setup">
          <Stack gap="sm">
            <Card title="Bot" description="Turns the Telegram bot on or off right away.">
              <Stack gap="xs">
                <Row justify="between" align="center">
                  <Switch
                    label="Bot active"
                    checked={state.config.enabled}
                    disabled={isBusy || !state.config.hasToken}
                    onChange={(v) => void setEnabled(v)}
                  />
                  <Badge tone={badge.tone}>{badge.label}</Badge>
                </Row>
                {!state.config.hasToken && (
                  <Text muted size="xs">
                    Save a bot token first.
                  </Text>
                )}
              </Stack>
            </Card>
            {openToEveryone && (
              <Callout tone="warning" title="Open to everyone" icon="warning">
                <Text size="xs">
                  {`Anyone who finds ${state.botUsername ? `@${state.botUsername}` : 'your bot'} on Telegram can chat with your Orca bots and use their commands with your rights. Add Telegram IDs to restrict access.`}
                </Text>
              </Callout>
            )}
            <Card
              title="Bot Credentials & Routing"
              description={
                state.config.hasToken
                  ? 'Bot token is stored encrypted in OS keyring. Leave blank to keep existing token.'
                  : 'Paste your BotFather token to enable polling.'
              }
            >
              <Stack gap="sm">
                <Input
                  label="Telegram Bot Token"
                  type="password"
                  value={read(tokenDraft)}
                  placeholder={state.config.hasToken ? '•••••••••••••••• (saved)' : '123456:ABC...'}
                  onChange={(v) => edit(tokenDraft, v)}
                />
                <Select
                  label="Default Orca Bot"
                  value={read(defaultBotDraft)}
                  options={botOptions}
                  onChange={(v) => edit(defaultBotDraft, v)}
                />
                <Input
                  label="Allowed Telegram IDs (empty = everyone)"
                  value={read(allowedIdsDraft)}
                  placeholder="Empty = open to everyone. Or user/group IDs, e.g. 123456789, -1001234567890"
                  onChange={(v) => edit(allowedIdsDraft, v)}
                />
                <Input
                  label="HTTP Proxy URL (optional)"
                  value={read(proxyUrlDraft)}
                  placeholder="http://127.0.0.1:7890"
                  onChange={(v) => edit(proxyUrlDraft, v)}
                />
                <Input
                  label="Reply Timeout (seconds)"
                  value={read(timeoutDraft)}
                  placeholder="300"
                  onChange={(v) => edit(timeoutDraft, v)}
                />
                <Select
                  label="Telegram reply language"
                  value={read(replyLanguageDraft)}
                  options={REPLY_LANGUAGE_OPTIONS}
                  onChange={(v) => edit(replyLanguageDraft, v as ReplyLanguage)}
                />
                <Switch
                  label="Sync Orca-side messages to Telegram"
                  checked={read(syncOrcaOutboundDraft)}
                  onChange={(v) => edit(syncOrcaOutboundDraft, v)}
                />
                {openToEveryone && state.config.syncOrcaOutbound && (
                  <Text muted size="xs">
                    Sync is paused while the bot is open to everyone. Add Telegram IDs to use it.
                  </Text>
                )}
                <Row gap="xs">
                  <Button size="sm" disabled={isBusy} onPress={saveConfig}>
                    Save Settings
                  </Button>
                </Row>
              </Stack>
            </Card>
          </Stack>
        </Tab>

        <Tab value="bindings" label={`Chats (${state.bindings.length})`}>
          {state.bindings.length === 0 ? (
            <EmptyState
              icon="bot"
              title="No active Telegram chats yet"
              description="Send a message to your Telegram bot after configuring your allowlist."
            />
          ) : (
            <List label="Telegram chat bindings">
              {state.bindings.map((b) => (
                <ListItem
                  key={b.tgChatId}
                  icon="bot"
                  title={clip(`TG ${b.tgChatId} -> ${b.botName}`)}
                  description={b.orcaChatId ? `Orca chat: ${b.orcaChatId}` : 'Next message opens new chat'}
                >
                  <Row gap="xs" align="center">
                    <RelativeTime at={b.updatedAt} muted />
                    <Button
                      size="xs"
                      variant="ghost"
                      onPress={() => void resetBinding(b.tgChatId)}
                    >
                      Reset
                    </Button>
                  </Row>
                </ListItem>
              ))}
            </List>
          )}
        </Tab>

        <Tab value="logs" label={`Logs (${state.logTotal})`}>
          <Stack gap="xs">
            <Row gap="sm" align="end" justify="between" wrap>
              <Switch
                label="Debug logging"
                checked={state.config.debugLogging}
                onChange={(v) => void setDebugLogging(v)}
              />
              <Select
                label="Log level filter"
                value={filter}
                options={LOG_FILTERS}
                onChange={(v) => set(logFilter, v as LogFilter)}
              />
            </Row>
            <Row gap="xs" justify="end">
              {state.logs.length > 0 && (
                <Button size="xs" variant="ghost" onPress={clearLogs}>
                  Clear Logs
                </Button>
              )}
              <Button
                size="xs"
                variant="outline"
                icon="download"
                disabled={!canExport}
                tooltip={canExport ? undefined : EXPORT_UNAVAILABLE}
                onPress={exportLogs}
              >
                Export logs
              </Button>
            </Row>
            {state.logs.length === 0 ? (
              <EmptyState
                icon="info"
                title="No activity logs yet"
                description="Incoming Telegram messages and bridge events appear here."
              />
            ) : (
              <Stack gap="xs">
                <Text muted size="xs">
                  {`Showing ${shownLogs.length} of ${state.logTotal} entries`}
                </Text>
                {shownLogs.length === 0 ? (
                  <EmptyState
                    icon="filter"
                    title="No entries match this filter"
                    description={
                      filter === 'debug' && !state.config.debugLogging
                        ? 'Turn on Debug logging to record debug entries.'
                        : 'Pick another level to see more entries.'
                    }
                  />
                ) : (
                  logBlocks(shownLogs).map((block) =>
                    Array.isArray(block) ? (
                      <List key={`list-${block[0].id}`} label="Bridge activity logs">
                        {block.map((entry) => (
                          <ListItem
                            key={entry.id}
                            icon={levelIcon(entry.level)}
                            title={clip(entry.message)}
                            description={logMeta(entry)}
                          >
                            <RelativeTime at={entry.at} muted />
                          </ListItem>
                        ))}
                      </List>
                    ) : (
                      <Collapsible
                        key={`log-${block.entry.id}`}
                        title={clip(block.entry.message)}
                        description={`${logMeta(block.entry)} · ${formatTime(block.entry.at)}`}
                      >
                        <CodeView code={block.details} label="Log details" wrap maxHeight="sm" />
                      </Collapsible>
                    )
                  )
                )}
              </Stack>
            )}
          </Stack>
        </Tab>
      </Tabs>
    </Stack>
  )
}
