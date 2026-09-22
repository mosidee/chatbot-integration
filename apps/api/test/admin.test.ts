import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { loadEnv } from '@ci/config'
import { createWorkspace, grantPlatformAdmin, newId, schema } from '@ci/db'
import { and, eq } from 'drizzle-orm'
import { createApp } from '../src/app'
import { createApiContext } from '../src/context'
import {
  type ApiActor,
  type ApiFixture,
  createApiFixture,
  createUser,
  signInAs,
} from './helpers/session'

/**
 * Workspace administration: the invariants, not the happy path.
 *
 * Two of these cover races. They send genuinely concurrent requests rather than awaiting one
 * after the other, because the bug they pin down is invisible in sequence: the check held a
 * row lock, returned, and only then did the update run, by which time the lock was gone.
 */

const env = { ...loadEnv(), TOOL_EGRESS_ALLOW_PRIVATE: false }
const ctx = createApiContext(env)
const app = createApp(ctx)

let fixture: ApiFixture
const strayUserIds: string[] = []

beforeAll(async () => {
  fixture = await createApiFixture(ctx, app)
})

afterAll(async () => {
  for (const id of strayUserIds) {
    await ctx.db.delete(schema.user).where(eq(schema.user.id, id))
  }
  await fixture.cleanup()
  await ctx.runtime.close()
})

/**
 * An extra admin with a session of their own.
 *
 * The race needs two people, not one person sending two requests: the invariant is about
 * the count, and a caller who demotes themselves stops being an admin, so their second
 * request would be turned away by the role gate for an unrelated reason.
 */
async function addAdmin(label: string): Promise<ApiActor> {
  const password = 'test-password-12345'
  const email = `${label}-${Math.random().toString(36).slice(2, 8)}@example.com`
  const { userId } = await createUser(ctx, { email, password })
  strayUserIds.push(userId)
  await ctx.db.insert(schema.member).values({
    id: newId(),
    organizationId: fixture.workspaceId,
    userId,
    role: 'admin',
    createdAt: new Date(),
  })
  const cookie = await signInAs(app, { email, password, origin: ctx.env.PUBLIC_WEB_URL })
  return { userId, email, cookie }
}

/** Put the workspace back to exactly one admin: the fixture's. */
async function restoreSoleAdmin(strayUserId: string): Promise<void> {
  await ctx.db
    .delete(schema.member)
    .where(
      and(
        eq(schema.member.organizationId, fixture.workspaceId),
        eq(schema.member.userId, strayUserId),
      ),
    )
  const rows = await ctx.db
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(
      and(
        eq(schema.member.organizationId, fixture.workspaceId),
        eq(schema.member.userId, fixture.admin.userId),
      ),
    )
    .limit(1)
  if (rows.length === 0) {
    await ctx.db.insert(schema.member).values({
      id: newId(),
      organizationId: fixture.workspaceId,
      userId: fixture.admin.userId,
      role: 'admin',
      createdAt: new Date(),
    })
  } else {
    await ctx.db
      .update(schema.member)
      .set({ role: 'admin' })
      .where(eq(schema.member.id, rows[0]?.id ?? ''))
  }
}

const adminCount = async (): Promise<number> => {
  const rows = await ctx.db
    .select({ userId: schema.member.userId })
    .from(schema.member)
    .where(
      and(eq(schema.member.organizationId, fixture.workspaceId), eq(schema.member.role, 'admin')),
    )
  return rows.length
}

describe('the last admin', () => {
  test('cannot demote themselves', async () => {
    const response = await fixture.as(
      fixture.admin,
      `/api/v1/admin/members/${fixture.admin.userId}`,
      { method: 'PATCH', body: JSON.stringify({ role: 'agent' }) },
    )
    expect(response.status).toBe(409)
    expect(await adminCount()).toBe(1)
  })

  test('cannot be removed', async () => {
    const response = await fixture.as(
      fixture.admin,
      `/api/v1/admin/members/${fixture.admin.userId}`,
      { method: 'DELETE' },
    )
    expect(response.status).toBe(409)
    expect(await adminCount()).toBe(1)
  })

  /**
   * The race the lock exists for.
   *
   * Two admins demote each other at the same instant. Both see two admins; exactly one may
   * win, and the workspace must be left with an admin. Held apart from its mutation the
   * lock proved nothing: both demotions were allowed through and nobody was left who could
   * invite anyone. The loser may be refused as the last admin or, if it lost the commit
   * race by enough, turned away by the role gate it no longer passes — both are refusals,
   * and which one arrives is a matter of microseconds.
   */
  test('survives two admins demoting each other at once', async () => {
    const other = await addAdmin('demote-race')
    expect(await adminCount()).toBe(2)

    try {
      const [a, b] = await Promise.all([
        fixture.as(fixture.admin, `/api/v1/admin/members/${other.userId}`, {
          method: 'PATCH',
          body: JSON.stringify({ role: 'agent' }),
        }),
        fixture.as(other, `/api/v1/admin/members/${fixture.admin.userId}`, {
          method: 'PATCH',
          body: JSON.stringify({ role: 'agent' }),
        }),
      ])

      const statuses = [a.status, b.status]
      expect(statuses.filter((code) => code === 200)).toHaveLength(1)
      expect(statuses.filter((code) => code === 409 || code === 403)).toHaveLength(1)
      expect(await adminCount()).toBe(1)
    } finally {
      await restoreSoleAdmin(other.userId)
    }
  })

  test('survives two admins removing each other at once', async () => {
    const other = await addAdmin('remove-race')
    expect(await adminCount()).toBe(2)

    try {
      const [a, b] = await Promise.all([
        fixture.as(fixture.admin, `/api/v1/admin/members/${other.userId}`, { method: 'DELETE' }),
        fixture.as(other, `/api/v1/admin/members/${fixture.admin.userId}`, { method: 'DELETE' }),
      ])

      const statuses = [a.status, b.status]
      expect(statuses.filter((code) => code === 200)).toHaveLength(1)
      expect(statuses.filter((code) => code === 409 || code === 403)).toHaveLength(1)
      expect(await adminCount()).toBe(1)
    } finally {
      await restoreSoleAdmin(other.userId)
    }
  })

  test('a refused demotion writes no audit row', async () => {
    const before = await ctx.db
      .select({ id: schema.auditLog.id })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.workspaceId, fixture.workspaceId))

    await fixture.as(fixture.admin, `/api/v1/admin/members/${fixture.admin.userId}`, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'agent' }),
    })

    const after = await ctx.db
      .select({ id: schema.auditLog.id })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.workspaceId, fixture.workspaceId))
    expect(after.length).toBe(before.length)
  })
})

describe('a member who is not one', () => {
  test('cannot be updated', async () => {
    const response = await fixture.as(fixture.admin, `/api/v1/admin/members/${newId()}`, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'agent' }),
    })
    expect(response.status).toBe(404)
  })

  test('cannot be removed', async () => {
    const response = await fixture.as(fixture.admin, `/api/v1/admin/members/${newId()}`, {
      method: 'DELETE',
    })
    expect(response.status).toBe(404)
  })
})

describe('the role gate', () => {
  test('an agent cannot read the member list', async () => {
    const response = await fixture.as(fixture.agent, '/api/v1/admin/members')
    expect(response.status).toBe(403)
  })

  test('a viewer cannot invite', async () => {
    const response = await fixture.as(fixture.viewer, '/api/v1/admin/invitations', {
      method: 'POST',
      body: JSON.stringify({ email: 'nobody@example.com', role: 'agent' }),
    })
    expect(response.status).toBe(403)
  })
})

describe('a password reset link', () => {
  /**
   * The rule the reset route turns on: a link sets the password on the *account*, and an
   * account is global. An admin of one tenant issuing one for somebody who also belongs to
   * another is taking over a stranger's access, not resetting their own member's password.
   */
  test('is issued for a member who belongs to this workspace alone', async () => {
    const sole = await addAdmin('sole-member')
    // addAdmin makes them an admin; the rule is about reach, not role.
    const response = await fixture.as(
      fixture.admin,
      `/api/v1/admin/members/${sole.userId}/reset-link`,
      { method: 'POST' },
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { link: string }
    expect(body.link).toContain('/invite/')

    await restoreSoleAdmin(sole.userId)
  })

  test('is refused for a member who also belongs to another workspace', async () => {
    const shared = await addAdmin('two-tenants')
    const otherSlug = `other-${Math.random().toString(36).slice(2, 8)}`
    const other = await createWorkspace(ctx.db, { name: otherSlug, slug: otherSlug })
    await ctx.db.insert(schema.member).values({
      id: newId(),
      organizationId: other.workspaceId,
      userId: shared.userId,
      role: 'agent',
      createdAt: new Date(),
    })

    try {
      const response = await fixture.as(
        fixture.admin,
        `/api/v1/admin/members/${shared.userId}/reset-link`,
        { method: 'POST' },
      )
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ code: 'reset_requires_platform' })
    } finally {
      await ctx.db.delete(schema.organization).where(eq(schema.organization.id, other.workspaceId))
      await restoreSoleAdmin(shared.userId)
    }
  })

  test('is refused for a platform admin, however few workspaces they are in', async () => {
    const elevated = await addAdmin('platform-admin')
    await grantPlatformAdmin(ctx.db, { userId: elevated.userId, grantedByUserId: null })

    try {
      const response = await fixture.as(
        fixture.admin,
        `/api/v1/admin/members/${elevated.userId}/reset-link`,
        { method: 'POST' },
      )
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ code: 'reset_requires_platform' })
    } finally {
      await ctx.db
        .delete(schema.platformAdmins)
        .where(eq(schema.platformAdmins.userId, elevated.userId))
      await restoreSoleAdmin(elevated.userId)
    }
  })

  test('is refused for somebody who is not a member at all', async () => {
    const response = await fixture.as(
      fixture.admin,
      `/api/v1/admin/members/${newId()}/reset-link`,
      { method: 'POST' },
    )
    expect(response.status).toBe(404)
  })
})
