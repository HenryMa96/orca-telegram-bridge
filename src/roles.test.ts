import { assert, test } from 'orca/testing'
import {
  defaultRoles,
  FULL_ROLE_ID,
  MEMBER_ROLE_ID,
  normalizeRoleAssignments,
  normalizeRoles,
  permissionForCallback,
  permissionForCommand,
  resolveRole,
  ROLE_PERMISSIONS,
  roleAllows,
  roleMayRun,
  STRANGER_ROLE_ID,
  type BridgeRole
} from './roles'

const team: BridgeRole = {
  id: 'r-team',
  name: 'Team',
  permissions: ['chat', 'newPrivate', 'automations', 'run'],
  prompt: 'Teammate: plain words.',
  runAutomationIds: ['auto-diag']
}

test('stored roles always keep the three built-in roles, and Stranger can never hold a risky permission', () => {
  const roles = normalizeRoles([
    { id: 'stranger', name: 'Stranger', permissions: ['chat', 'run', 'sync', 'bindPrivate', 'nonsense'], prompt: ' x ' },
    { id: 'full', name: 'Full access', permissions: [] },
    team,
    { id: 'r-team', name: 'Duplicate', permissions: [] }
  ])
  assert.deepEqual(roles.map((r) => r.id), [FULL_ROLE_ID, MEMBER_ROLE_ID, STRANGER_ROLE_ID, 'r-team'])
  assert.deepEqual(roles[0].permissions, [...ROLE_PERMISSIONS])
  assert.deepEqual(roles[2].permissions, ['chat'])
  assert.equal(roles[2].prompt, 'x')
  assert.equal(roles[3].name, 'Team')
  assert.deepEqual(normalizeRoles(undefined), defaultRoles())
})

test('assignments keep numeric ids pointing at roles that exist', () => {
  const roles = normalizeRoles([team])
  assert.deepEqual(normalizeRoleAssignments({ '42': 'r-team', '-100500': 'member', abc: 'full', '7': 'gone' }, roles), {
    '42': 'r-team',
    '-100500': 'member'
  })
})

test("a listed sender's own role wins in groups; unlisted members get the group's role; else Member or Stranger", () => {
  const roles = normalizeRoles([team])
  const assignments = { '42': FULL_ROLE_ID, '-100500': 'r-team' }
  const inGroup = (senderId: string) => resolveRole(roles, assignments, { senderId, chatId: '-100500', isGroup: true, openToEveryone: false })
  assert.equal(inGroup('42').id, FULL_ROLE_ID)
  assert.equal(inGroup('7').id, 'r-team')
  assert.equal(resolveRole(roles, assignments, { senderId: '7', chatId: '7', isGroup: false, openToEveryone: false }).id, MEMBER_ROLE_ID)
  assert.equal(resolveRole(roles, {}, { senderId: '7', chatId: '7', isGroup: false, openToEveryone: true }).id, STRANGER_ROLE_ID)
})

test('commands and buttons need separate private and group rights for /new, /home and /bind', () => {
  assert.equal(permissionForCommand('/new', false), 'newPrivate')
  assert.equal(permissionForCommand('/new', true), 'newGroup')
  assert.equal(permissionForCommand('/chats', true), 'bindGroup')
  assert.equal(permissionForCommand('/help', true), null)
  assert.equal(permissionForCommand('/start', false), null)
  // An unknown command goes on to the Orca bot as a message, so a role without chat cannot use it.
  assert.equal(permissionForCommand('/anything', false), 'chat')
  assert.equal(roleAllows({ ...team, permissions: ['run'] }, permissionForCommand('/anything', false)), false)
  assert.equal(permissionForCallback('c:home', true), 'homeGroup')
  assert.equal(permissionForCallback('b:chat-1', false), 'bindPrivate')
  assert.equal(permissionForCallback('r:auto-1', false), 'run')
  const member = defaultRoles()[1]
  assert.equal(roleAllows(member, permissionForCommand('/new', false)), true)
  assert.equal(roleAllows(member, permissionForCommand('/new', true)), false)
  assert.equal(roleAllows(member, null), true)
})

test('a role may run only its chosen automations, and only with the run permission', () => {
  assert.equal(roleMayRun(team, 'auto-diag'), true)
  assert.equal(roleMayRun(team, 'auto-deploy'), false)
  assert.equal(roleMayRun({ ...team, runAutomationIds: null }, 'auto-deploy'), true)
  assert.equal(roleMayRun({ ...team, permissions: ['chat'], runAutomationIds: null }, 'auto-diag'), false)
})
