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
  RadioGroup,
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
  BridgeView,
  GroupMode,
  SaveConfigInput,
  VoiceProvider
} from './protocol'
import type { ReplyLanguage } from './i18n'

type LogFilter = 'all' | 'errors' | 'warnings' | 'debug'

// Select option values must be non-empty: these stand for "every bridge" and "no bridge".
const ALL_BRIDGES = 'all'
const PLUGIN_LOGS = '__plugin__'

const bridgeState = atom<BridgeState | null>(null)
const activeTab = atom<'setup' | 'bindings' | 'logs'>('setup', 'setup', { persist: 'plugin' })
const logFilter = atom<LogFilter>('logFilter', 'all', { persist: 'plugin' })
const logBridgeFilter = atom<string>('logBridgeFilter', ALL_BRIDGES, { persist: 'plugin' })

// The bridge whose editor is open; one at a time.
const editingBridgeId = atom<string | null>(null)
// The bridge whose Remove was pressed once; a second press on Confirm remove removes it.
const confirmRemoveId = atom<string | null>(null)

const nameDraft = atom('')
const tokenDraft = atom('')
const orcaBotDraft = atom('')
const allowedIdsDraft = atom('')
const proxyUrlDraft = atom('')
const timeoutDraft = atom('300')
const syncOrcaOutboundDraft = atom(false)
const replyLanguageDraft = atom<ReplyLanguage>('en')
const allowGroupsDraft = atom(false)
const groupModeDraft = atom<GroupMode>('addressed')
const voiceEnabledDraft = atom(false)
const voiceProviderDraft = atom<VoiceProvider>('openrouter')
const voiceModelDraft = atom('')
const voiceKeyDraft = atom('')
const busy = atom(false)
const feedback = atom<{ tone: 'success' | 'danger' | 'accent'; text: string } | null>(null)
// The bridge the drafts were filled from.
const hydratedFor = atom<string | null>(null)
// Set by any form edit; worker refreshes must not overwrite unsaved drafts.
const formDirty = atom(false)

// Select option values must be non-empty; '' (auto) is stored as this sentinel in the draft.
const AUTO_BOT = '__auto__'
const MAX_LABEL = 500
const ORCA_BOT_LABEL = 'Orca bot (this Telegram bot talks only to it)'

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
const GROUP_MODE_OPTIONS: Array<{ value: GroupMode; label: string }> = [
  { value: 'addressed', label: 'Only messages for the bot' },
  { value: 'all', label: 'All messages' }
]
const VOICE_PROVIDER_OPTIONS: Array<{ value: VoiceProvider; label: string }> = [
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'openai', label: 'OpenAI' }
]
const VOICE_PROVIDER_LABEL: Record<VoiceProvider, string> = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI'
}
const VOICE_DEFAULT_MODEL: Record<VoiceProvider, string> = {
  openrouter: 'openai/whisper-large-v3',
  openai: 'gpt-transcribe'
}
const VOICE_KEY_PLACEHOLDER: Record<VoiceProvider, string> = {
  openrouter: 'OpenRouter key sk-or-…',
  openai: 'OpenAI key sk-…'
}
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

function findBridge(state: BridgeState, bridgeId: string | null): BridgeView | undefined {
  return bridgeId ? state.bridges.find((b) => b.id === bridgeId) : undefined
}

// Fills the drafts from the bridge being edited. Without `force` it only fills an editor that
// has not been filled yet, so worker pushes never overwrite what the user typed.
function hydrateForm(state: BridgeState, force = false): void {
  const id = read(editingBridgeId)
  const bridge = findBridge(state, id)
  if (!bridge) return
  if (!force && read(hydratedFor) === id) return
  set(nameDraft, bridge.name)
  set(orcaBotDraft, bridge.config.orcaBot || AUTO_BOT)
  set(allowedIdsDraft, bridge.config.allowedUserIds)
  set(proxyUrlDraft, bridge.config.proxyUrl)
  set(timeoutDraft, String(bridge.config.replyTimeoutSec))
  set(syncOrcaOutboundDraft, bridge.config.syncOrcaOutbound)
  set(replyLanguageDraft, bridge.config.replyLanguage)
  set(allowGroupsDraft, bridge.config.allowGroups)
  set(groupModeDraft, bridge.config.groupMode)
  set(voiceEnabledDraft, bridge.config.voiceEnabled)
  set(voiceProviderDraft, bridge.config.voiceProvider)
  set(voiceModelDraft, bridge.config.voiceModel)
  set(hydratedFor, id)
  set(formDirty, false)
}

function openEditor(state: BridgeState, bridgeId: string): void {
  set(editingBridgeId, bridgeId)
  set(confirmRemoveId, null)
  set(tokenDraft, '')
  set(voiceKeyDraft, '')
  hydrateForm(state, true)
}

function closeEditor(): void {
  set(editingBridgeId, null)
  set(hydratedFor, null)
  set(tokenDraft, '')
  set(voiceKeyDraft, '')
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

function telegramHandle(bridge: BridgeView): string {
  if (bridge.botUsername) return `@${bridge.botUsername}`
  return bridge.config.hasToken ? 'Telegram bot not connected yet' : 'No bot token yet'
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

async function addBridge(): Promise<void> {
  set(busy, true)
  set(feedback, null)
  try {
    const res = await plugin.request('bridge.add', {})
    set(bridgeState, res.state)
    openEditor(res.state, res.bridgeId)
  } catch (err) {
    set(feedback, { tone: 'danger', text: errorText(err) })
  } finally {
    set(busy, false)
  }
}

async function removeBridge(bridge: BridgeView): Promise<void> {
  set(busy, true)
  set(feedback, null)
  try {
    const next = await plugin.request('bridge.remove', { bridgeId: bridge.id })
    set(bridgeState, next)
    if (read(editingBridgeId) === bridge.id) closeEditor()
    set(feedback, { tone: 'success', text: `Removed ${bridge.name}.` })
  } catch (err) {
    set(feedback, { tone: 'danger', text: errorText(err) })
  } finally {
    set(confirmRemoveId, null)
    set(busy, false)
  }
}

async function saveConfig(bridge: BridgeView): Promise<void> {
  set(busy, true)
  set(feedback, null)
  try {
    const parsedTimeout = Number.parseInt(read(timeoutDraft), 10)
    const cleanToken = read(tokenDraft).trim()
    const cleanVoiceKey = read(voiceKeyDraft).trim()
    const payload: SaveConfigInput = {
      bridgeId: bridge.id,
      name: read(nameDraft).trim() || bridge.name,
      orcaBot: read(orcaBotDraft) === AUTO_BOT ? '' : read(orcaBotDraft).trim(),
      allowedUserIds: read(allowedIdsDraft).trim(),
      proxyUrl: read(proxyUrlDraft).trim(),
      replyTimeoutSec: Number.isFinite(parsedTimeout) ? parsedTimeout : 300,
      syncOrcaOutbound: read(syncOrcaOutboundDraft),
      replyLanguage: read(replyLanguageDraft),
      allowGroups: read(allowGroupsDraft),
      groupMode: read(groupModeDraft),
      voiceEnabled: read(voiceEnabledDraft),
      voiceProvider: read(voiceProviderDraft),
      voiceModel: read(voiceModelDraft).trim(),
      ...(cleanToken ? { botToken: cleanToken } : {}),
      ...(cleanVoiceKey ? { voiceApiKey: cleanVoiceKey } : {})
    }
    const next = await plugin.request('bridge.saveConfig', payload)
    set(tokenDraft, '')
    set(voiceKeyDraft, '')
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

async function testConnection(bridgeId: string): Promise<void> {
  set(busy, true)
  set(feedback, null)
  try {
    const res = await plugin.request('bridge.testConnection', { bridgeId })
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

async function setEnabled(bridgeId: string, enabled: boolean): Promise<void> {
  set(busy, true)
  set(feedback, null)
  try {
    const next = await plugin.request('bridge.setEnabled', { bridgeId, enabled })
    set(bridgeState, next)
    hydrateForm(next, !read(formDirty))
  } catch (err) {
    set(feedback, { tone: 'danger', text: errorText(err) })
  } finally {
    set(busy, false)
  }
}

async function allowBlockedUser(bridgeId: string, userId: string): Promise<void> {
  set(busy, true)
  try {
    const next = await plugin.request('bridge.allowUserId', { bridgeId, userId })
    set(bridgeState, next)
    if (read(editingBridgeId) === bridgeId) {
      const bridge = findBridge(next, bridgeId)
      if (read(formDirty)) {
        if (bridge) set(allowedIdsDraft, bridge.config.allowedUserIds)
      } else hydrateForm(next, true)
    }
    set(feedback, { tone: 'success', text: `Allowed Telegram ID ${userId}` })
  } catch (err) {
    set(feedback, { tone: 'danger', text: errorText(err) })
  } finally {
    set(busy, false)
  }
}

async function resetBinding(bridgeId: string, tgChatId: string): Promise<void> {
  try {
    const next = await plugin.request('bridge.resetBinding', { bridgeId, tgChatId })
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

// Entries without a bridge id (plugin-wide, or stored before 0.5.0) count as 'Plugin'.
function matchesBridge(entry: BridgeLogEntry, bridgeFilter: string): boolean {
  if (bridgeFilter === ALL_BRIDGES) return true
  if (bridgeFilter === PLUGIN_LOGS) return !entry.bridgeId
  return entry.bridgeId === bridgeFilter
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
function logMeta(entry: BridgeLogEntry, bridgeNames: Map<string, string>): string {
  const base = `${entry.level.toUpperCase()} · ${entry.scope ?? 'bridge'}`
  if (!entry.bridgeId) return base
  return `${base} · ${clip(bridgeNames.get(entry.bridgeId) ?? 'removed bridge')}`
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

function bridgeCard(bridge: BridgeView, isBusy: boolean, confirming: boolean) {
  const badge = statusMeta(bridge.status)
  const openToEveryone = !hasAllowedIds(bridge.config.allowedUserIds)
  const blockedUserId = bridge.lastBlockedUserId
  return (
    <Card
      key={`bridge:${bridge.id}`}
      title={clip(bridge.name)}
      description={clip(`${telegramHandle(bridge)} → ${bridge.config.orcaBot || 'first Orca bot'}`)}
    >
      <Stack gap="xs">
        <Row justify="between" align="center">
          <Switch
            key={`active:${bridge.id}`}
            label="Bot active"
            checked={bridge.config.enabled}
            disabled={isBusy || !bridge.config.hasToken}
            onChange={(v) => void setEnabled(bridge.id, v)}
          />
          <Badge tone={badge.tone}>{badge.label}</Badge>
        </Row>
        {!bridge.config.hasToken && (
          <Text muted size="xs">
            Save a bot token first.
          </Text>
        )}
        <Text muted size="xs">
          {!bridge.config.allowGroups
            ? 'Groups: off'
            : bridge.config.groupMode === 'addressed'
              ? 'Groups: messages for the bot'
              : `Groups: all messages${openToEveryone ? ' (open: messages for the bot)' : ''}`}
        </Text>
        <Text muted size="xs">
          {!bridge.config.voiceEnabled
            ? 'Voice: off'
            : `Voice: ${VOICE_PROVIDER_LABEL[bridge.config.voiceProvider]} (${bridge.config.voiceModel || 'default'})${bridge.config.hasVoiceKey ? '' : ' – no API key'}`}
        </Text>
        {bridge.lastError && (
          <Callout tone="danger" title="Connection Error" icon="error">
            <Text size="xs">{clip(bridge.lastError)}</Text>
          </Callout>
        )}
        {blockedUserId && (
          <Callout tone="warning" title="Unauthorized Telegram User" icon="warning">
            <Stack gap="xs">
              <Text size="xs">
                User <Code>{blockedUserId}</Code> messaged this bot but is not in the allowlist.
              </Text>
              <Button
                key={`allow:${bridge.id}`}
                size="xs"
                variant="outline"
                disabled={isBusy}
                onPress={() => void allowBlockedUser(bridge.id, blockedUserId)}
              >
                Allow {blockedUserId}
              </Button>
            </Stack>
          </Callout>
        )}
        {openToEveryone && (
          <Callout tone="warning" title="Open to everyone" icon="warning">
            <Text size="xs">
              {clip(
                `Anyone who finds ${bridge.botUsername ? `@${bridge.botUsername}` : 'this bot'} on Telegram can chat with ${bridge.config.orcaBot || 'your first Orca bot'} and use its commands with your rights. Add Telegram IDs to restrict access.`
              )}
            </Text>
          </Callout>
        )}
        {confirming && (
          <Text tone="danger" size="xs">
            Removing stops this bot and deletes its token, chats and settings.
          </Text>
        )}
        <Row gap="xs">
          <Button
            key={`edit:${bridge.id}`}
            size="xs"
            variant="outline"
            icon="edit"
            disabled={isBusy}
            onPress={() => {
              const state = read(bridgeState)
              if (state) openEditor(state, bridge.id)
            }}
          >
            Edit
          </Button>
          {confirming ? (
            <Button
              key={`confirm-remove:${bridge.id}`}
              size="xs"
              tone="danger"
              disabled={isBusy}
              onPress={() => void removeBridge(bridge)}
            >
              Confirm remove
            </Button>
          ) : (
            <Button
              key={`remove:${bridge.id}`}
              size="xs"
              variant="ghost"
              tone="danger"
              disabled={isBusy}
              onPress={() => set(confirmRemoveId, bridge.id)}
            >
              Remove
            </Button>
          )}
          {confirming && (
            <Button
              key={`keep:${bridge.id}`}
              size="xs"
              variant="ghost"
              disabled={isBusy}
              onPress={() => set(confirmRemoveId, null)}
            >
              Keep
            </Button>
          )}
        </Row>
      </Stack>
    </Card>
  )
}

function bridgeEditor(bridge: BridgeView, state: BridgeState, isBusy: boolean) {
  const botOptions = [
    { value: AUTO_BOT, label: '(Auto-select first Orca bot)' },
    ...state.bots
      .filter((b) => b.name)
      .map((b) => ({
        value: b.name,
        label: clip(b.specialty ? `${b.name} — ${b.specialty}` : b.name)
      }))
  ]
  const draftBot = read(orcaBotDraft)
  if (draftBot !== AUTO_BOT && !botOptions.some((o) => o.value === draftBot)) {
    botOptions.push({ value: draftBot, label: clip(draftBot) })
  }
  const openToEveryone = !hasAllowedIds(bridge.config.allowedUserIds)
  const voiceProvider = read(voiceProviderDraft)

  return (
    <Card
      key={`editor:${bridge.id}`}
      title={clip(`Edit ${bridge.name}`)}
      description={
        bridge.config.hasToken
          ? 'Bot token is stored encrypted in OS keyring. Leave blank to keep existing token.'
          : 'Paste your BotFather token to enable polling.'
      }
    >
      <Stack gap="sm">
        <Input label="Name" value={read(nameDraft)} onChange={(v) => edit(nameDraft, v)} />
        <Input
          label="Telegram Bot Token"
          type="password"
          value={read(tokenDraft)}
          placeholder={bridge.config.hasToken ? '•••••••••••••••• (saved)' : '123456:ABC...'}
          onChange={(v) => edit(tokenDraft, v)}
        />
        <Select
          label={ORCA_BOT_LABEL}
          value={draftBot}
          options={botOptions}
          onChange={(v) => edit(orcaBotDraft, v)}
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
        {openToEveryone && bridge.config.syncOrcaOutbound && (
          <Text muted size="xs">
            Sync is paused while the bot is open to everyone. Add Telegram IDs to use it.
          </Text>
        )}
        <Switch
          label="Allow groups"
          checked={read(allowGroupsDraft)}
          onChange={(v) => edit(allowGroupsDraft, v)}
        />
        {read(allowGroupsDraft) && (
          <RadioGroup
            label="In groups, read"
            value={read(groupModeDraft)}
            options={GROUP_MODE_OPTIONS}
            onChange={(v) => edit(groupModeDraft, v as GroupMode)}
          />
        )}
        {bridge.config.allowGroups && bridge.config.groupMode === 'all' && openToEveryone && (
          <Text muted size="xs">
            All messages works only with Allowed Telegram IDs. While the bot is open to everyone it
            reads only messages for it.
          </Text>
        )}
        {bridge.config.allowGroups && bridge.telegramCaps?.canJoinGroups === false && (
          <Callout
            tone="warning"
            icon="warning"
            title="Telegram does not let this bot join groups. In @BotFather: /setjoingroups -> Enable."
          />
        )}
        {bridge.config.allowGroups && bridge.telegramCaps?.canReadAllGroupMessages === false && (
          <Text muted size="xs">
            {'Privacy mode is on: in groups the bot receives only commands and replies to its messages; @mentions and All messages need /setprivacy -> Disable in @BotFather, then add the bot to the group again.'}
          </Text>
        )}
        <Switch
          label="Voice messages"
          checked={read(voiceEnabledDraft)}
          onChange={(v) => edit(voiceEnabledDraft, v)}
        />
        {read(voiceEnabledDraft) && (
          <Stack gap="sm">
            <Select
              label="Transcription provider"
              value={voiceProvider}
              options={VOICE_PROVIDER_OPTIONS}
              onChange={(v) => edit(voiceProviderDraft, v as VoiceProvider)}
            />
            <Input
              label="Transcription model"
              value={read(voiceModelDraft)}
              placeholder={VOICE_DEFAULT_MODEL[voiceProvider]}
              onChange={(v) => edit(voiceModelDraft, v)}
            />
            <Input
              label="Transcription API key"
              type="password"
              value={read(voiceKeyDraft)}
              placeholder={
                bridge.config.hasVoiceKey ? '•••• (saved)' : VOICE_KEY_PLACEHOLDER[voiceProvider]
              }
              onChange={(v) => edit(voiceKeyDraft, v)}
            />
            <Text muted size="xs">
              {`Voice messages and audio files are sent to ${VOICE_PROVIDER_LABEL[voiceProvider]} to be transcribed, then the text goes to the Orca bot. The provider charges per minute of audio.`}
            </Text>
            {!bridge.config.hasVoiceKey && !read(voiceKeyDraft).trim() && (
              <Text muted size="xs">
                {'Add an API key, or voice messages get a "not enabled" reply.'}
              </Text>
            )}
          </Stack>
        )}
        <Row gap="xs" wrap>
          <Button size="sm" disabled={isBusy} onPress={() => saveConfig(bridge)}>
            Save Settings
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={isBusy || !bridge.config.hasToken}
            onPress={() => testConnection(bridge.id)}
          >
            Test Connection
          </Button>
          <Button size="sm" variant="ghost" disabled={isBusy} onPress={closeEditor}>
            Cancel
          </Button>
        </Row>
      </Stack>
    </Card>
  )
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

  const editing = findBridge(state, read(editingBridgeId))
  const confirming = read(confirmRemoveId)
  const bridgeNames = new Map(state.bridges.map((b) => [b.id, b.name]))
  const bridgeFilterOptions = [
    { value: ALL_BRIDGES, label: 'All bridges' },
    { value: PLUGIN_LOGS, label: 'Plugin' },
    ...state.bridges.map((b) => ({ value: b.id, label: clip(b.name) }))
  ]
  // A persisted filter may name a bridge that was removed since.
  const storedBridgeFilter = read(logBridgeFilter)
  const bridgeFilter = bridgeFilterOptions.some((o) => o.value === storedBridgeFilter)
    ? storedBridgeFilter
    : ALL_BRIDGES
  const shownLogs = state.logs.filter(
    (entry) => matchesFilter(entry, filter) && matchesBridge(entry, bridgeFilter)
  )
  const canExport = host.has('files.saveAs')
  const chatCount = state.bridges.reduce((sum, b) => sum + b.bindings.length, 0)
  const connectedCount = state.bridges.filter((b) => b.status === 'connected').length
  const summary =
    state.bridges.length === 0
      ? 'No bridges yet'
      : `${state.bridges.length} ${state.bridges.length === 1 ? 'bridge' : 'bridges'} · ${connectedCount} connected`

  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Stack gap="xs">
          <Heading level={2}>Telegram Bridge</Heading>
          <Text muted size="xs">
            {summary}
          </Text>
        </Stack>
        <Button size="sm" variant="ghost" disabled={isBusy} onPress={refresh}>
          Refresh
        </Button>
      </Row>

      {notice && (
        <Callout tone={notice.tone} title={clip(notice.text)} />
      )}

      <Tabs
        label="Telegram Bridge sections"
        value={tab}
        onChange={(v) => set(activeTab, v as 'setup' | 'bindings' | 'logs')}
      >
        <Tab value="setup" label="Setup">
          <Stack gap="sm">
            {state.bridges.length === 0 && (
              <EmptyState
                icon="bot"
                title="No bridges yet"
                description="A bridge connects one Telegram bot to one Orca bot. Add one to start."
              />
            )}
            {state.bridges.flatMap((bridge) => [
              bridgeCard(bridge, isBusy, confirming === bridge.id),
              ...(editing && editing.id === bridge.id ? [bridgeEditor(bridge, state, isBusy)] : [])
            ])}
            <Row gap="xs">
              <Button size="sm" variant="outline" icon="add" disabled={isBusy} onPress={addBridge}>
                Add bridge
              </Button>
            </Row>
          </Stack>
        </Tab>

        <Tab value="bindings" label={`Chats (${chatCount})`}>
          {chatCount === 0 ? (
            <EmptyState
              icon="bot"
              title="No active Telegram chats yet"
              description="Send a message to your Telegram bot after configuring your allowlist."
            />
          ) : (
            <Stack gap="sm">
              {state.bridges.flatMap((bridge) => [
                <Heading key={`chats-title:${bridge.id}`} level={3}>
                  {clip(bridge.name)}
                </Heading>,
                bridge.bindings.length === 0 ? (
                  <Text key={`chats-empty:${bridge.id}`} muted size="xs">
                    No chats yet.
                  </Text>
                ) : (
                  <List key={`chats:${bridge.id}`} label={clip(`${bridge.name} chat bindings`)}>
                    {bridge.bindings.map((b) => (
                      <ListItem
                        key={b.tgChatId}
                        icon="bot"
                        title={clip(`TG ${b.tgChatId} -> ${b.botName}`)}
                        description={b.orcaChatId ? `Orca chat: ${b.orcaChatId}` : 'Next message opens new chat'}
                      >
                        <Row gap="xs" align="center">
                          <RelativeTime at={b.updatedAt} muted />
                          <Button
                            key={`reset:${bridge.id}:${b.tgChatId}`}
                            size="xs"
                            variant="ghost"
                            onPress={() => void resetBinding(bridge.id, b.tgChatId)}
                          >
                            Reset
                          </Button>
                        </Row>
                      </ListItem>
                    ))}
                  </List>
                )
              ])}
            </Stack>
          )}
        </Tab>

        <Tab value="logs" label={`Logs (${state.logTotal})`}>
          <Stack gap="xs">
            <Row gap="sm" align="end" justify="between" wrap>
              <Switch
                label="Debug logging"
                checked={state.global.debugLogging}
                onChange={(v) => void setDebugLogging(v)}
              />
              <Row gap="sm" align="end" wrap>
                <Select
                  label="Bridge"
                  value={bridgeFilter}
                  options={bridgeFilterOptions}
                  onChange={(v) => set(logBridgeFilter, v)}
                />
                <Select
                  label="Log level filter"
                  value={filter}
                  options={LOG_FILTERS}
                  onChange={(v) => set(logFilter, v as LogFilter)}
                />
              </Row>
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
                      filter === 'debug' && !state.global.debugLogging
                        ? 'Turn on Debug logging to record debug entries.'
                        : 'Pick another level or bridge to see more entries.'
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
                            description={logMeta(entry, bridgeNames)}
                          >
                            <RelativeTime at={entry.at} muted />
                          </ListItem>
                        ))}
                      </List>
                    ) : (
                      <Collapsible
                        key={`log-${block.entry.id}`}
                        title={clip(block.entry.message)}
                        description={`${logMeta(block.entry, bridgeNames)} · ${formatTime(block.entry.at)}`}
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
