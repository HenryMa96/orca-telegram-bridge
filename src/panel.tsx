import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  Code,
  EmptyState,
  Heading,
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
  type PanelContext
} from 'orca'
import type { BridgeConnectionStatus, BridgeState, SaveConfigInput } from './protocol'

const bridgeState = atom<BridgeState | null>(null)
const activeTab = atom<'setup' | 'bindings' | 'logs'>('setup', 'setup', { persist: 'plugin' })

const tokenDraft = atom('')
const enabledDraft = atom(true)
const defaultBotDraft = atom('')
const allowedIdsDraft = atom('')
const proxyUrlDraft = atom('')
const timeoutDraft = atom('300')
const syncOrcaOutboundDraft = atom(false)
const busy = atom(false)
const feedback = atom<{ tone: 'success' | 'danger' | 'accent'; text: string } | null>(null)
const formHydrated = atom(false)
// Set by any form edit; worker refreshes must not overwrite unsaved drafts.
const formDirty = atom(false)

// Select option values must be non-empty; '' (auto) is stored as this sentinel in the draft.
const AUTO_BOT = '__auto__'
const MAX_LABEL = 500

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
  set(enabledDraft, state.config.enabled)
  set(defaultBotDraft, state.config.defaultBot || AUTO_BOT)
  set(allowedIdsDraft, state.config.allowedUserIds)
  set(proxyUrlDraft, state.config.proxyUrl)
  set(timeoutDraft, String(state.config.replyTimeoutSec))
  set(syncOrcaOutboundDraft, state.config.syncOrcaOutbound)
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
      enabled: read(enabledDraft),
      defaultBot: read(defaultBotDraft) === AUTO_BOT ? '' : read(defaultBotDraft).trim(),
      allowedUserIds: read(allowedIdsDraft).trim(),
      proxyUrl: read(proxyUrlDraft).trim(),
      replyTimeoutSec: Number.isFinite(parsedTimeout) ? parsedTimeout : 300,
      syncOrcaOutbound: read(syncOrcaOutboundDraft),
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

async function togglePolling(): Promise<void> {
  set(busy, true)
  set(feedback, null)
  try {
    const next = await plugin.request('bridge.togglePolling')
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

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('bridge.stateChanged', (next) => {
      set(bridgeState, next)
      hydrateForm(next, false)
    })
  )
  void refresh()
}

export default function Panel() {
  const state = read(bridgeState)
  const tab = read(activeTab)
  const isBusy = read(busy)
  const notice = read(feedback)

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
          variant={state.polling ? 'outline' : 'solid'}
          disabled={isBusy || !state.config.hasToken}
          onPress={togglePolling}
        >
          {state.polling ? 'Pause Polling' : 'Start Polling'}
        </Button>
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
                  label="Allowed Telegram User IDs"
                  value={read(allowedIdsDraft)}
                  placeholder="Comma-separated numeric IDs, e.g. 123456789"
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
                <Switch
                  label="Enable automatic polling"
                  checked={read(enabledDraft)}
                  onChange={(v) => edit(enabledDraft, v)}
                />
                <Switch
                  label="Sync Orca-side messages to Telegram"
                  checked={read(syncOrcaOutboundDraft)}
                  onChange={(v) => edit(syncOrcaOutboundDraft, v)}
                />
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

        <Tab value="logs" label={`Logs (${state.logs.length})`}>
          <Stack gap="xs">
            {state.logs.length > 0 && (
              <Row justify="end">
                <Button size="xs" variant="ghost" onPress={clearLogs}>
                  Clear Logs
                </Button>
              </Row>
            )}
            {state.logs.length === 0 ? (
              <EmptyState
                icon="info"
                title="No activity logs yet"
                description="Incoming Telegram messages and bridge events appear here."
              />
            ) : (
              <List label="Bridge activity logs">
                {state.logs.slice(0, 25).map((entry) => (
                  <ListItem
                    key={entry.id}
                    icon={entry.level === 'error' ? 'error' : entry.level === 'warn' ? 'warning' : 'info'}
                    title={clip(entry.message)}
                  >
                    <RelativeTime at={entry.at} muted />
                  </ListItem>
                ))}
              </List>
            )}
          </Stack>
        </Tab>
      </Tabs>
    </Stack>
  )
}
