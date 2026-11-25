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
  on,
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
  FocusedBot,
  GroupMode,
  GroupReply,
  SaveConfigInput,
  VoiceProvider
} from './protocol'
import type { ReplyLanguageSetting } from './i18n'

type LogFilter = 'all' | 'errors' | 'warnings' | 'debug'
// Who can talk to the bot: only the listed Telegram IDs, or anyone (saved as an empty list).
type AccessMode = 'restricted' | 'open'

// Select option values must be non-empty: these stand for "every bridge" and "no bridge".
const ALL_BRIDGES = 'all'
const PLUGIN_LOGS = '__plugin__'

const bridgeState = atom<BridgeState | null>(null)
const activeTab = atom<'setup' | 'bindings' | 'logs'>('setup', 'setup', { persist: 'plugin' })
const logFilter = atom<LogFilter>('logFilter', 'all', { persist: 'plugin' })
const logBridgeFilter = atom<string>('logBridgeFilter', ALL_BRIDGES, { persist: 'plugin' })
// The bot selected in Orca's sidebar, as the worker found it; null until its first answer.
const focus = atom<FocusedBot | null>(null)
// Rises with each focus request; an answer to an older request is dropped.
let focusRequest = 0

// The bridge whose editor is open; one at a time.
const editingBridgeId = atom<string | null>(null)
// The bridge whose Remove was pressed once; a second press on Confirm remove removes it.
const confirmRemoveId = atom<string | null>(null)

const tokenDraft = atom('')
const accessModeDraft = atom<AccessMode>('restricted')
const allowedIdsDraft = atom('')
// Shown under the IDs field when Save is refused because the list has no valid ID.
const allowedIdsError = atom<string | null>(null)
const proxyUrlDraft = atom('')
const timeoutDraft = atom('300')
const syncOrcaOutboundDraft = atom(false)
const replyLanguageDraft = atom<ReplyLanguageSetting>('en')
const allowGroupsDraft = atom(false)
const groupModeDraft = atom<GroupMode>('addressed')
const groupReplyDraft = atom<GroupReply>('mentioned')
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

const MAX_LABEL = 500
const NEW_BOT_LABEL = 'New Telegram bot'
const NEEDS_ID = 'Add at least one Telegram ID, or choose Anyone on Telegram.'
const ALL_NEEDS_IDS =
  'Following the conversation works only with "Only these people and groups". While anyone can talk, the bot reads only messages for it.'

const LOG_FILTERS: Array<{ value: LogFilter; label: string }> = [
  { value: 'all', label: 'All levels' },
  { value: 'errors', label: 'Errors' },
  { value: 'warnings', label: 'Warnings and errors' },
  { value: 'debug', label: 'Debug only' }
]
const REPLY_LANGUAGE_OPTIONS: Array<{ value: ReplyLanguageSetting; label: string }> = [
  { value: 'auto', label: 'Auto (language of each message)' },
  { value: 'en', label: 'English' },
  { value: 'pt-BR', label: 'Português (Brasil)' },
  { value: 'es', label: 'Español' },
  { value: 'zh-CN', label: '中文' }
]
const ACCESS_OPTIONS: Array<{ value: AccessMode; label: string }> = [
  { value: 'restricted', label: 'Only these people and groups' },
  { value: 'open', label: 'Anyone on Telegram' }
]
// One choice says both what the bot reads in a group and when it answers; it maps to allowGroups,
// groupMode and groupReply.
type GroupBehavior = 'off' | 'addressed' | 'all-mentioned' | 'all-helpful'
const GROUP_OPTIONS: Array<{ value: GroupBehavior; label: string; description: string }> = [
  { value: 'off', label: 'Off', description: 'The bot ignores groups and leaves any group it is added to.' },
  {
    value: 'addressed',
    label: 'Answers when called',
    description:
      'Reads only messages for it (an @mention, a reply to the bot or a command) and answers each one. Other messages never reach the Orca bot.'
  },
  {
    value: 'all-mentioned',
    label: 'Follows the conversation, answers when called',
    description:
      'Reads every message as context, and answers only an @mention, a reply to the bot or a command.'
  },
  {
    value: 'all-helpful',
    label: 'Follows the conversation, joins in when useful',
    description:
      'Reads every message. Answers when called, and on its own when it can clearly help; otherwise stays silent.'
  }
]

function groupBehavior(allowGroups: boolean, groupMode: GroupMode, groupReply: GroupReply): GroupBehavior {
  if (!allowGroups) return 'off'
  return groupMode === 'addressed' ? 'addressed' : `all-${groupReply}`
}
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
  set(accessModeDraft, hasAllowedIds(bridge.config.allowedUserIds) ? 'restricted' : 'open')
  set(allowedIdsError, null)
  set(allowedIdsDraft, bridge.config.allowedUserIds)
  set(proxyUrlDraft, bridge.config.proxyUrl)
  set(timeoutDraft, String(bridge.config.replyTimeoutSec))
  set(syncOrcaOutboundDraft, bridge.config.syncOrcaOutbound)
  set(replyLanguageDraft, bridge.config.replyLanguage)
  set(allowGroupsDraft, bridge.config.allowGroups)
  set(groupModeDraft, bridge.config.groupMode)
  set(groupReplyDraft, bridge.config.groupReply)
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
  set(allowedIdsError, null)
  hydrateForm(state, true)
}

function closeEditor(): void {
  set(editingBridgeId, null)
  set(hydratedFor, null)
  set(tokenDraft, '')
  set(voiceKeyDraft, '')
  set(allowedIdsError, null)
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
      return { label: 'Needs token', tone: 'warning' }
    case 'error':
      return { label: 'Error', tone: 'danger' }
    case 'stopped':
      return { label: 'Paused', tone: 'neutral' }
  }
}

// The bot's @username is the one name people see. It is unknown until the token is checked, so
// lists where old bridges must stay apart pass the stored name as the fallback.
function bridgeLabel(bridge: BridgeView, fallback = NEW_BOT_LABEL): string {
  return bridge.botUsername ? `@${bridge.botUsername}` : fallback
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

function focusKey(value: FocusedBot | null): string | null {
  if (!value) return null
  return value.kind === 'bot' ? `bot:${value.bot.name}` : value.kind
}

// The worker reads Orca's focus itself (its workspace ids match its workspace list), so a focus
// change only says when to ask. A failed request counts as unknown: every bridge stays reachable.
async function refreshFocus(): Promise<void> {
  const request = ++focusRequest
  let next: FocusedBot
  try {
    next = await plugin.request('bridge.focusedBot')
  } catch (err) {
    next = { kind: 'unknown', reason: errorText(err) }
  }
  if (request !== focusRequest) return
  const before = read(focus)
  // An editor, a pending Remove or a message belongs to the bot that was shown.
  if (before && focusKey(before) !== focusKey(next)) {
    closeEditor()
    set(confirmRemoveId, null)
    if (read(bridgeState)) set(feedback, null)
  }
  set(focus, next)
}

// `orcaBot` pins the new bridge to the bot it was added for.
async function addBridge(orcaBot?: string): Promise<void> {
  set(busy, true)
  set(feedback, null)
  try {
    const res = await plugin.request('bridge.add', orcaBot ? { orcaBot } : {})
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
    set(feedback, { tone: 'success', text: `Removed ${bridgeLabel(bridge, bridge.name)}.` })
  } catch (err) {
    set(feedback, { tone: 'danger', text: errorText(err) })
  } finally {
    set(confirmRemoveId, null)
    set(busy, false)
  }
}

// The bridge's bot is fixed by where it is shown: the focused bot, or the bot it already has.
async function saveConfig(bridge: BridgeView, orcaBot: string): Promise<void> {
  const restricted = read(accessModeDraft) === 'restricted'
  if (restricted && !hasAllowedIds(read(allowedIdsDraft))) {
    set(allowedIdsError, NEEDS_ID)
    return
  }
  set(busy, true)
  set(feedback, null)
  try {
    const parsedTimeout = Number.parseInt(read(timeoutDraft), 10)
    const cleanToken = read(tokenDraft).trim()
    const cleanVoiceKey = read(voiceKeyDraft).trim()
    const payload: SaveConfigInput = {
      bridgeId: bridge.id,
      orcaBot,
      // An empty list is how the worker stores "anyone"; the typed IDs stay in the draft.
      allowedUserIds: restricted ? read(allowedIdsDraft).trim() : '',
      proxyUrl: read(proxyUrlDraft).trim(),
      replyTimeoutSec: Number.isFinite(parsedTimeout) ? parsedTimeout : 300,
      syncOrcaOutbound: read(syncOrcaOutboundDraft),
      replyLanguage: read(replyLanguageDraft),
      allowGroups: read(allowGroupsDraft),
      groupMode: read(groupModeDraft),
      groupReply: read(groupReplyDraft),
      voiceEnabled: read(voiceEnabledDraft),
      voiceProvider: read(voiceProviderDraft),
      voiceModel: read(voiceModelDraft).trim(),
      ...(cleanToken ? { botToken: cleanToken } : {}),
      ...(cleanVoiceKey ? { voiceApiKey: cleanVoiceKey } : {})
    }
    const next = await plugin.request('bridge.saveConfig', payload)
    set(bridgeState, next)
    // Back to the card, whose summary shows what was saved; the note sits at the top, now in view.
    closeEditor()
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
        if (bridge) {
          set(allowedIdsDraft, bridge.config.allowedUserIds)
          set(accessModeDraft, 'restricted')
          set(allowedIdsError, null)
        }
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

// Entries stored by 0.2.0 have no scope; they all came from the bridge itself. Without names (one
// bridge's own log) the bridge is not repeated on each entry.
function logMeta(entry: BridgeLogEntry, bridgeNames: Map<string, string> | null): string {
  const base = `${entry.level.toUpperCase()} · ${entry.scope ?? 'bridge'}`
  if (!entry.bridgeId || !bridgeNames) return base
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
    }),
    on('workspace.changed', () => void refreshFocus())
  )
  void refresh()
  void refreshFocus()
}

function hasAllowedIds(raw: string): boolean {
  return raw.split(/[\s,;]+/).some((id) => /^-?\d+$/.test(id))
}

// The card's plain-words line for groups. While the bot is open to everyone the worker reads
// only messages that call it, even with a Follows the conversation option saved.
function groupsSummary(bridge: BridgeView, openToEveryone: boolean): string {
  const { allowGroups, groupMode, groupReply } = bridge.config
  const behavior = groupBehavior(allowGroups, groupMode, groupReply)
  if (behavior === 'off') return 'Groups: off'
  if (behavior === 'addressed') return 'Groups: answers when called'
  if (openToEveryone) return 'Groups: answers when called (following the conversation needs an ID list)'
  return behavior === 'all-helpful'
    ? 'Groups: follows the conversation, joins in when useful'
    : 'Groups: follows the conversation, answers when called'
}

// `botName` is the bridge's Orca bot; '' means the first Orca bot found.
function bridgeCard(bridge: BridgeView, botName: string, isBusy: boolean) {
  const badge = statusMeta(bridge.status)
  const openToEveryone = !hasAllowedIds(bridge.config.allowedUserIds)
  const blockedUserId = bridge.lastBlockedUserId
  return (
    <Card
      key={`bridge:${bridge.id}`}
      title={clip(bridgeLabel(bridge))}
      description={clip(`→ ${botName || 'first Orca bot'}`)}
    >
      <Stack gap="xs">
        <Row justify="between" align="center">
          <Switch
            key={`active:${bridge.id}`}
            label="Active"
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
          {groupsSummary(bridge, openToEveryone)}
        </Text>
        <Text muted size="xs">
          {!bridge.config.voiceEnabled
            ? 'Voice: off'
            : `Voice: ${VOICE_PROVIDER_LABEL[bridge.config.voiceProvider]}${bridge.config.hasVoiceKey ? '' : ' – no API key'}`}
        </Text>
        {bridge.lastError && (
          <Callout tone="danger" title="Connection error" icon="error">
            <Text size="xs">{clip(bridge.lastError)}</Text>
          </Callout>
        )}
        {blockedUserId && (
          <Callout tone="warning" title="Unauthorized Telegram user" icon="warning">
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
                `Anyone who finds ${bridge.botUsername ? `@${bridge.botUsername}` : 'this bot'} on Telegram can chat with ${botName || 'your first Orca bot'} and use its commands with your rights. To limit it, press Edit and choose Only these people and groups.`
              )}
            </Text>
          </Callout>
        )}
        <Row gap="xs">
          <Button
            key={`edit:${bridge.id}`}
            size="sm"
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
        </Row>
      </Stack>
    </Card>
  )
}

// The Orca bot is not chosen here: a bridge belongs to the bot it is shown for.
function bridgeEditor(bridge: BridgeView, botName: string, isBusy: boolean, confirming: boolean) {
  const accessMode = read(accessModeDraft)
  const idsError = read(allowedIdsError)
  const groupChoice = groupBehavior(read(allowGroupsDraft), read(groupModeDraft), read(groupReplyDraft))
  const followsAll = groupChoice === 'all-mentioned' || groupChoice === 'all-helpful'
  const voiceOn = read(voiceEnabledDraft)
  const voiceProvider = read(voiceProviderDraft)

  return (
    <Card
      key={`editor:${bridge.id}`}
      title={clip(`Edit ${bridgeLabel(bridge)}`)}
      description={
        bridge.config.hasToken
          ? 'The bot token is stored encrypted in the OS keyring. Leave the field empty to keep it.'
          : 'Paste the token from @BotFather to connect the bot.'
      }
    >
      <Stack gap="lg">
        <Stack gap="sm">
          <Heading level={3}>Connection</Heading>
          <Input
            label="Telegram bot token"
            type="password"
            value={read(tokenDraft)}
            placeholder={bridge.config.hasToken ? '•••••••••••••••• (saved)' : '123456:ABC...'}
            onChange={(v) => edit(tokenDraft, v)}
          />
          <Text muted size="xs">
            {clip(`Orca bot: ${botName || 'the first Orca bot found'}. This Telegram bot talks only to it.`)}
          </Text>
        </Stack>

        <Stack gap="sm">
          <Heading level={3}>Who can talk</Heading>
          <RadioGroup
            label="Who can talk"
            labelHidden
            value={accessMode}
            options={ACCESS_OPTIONS}
            onChange={(v) => {
              edit(accessModeDraft, v as AccessMode)
              set(allowedIdsError, null)
            }}
          />
          {accessMode === 'restricted' ? (
            <Stack gap="xs">
              <Input
                label="Telegram user and group IDs"
                value={read(allowedIdsDraft)}
                placeholder="e.g. 123456789, -1001234567890"
                invalid={idsError !== null}
                onChange={(v) => {
                  edit(allowedIdsDraft, v)
                  set(allowedIdsError, null)
                }}
              />
              {idsError && (
                <Text tone="danger" size="xs">
                  {idsError}
                </Text>
              )}
            </Stack>
          ) : (
            <Callout tone="warning" icon="warning" title="Anyone can use this bot">
              <Text size="xs">
                {clip(
                  `Anyone who finds this bot can chat with ${botName || 'your first Orca bot'} and use its commands with your rights.`
                )}
              </Text>
            </Callout>
          )}
        </Stack>

        <Stack gap="sm">
          <Heading level={3}>Groups</Heading>
          <RadioGroup
            label="In groups"
            labelHidden
            value={groupChoice}
            options={GROUP_OPTIONS}
            onChange={(v) => {
              const choice = v as GroupBehavior
              edit(allowGroupsDraft, choice !== 'off')
              if (choice === 'addressed') edit(groupModeDraft, 'addressed')
              if (choice === 'all-mentioned' || choice === 'all-helpful') {
                edit(groupModeDraft, 'all')
                edit(groupReplyDraft, choice === 'all-helpful' ? 'helpful' : 'mentioned')
              }
            }}
          />
          {followsAll && (
            <Text muted size="xs">
              Following the conversation sends every group message to the Orca bot: one bot turn
              per message.
            </Text>
          )}
          {followsAll && accessMode === 'open' && (
            <Text muted size="xs">
              {ALL_NEEDS_IDS}
            </Text>
          )}
          {groupChoice !== 'off' && bridge.telegramCaps?.canJoinGroups === false && (
            <Callout tone="warning" icon="warning" title="This bot cannot join groups">
              <Text size="xs">In @BotFather, send /setjoingroups, pick this bot and choose Enable.</Text>
            </Callout>
          )}
          {groupChoice !== 'off' && bridge.telegramCaps?.canReadAllGroupMessages === false && (
            <Callout tone="warning" icon="warning" title="Privacy mode is on">
              <Stack gap="xs">
                <Text size="xs">
                  In groups the bot gets only commands and replies to its messages. For @mentions
                  and to follow the conversation:
                </Text>
                <Text size="xs">1. In @BotFather, send /setprivacy and pick this bot.</Text>
                <Text size="xs">2. Choose Disable.</Text>
                <Text size="xs">3. Add the bot to the group again.</Text>
              </Stack>
            </Callout>
          )}
        </Stack>

        <Stack gap="sm">
          <Heading level={3}>Features</Heading>
          <Switch
            label="Voice messages"
            checked={voiceOn}
            onChange={(v) => edit(voiceEnabledDraft, v)}
          />
          {voiceOn && (
            <Stack gap="sm">
              <Select
                label="Transcription provider"
                value={voiceProvider}
                options={VOICE_PROVIDER_OPTIONS}
                onChange={(v) => edit(voiceProviderDraft, v as VoiceProvider)}
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
          <Switch
            label="Sync Orca-side messages to Telegram"
            checked={read(syncOrcaOutboundDraft)}
            onChange={(v) => edit(syncOrcaOutboundDraft, v)}
          />
          {accessMode === 'open' && read(syncOrcaOutboundDraft) && (
            <Text muted size="xs">
              Sync is paused while the bot is open to everyone. Choose Only these people and groups
              to use it.
            </Text>
          )}
        </Stack>

        <Collapsible key={`advanced:${bridge.id}`} title="Advanced">
          <Stack gap="sm">
            <Select
              label="Telegram reply language"
              value={read(replyLanguageDraft)}
              options={REPLY_LANGUAGE_OPTIONS}
              onChange={(v) => edit(replyLanguageDraft, v as ReplyLanguageSetting)}
            />
            <Input
              label="Reply timeout (seconds)"
              value={read(timeoutDraft)}
              placeholder="300"
              onChange={(v) => edit(timeoutDraft, v)}
            />
            <Stack gap="xs">
              <Input
                label="HTTP proxy URL"
                value={read(proxyUrlDraft)}
                onChange={(v) => edit(proxyUrlDraft, v)}
              />
              <Text muted size="xs">
                Leave empty unless you need a proxy.
              </Text>
            </Stack>
            {voiceOn && (
              <Input
                label="Transcription model"
                value={read(voiceModelDraft)}
                placeholder={VOICE_DEFAULT_MODEL[voiceProvider]}
                onChange={(v) => edit(voiceModelDraft, v)}
              />
            )}
          </Stack>
        </Collapsible>

        <Stack gap="xs">
          {/* A failed save keeps the editor open; its reason belongs next to the button pressed. */}
          {read(feedback)?.tone === 'danger' && (
            <Text tone="danger" size="xs">
              {clip(read(feedback)!.text)}
            </Text>
          )}
          {confirming && (
            <Text tone="danger" size="xs">
              Removing stops this bot and deletes its token, chats and settings.
            </Text>
          )}
          <Row gap="xs" justify="between" wrap>
            <Row gap="xs">
              <Button size="sm" disabled={isBusy} onPress={() => saveConfig(bridge, botName)}>
                Save
              </Button>
              <Button size="sm" variant="ghost" disabled={isBusy} onPress={closeEditor}>
                Cancel
              </Button>
            </Row>
            <Row gap="xs">
              <Button
                size="sm"
                variant="outline"
                disabled={isBusy || !bridge.config.hasToken}
                onPress={() => testConnection(bridge.id)}
              >
                Test connection
              </Button>
              {confirming ? (
                <Button
                  key={`confirm-remove:${bridge.id}`}
                  size="sm"
                  tone="danger"
                  disabled={isBusy}
                  onPress={() => void removeBridge(bridge)}
                >
                  Confirm remove
                </Button>
              ) : (
                <Button
                  key={`remove:${bridge.id}`}
                  size="sm"
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
                  size="sm"
                  variant="ghost"
                  disabled={isBusy}
                  onPress={() => set(confirmRemoveId, null)}
                >
                  Keep
                </Button>
              )}
            </Row>
          </Row>
        </Stack>
      </Stack>
    </Card>
  )
}

// A bridge whose Orca bot is gone shows under no bot, so the hint lists it to edit or remove. A
// bridge on '' follows the first Orca bot and is lost only while there are no bots.
function isOrphan(bridge: BridgeView, state: BridgeState): boolean {
  const bot = bridge.config.orcaBot
  return bot ? !state.bots.some((b) => b.name === bot) : state.bots.length === 0
}

// A bot's bridge is the one pinned to its name; one stored with '' (the first Orca bot found)
// shows for the first bot of the list, as the worker routes it there.
function bridgeOfBot(state: BridgeState, botName: string): BridgeView | undefined {
  return (
    state.bridges.find((b) => b.config.orcaBot === botName) ??
    (state.bots[0]?.name === botName ? state.bridges.find((b) => b.config.orcaBot === '') : undefined)
  )
}

// Each bridge's card, with its editor under it while open.
function bridgeCards(bridges: BridgeView[], botNameOf: (bridge: BridgeView) => string, isBusy: boolean) {
  const editing = read(editingBridgeId)
  const confirming = read(confirmRemoveId)
  return bridges.flatMap((bridge) => [
    bridgeCard(bridge, botNameOf(bridge), isBusy),
    ...(editing === bridge.id
      ? [bridgeEditor(bridge, botNameOf(bridge), isBusy, confirming === bridge.id)]
      : [])
  ])
}

function refreshAll(): void {
  void refresh()
  void refreshFocus()
}

function panelHeader(lines: string[], isBusy: boolean) {
  return (
    <Row justify="between" align="center">
      <Stack gap="xs">
        <Heading level={2}>Telegram Bridge</Heading>
        {lines.map((line, i) => (
          <Text key={`header:${i}`} muted size="xs">
            {clip(line)}
          </Text>
        ))}
      </Stack>
      <Button size="sm" variant="ghost" disabled={isBusy} onPress={refreshAll}>
        Refresh
      </Button>
    </Row>
  )
}

// `grouped` puts each bridge's chats under its name; one bridge's chats need no heading.
function chatsTab(bridges: BridgeView[], grouped: boolean) {
  const chatCount = bridges.reduce((sum, b) => sum + b.bindings.length, 0)
  return (
    <Tab value="bindings" label={`Chats (${chatCount})`}>
      {chatCount === 0 ? (
        <EmptyState
          icon="bot"
          title="No active Telegram chats yet"
          description="Send a message to your Telegram bot after configuring your allowlist."
        />
      ) : (
        <Stack gap="sm">
          {bridges.flatMap((bridge) => [
            ...(grouped
              ? [
                  <Heading key={`chats-title:${bridge.id}`} level={3}>
                    {clip(bridgeLabel(bridge, bridge.name))}
                  </Heading>
                ]
              : []),
            bridge.bindings.length === 0 ? (
              <Text key={`chats-empty:${bridge.id}`} muted size="xs">
                No chats yet.
              </Text>
            ) : (
              <List
                key={`chats:${bridge.id}`}
                label={clip(`${bridgeLabel(bridge, bridge.name)} chat bindings`)}
              >
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
  )
}

// `scoped`: one bridge's entries, with no bridge filter. null: every entry, with the bridge filter.
function logsTab(state: BridgeState, scoped: BridgeLogEntry[] | null) {
  const filter = read(logFilter)
  const canExport = host.has('files.saveAs')
  const bridgeNames = scoped ? null : new Map(state.bridges.map((b) => [b.id, bridgeLabel(b, b.name)]))
  const bridgeFilterOptions = [
    { value: ALL_BRIDGES, label: 'All bridges' },
    { value: PLUGIN_LOGS, label: 'Plugin' },
    ...state.bridges.map((b) => ({ value: b.id, label: clip(bridgeLabel(b, b.name)) }))
  ]
  // A persisted filter may name a bridge that was removed since.
  const storedBridgeFilter = read(logBridgeFilter)
  const bridgeFilter = bridgeFilterOptions.some((o) => o.value === storedBridgeFilter)
    ? storedBridgeFilter
    : ALL_BRIDGES
  const entries = scoped ?? state.logs.filter((entry) => matchesBridge(entry, bridgeFilter))
  const total = scoped ? scoped.length : state.logTotal
  const hasEntries = scoped ? scoped.length > 0 : state.logs.length > 0
  const shownLogs = entries.filter((entry) => matchesFilter(entry, filter))

  return (
    <Tab value="logs" label={`Logs (${total})`}>
      <Stack gap="xs">
        <Row gap="sm" align="end" justify="between" wrap>
          <Switch
            label="Debug logging"
            checked={state.global.debugLogging}
            onChange={(v) => void setDebugLogging(v)}
          />
          <Row gap="sm" align="end" wrap>
            {!scoped && (
              <Select
                label="Bridge"
                value={bridgeFilter}
                options={bridgeFilterOptions}
                onChange={(v) => set(logBridgeFilter, v)}
              />
            )}
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
              Clear logs
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
        {!hasEntries ? (
          <EmptyState
            icon="info"
            title="No activity logs yet"
            description="Incoming Telegram messages and bridge events appear here."
          />
        ) : (
          <Stack gap="xs">
            <Text muted size="xs">
              {`Showing ${shownLogs.length} of ${total} entries`}
            </Text>
            {shownLogs.length === 0 ? (
              <EmptyState
                icon="filter"
                title="No entries match this filter"
                description={
                  filter === 'debug' && !state.global.debugLogging
                    ? 'Turn on Debug logging to record debug entries.'
                    : scoped
                      ? 'Pick another level to see more entries.'
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
  )
}

const SELECT_BOT_HINT = 'Select a bot in the left sidebar to see its Telegram bridge.'
const ALL_BRIDGES_NOTE = 'Showing all bridges: Orca did not say which bot is selected.'

export default function Panel() {
  const state = read(bridgeState)
  const focused = read(focus)
  const isBusy = read(busy)
  const notice = read(feedback)

  if (!state || !focused) {
    if (!state && notice) {
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

  const noticeCallout = notice && <Callout tone={notice.tone} title={clip(notice.text)} />
  const selectTab = (v: string) => set(activeTab, v as 'setup' | 'bindings' | 'logs')

  if (focused.kind === 'none') {
    const orphans = state.bridges.filter((b) => isOrphan(b, state))
    return (
      <Stack gap="md">
        <EmptyState icon="bot" title={SELECT_BOT_HINT} />
        {orphans.length > 0 && noticeCallout}
        {orphans.length > 0 && <Heading level={3}>Bridges without an Orca bot</Heading>}
        {orphans.length > 0 && (
          <Text muted size="xs">
            Their Orca bot no longer exists. Edit or remove them.
          </Text>
        )}
        {bridgeCards(orphans, (b) => b.config.orcaBot, isBusy)}
      </Stack>
    )
  }

  // Orca did not say which bot is selected: every bridge, as before bots scoped the panel, so the
  // setup is never out of reach.
  if (focused.kind === 'unknown') {
    const connectedCount = state.bridges.filter((b) => b.status === 'connected').length
    const summary =
      state.bridges.length === 0
        ? 'No bridges yet'
        : `${state.bridges.length} ${state.bridges.length === 1 ? 'bridge' : 'bridges'} · ${connectedCount} connected`
    return (
      <Stack gap="md">
        {panelHeader([summary, ALL_BRIDGES_NOTE], isBusy)}
        {noticeCallout}
        <Tabs label="Telegram Bridge sections" value={read(activeTab)} onChange={selectTab}>
          <Tab value="setup" label="Setup">
            <Stack gap="sm">
              {state.bridges.length === 0 && (
                <EmptyState
                  icon="bot"
                  title="No bridges yet"
                  description="A bridge connects one Telegram bot to one Orca bot. Add one to start."
                />
              )}
              {bridgeCards(state.bridges, (b) => b.config.orcaBot, isBusy)}
              <Row gap="xs">
                <Button size="sm" variant="outline" icon="add" disabled={isBusy} onPress={() => addBridge()}>
                  Add bridge
                </Button>
              </Row>
            </Stack>
          </Tab>
          {chatsTab(state.bridges, true)}
          {logsTab(state, null)}
        </Tabs>
      </Stack>
    )
  }

  const { bot } = focused
  const bridge = bridgeOfBot(state, bot.name)
  const bridges = bridge ? [bridge] : []
  return (
    <Stack gap="md">
      {panelHeader([`${bot.name} · ${bridge ? statusMeta(bridge.status).label : 'no bridge yet'}`], isBusy)}
      {noticeCallout}
      <Tabs label="Telegram Bridge sections" value={read(activeTab)} onChange={selectTab}>
        <Tab value="setup" label="Setup">
          <Stack gap="sm">
            {bridgeCards(bridges, () => bot.name, isBusy)}
            {!bridge && (
              <EmptyState
                icon="bot"
                title={clip(`No Telegram bridge for ${bot.name}`)}
                description="A bridge connects one Telegram bot to this Orca bot."
              />
            )}
            {!bridge && (
              <Row gap="xs">
                <Button
                  size="sm"
                  variant="outline"
                  icon="add"
                  disabled={isBusy}
                  onPress={() => addBridge(bot.name)}
                >
                  Add bridge
                </Button>
              </Row>
            )}
          </Stack>
        </Tab>
        {chatsTab(bridges, false)}
        {logsTab(state, bridge ? state.logs.filter((entry) => entry.bridgeId === bridge.id) : [])}
      </Tabs>
    </Stack>
  )
}
