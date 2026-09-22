/**
 * Role definitions for the agent GUI, expressed with Better Auth's access-control API
 * so the organization plugin enforces them consistently.
 *
 *  - admin  : everything, including credentials and user management
 *  - agent  : works the inbox and edits knowledge, but cannot see or change credentials
 *  - viewer : read-only, for a manager reviewing the pilot
 */
import { USER_ROLES, type UserRoleName } from '@ci/shared'
import { createAccessControl } from 'better-auth/plugins/access'

export const statement = {
  conversation: ['read', 'reply', 'take_over', 'set_mode', 'assign', 'resolve'],
  customer: ['read', 'update', 'merge', 'delete'],
  knowledge: ['read', 'write', 'delete'],
  provider: ['read', 'write'],
  settings: ['read', 'write'],
  member: ['read', 'invite', 'remove'],
  trace: ['read'],
} as const

export const ac = createAccessControl(statement)

export const admin = ac.newRole({
  conversation: ['read', 'reply', 'take_over', 'set_mode', 'assign', 'resolve'],
  customer: ['read', 'update', 'merge', 'delete'],
  knowledge: ['read', 'write', 'delete'],
  provider: ['read', 'write'],
  settings: ['read', 'write'],
  member: ['read', 'invite', 'remove'],
  trace: ['read'],
})

export const agent = ac.newRole({
  conversation: ['read', 'reply', 'take_over', 'set_mode', 'assign', 'resolve'],
  customer: ['read', 'update', 'merge'],
  knowledge: ['read', 'write'],
  settings: ['read'],
  member: ['read'],
  trace: ['read'],
})

export const viewer = ac.newRole({
  conversation: ['read'],
  customer: ['read'],
  knowledge: ['read'],
  settings: ['read'],
  member: ['read'],
  trace: ['read'],
})

export const roles = { admin, agent, viewer }

/**
 * The role names themselves live in `@ci/shared`, because the console renders them and
 * cannot import this package. Re-exported here so the auth config and its callers keep
 * their existing import.
 */
export { USER_ROLES, type UserRoleName }
