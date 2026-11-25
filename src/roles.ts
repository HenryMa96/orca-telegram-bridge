// Roles: what each person (or group) may do through a bridge, and the owner's extra prompt for them.
// Shared by the worker (enforcement) and the panel (editor), so both read the same rules.

/** What a role can be allowed to do. `/help` and `/start` are always allowed. */
export type RolePermission =
  | 'chat'
  | 'status'
  | 'bots'
  | 'newPrivate'
  | 'newGroup'
  | 'homePrivate'
  | 'homeGroup'
  | 'bindPrivate'
  | 'bindGroup'
  | 'rename'
  | 'sync'
  | 'automations'
  | 'run'

export const ROLE_PERMISSIONS: readonly RolePermission[] = [
  'chat',
  'status',
  'bots',
  'newPrivate',
  'newGroup',
  'homePrivate',
  'homeGroup',
  'bindPrivate',
  'bindGroup',
  'rename',
  'sync',
  'automations',
  'run'
]

export type BridgeRole = {
  id: string
  name: string
  permissions: RolePermission[]
  // Added to every message this role's people send to the Orca bot. A hint, not enforcement; never
  // shown to them. '' = none.
  prompt: string
  // With 'run': null = every automation, else only these automation ids.
  runAutomationIds: string[] | null
}

export const FULL_ROLE_ID = 'full'
export const MEMBER_ROLE_ID = 'member'
export const STRANGER_ROLE_ID = 'stranger'
export const BUILT_IN_ROLE_IDS: readonly string[] = [FULL_ROLE_ID, MEMBER_ROLE_ID, STRANGER_ROLE_ID]

// Anyone on Telegram gets the Stranger role, so it can never reach the owner's Orca chats,
// automations or bridge settings.
export const STRANGER_FORBIDDEN: readonly RolePermission[] = [
  'bots',
  'newGroup',
  'homePrivate',
  'homeGroup',
  'bindPrivate',
  'bindGroup',
  'rename',
  'sync',
  'automations',
  'run'
]

export function defaultRoles(): BridgeRole[] {
  return [
    { id: FULL_ROLE_ID, name: 'Full access', permissions: [...ROLE_PERMISSIONS], prompt: '', runAutomationIds: null },
    {
      id: MEMBER_ROLE_ID,
      name: 'Member',
      permissions: ['chat', 'status', 'newPrivate'],
      prompt: '',
      runAutomationIds: null
    },
    {
      id: STRANGER_ROLE_ID,
      name: 'Stranger',
      permissions: ['chat', 'newPrivate'],
      prompt: '',
      runAutomationIds: null
    }
  ]
}

function isPermission(value: unknown): value is RolePermission {
  return ROLE_PERMISSIONS.includes(value as RolePermission)
}

/**
 * Stored or saved roles made safe: known permissions only, in a fixed order; the three built-in
 * roles always present (Full access keeps every permission); Stranger never holds a forbidden one;
 * unique ids; names trimmed (a blank custom name becomes its id).
 */
export function normalizeRoles(raw: unknown): BridgeRole[] {
  const defaults = defaultRoles()
  const byId = new Map<string, BridgeRole>()
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const id = typeof r.id === 'string' ? r.id.trim() : ''
    if (!id || byId.has(id)) continue
    const wanted = new Set(Array.isArray(r.permissions) ? r.permissions.filter(isPermission) : [])
    let permissions = ROLE_PERMISSIONS.filter((p) => wanted.has(p))
    if (id === FULL_ROLE_ID) permissions = [...ROLE_PERMISSIONS]
    if (id === STRANGER_ROLE_ID) permissions = permissions.filter((p) => !STRANGER_FORBIDDEN.includes(p))
    const name = typeof r.name === 'string' ? r.name.trim() : ''
    const ids = Array.isArray(r.runAutomationIds)
      ? r.runAutomationIds.filter((a): a is string => typeof a === 'string' && a.trim() !== '')
      : null
    byId.set(id, {
      id,
      name: name || defaults.find((d) => d.id === id)?.name || id,
      permissions,
      prompt: typeof r.prompt === 'string' ? r.prompt.trim() : '',
      runAutomationIds: ids
    })
  }
  for (const d of defaults) if (!byId.has(d.id)) byId.set(d.id, d)
  // Built-in roles first, in their fixed order, then the owner's own roles as they were.
  return [
    ...BUILT_IN_ROLE_IDS.map((id) => byId.get(id)!),
    ...[...byId.values()].filter((r) => !BUILT_IN_ROLE_IDS.includes(r.id))
  ]
}

/** Telegram user/group id → role id, keeping only numeric ids and roles that exist. */
export function normalizeRoleAssignments(raw: unknown, roles: BridgeRole[]): Record<string, string> {
  const known = new Set(roles.map((r) => r.id))
  const out: Record<string, string> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, roleId] of Object.entries(raw as Record<string, unknown>)) {
    const key = id.trim()
    if (/^-?\d+$/.test(key) && typeof roleId === 'string' && known.has(roleId)) out[key] = roleId
  }
  return out
}

/**
 * The role that applies to one sender in one chat. The sender's own role wins, also in a group;
 * else the group's role (for group members not on the list); else Stranger while the bridge is
 * open to everyone; else Member (allowed through a group id, or listed without a role).
 */
export function resolveRole(
  roles: BridgeRole[],
  assignments: Record<string, string>,
  who: { senderId: string; chatId: string; isGroup: boolean; openToEveryone: boolean }
): BridgeRole {
  const find = (id: string | undefined) => (id ? roles.find((r) => r.id === id) : undefined)
  return (
    find(assignments[who.senderId]) ??
    (who.isGroup ? find(assignments[who.chatId]) : undefined) ??
    find(who.openToEveryone ? STRANGER_ROLE_ID : MEMBER_ROLE_ID) ??
    defaultRoles().find((r) => r.id === (who.openToEveryone ? STRANGER_ROLE_ID : MEMBER_ROLE_ID))!
  )
}

/**
 * The permission a slash command needs in this chat; null = always allowed (/help, /start). An
 * unknown command goes on to the Orca bot as a message, so it needs 'chat'.
 */
export function permissionForCommand(command: string, isGroup: boolean): RolePermission | null {
  switch (command) {
    case '/help':
    case '/start':
      return null
    case '/status':
      return 'status'
    case '/bots':
    case '/use':
      return 'bots'
    case '/new':
      return isGroup ? 'newGroup' : 'newPrivate'
    case '/home':
      return isGroup ? 'homeGroup' : 'homePrivate'
    case '/chats':
    case '/bind':
      return isGroup ? 'bindGroup' : 'bindPrivate'
    case '/rename':
      return 'rename'
    case '/sync':
      return 'sync'
    case '/automations':
      return 'automations'
    case '/run':
      return 'run'
    default:
      return 'chat'
  }
}

/** The permission an inline button needs, from its callback data (`u:`, `b:`, `c:new`, `c:home`, `s:`, `r:`). */
export function permissionForCallback(data: string, isGroup: boolean): RolePermission | null {
  if (data.startsWith('u:')) return 'bots'
  if (data.startsWith('b:')) return isGroup ? 'bindGroup' : 'bindPrivate'
  if (data === 'c:new') return isGroup ? 'newGroup' : 'newPrivate'
  if (data === 'c:home') return isGroup ? 'homeGroup' : 'homePrivate'
  if (data.startsWith('s:')) return 'sync'
  if (data.startsWith('r:')) return 'run'
  return null
}

export function roleAllows(role: BridgeRole, permission: RolePermission | null): boolean {
  return permission === null || role.permissions.includes(permission)
}

/** Whether this role may run that automation (it also needs the 'run' permission). */
export function roleMayRun(role: BridgeRole, automationId: string): boolean {
  return role.permissions.includes('run') && (role.runAutomationIds === null || role.runAutomationIds.includes(automationId))
}
