import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { loadEnv } from '@ci/config'
import { grantPlatformAdmin, schema } from '@ci/db'
import { eq } from 'drizzle-orm'
import { createApp } from '../src/app'
import { createApiContext } from '../src/context'
import { type ApiFixture, createApiFixture } from './helpers/session'

/**
 * The role gate, and what a workspace's status does to it.
 *
 * These are the assertions the suite never had: every previous API test called an endpoint
 * with no session at all, so the difference between an agent and an admin was only ever
 * exercised in the browser, as the seeded admin, against routes that happened to be
 * admin-only.
 */

const env = { ...loadEnv(), TOOL_EGRESS_ALLOW_PRIVATE: false }
const ctx = createApiContext(env)
const app = createApp(ctx)

let fixture: ApiFixture

beforeAll(async () => {
  fixture = await createApiFixture(ctx, app)
})

afterAll(async () => {
  await fixture.cleanup()
  await ctx.runtime.close()
})

const statusOf = (response: Response) => response.status

describe('the role gate', () => {
  test('refuses an anonymous caller before it asks about roles', async () => {
    expect(statusOf(await fixture.as(null, '/api/v1/settings/tools'))).toBe(401)
  })

  test('lets an admin into an admin-only route', async () => {
    expect(statusOf(await fixture.as(fixture.admin, '/api/v1/settings/tools'))).toBe(200)
  })

  test('refuses an agent and a viewer the same route', async () => {
    for (const actor of [fixture.agent, fixture.viewer]) {
      const response = await fixture.as(actor, '/api/v1/settings/tools')
      expect(response.status).toBe(403)
      expect((await response.json()).error).toContain('admin')
    }
  })

  test('lets both read the inbox, and only the agent write', async () => {
    expect(statusOf(await fixture.as(fixture.agent, '/api/v1/conversations'))).toBe(200)
    expect(statusOf(await fixture.as(fixture.viewer, '/api/v1/conversations'))).toBe(200)

    // Writing is where the two part company.
    const write = (actor: typeof fixture.agent) =>
      fixture.as(actor, '/api/v1/settings/canned-responses', {
        method: 'POST',
        body: JSON.stringify({ shortcut: `sc${Date.now().toString(36)}`, body: 'hello' }),
      })

    expect(statusOf(await write(fixture.viewer))).toBe(403)
    expect(statusOf(await write(fixture.agent))).toBe(200)
  })
})

describe('settings/me', () => {
  test('names the workspace, the role and every membership', async () => {
    const response = await fixture.as(fixture.admin, '/api/v1/settings/me')
    expect(response.status).toBe(200)

    const me = await response.json()
    expect(me.userId).toBe(fixture.admin.userId)
    expect(me.role).toBe('admin')
    expect(me.workspace.id).toBe(fixture.workspaceId)
    expect(me.workspace.status).toBe('active')
    expect(me.memberships).toHaveLength(1)
    expect(me.platformAdmin).toBe(false)
  })

  test('reports platform admin when the row is there', async () => {
    await grantPlatformAdmin(ctx.db, { userId: fixture.agent.userId, grantedByUserId: null })
    try {
      const me = await (await fixture.as(fixture.agent, '/api/v1/settings/me')).json()
      expect(me.platformAdmin).toBe(true)
    } finally {
      await ctx.db
        .delete(schema.platformAdmins)
        .where(eq(schema.platformAdmins.userId, fixture.agent.userId))
    }
  })
})

describe('a workspace that is not active', () => {
  const setStatus = (status: 'active' | 'suspended' | 'deleting') =>
    ctx.db
      .update(schema.workspaces)
      .set({ status })
      .where(eq(schema.workspaces.id, fixture.workspaceId))

  test('refuses its own admin, with a code the console can branch on', async () => {
    await setStatus('suspended')
    try {
      const response = await fixture.as(fixture.admin, '/api/v1/conversations')
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ code: 'workspace_suspended' })
    } finally {
      await setStatus('active')
    }
  })

  test('says so differently while it is being deleted', async () => {
    await setStatus('deleting')
    try {
      const response = await fixture.as(fixture.admin, '/api/v1/conversations')
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ code: 'workspace_deleting' })
    } finally {
      await setStatus('active')
    }
  })

  test('still answers settings/me, which is how the console explains itself', async () => {
    await setStatus('suspended')
    try {
      const response = await fixture.as(fixture.admin, '/api/v1/settings/me')
      expect(response.status).toBe(200)
      const me = await response.json()
      expect(me.workspace.status).toBe('suspended')
      expect(me.role).toBe('admin')
    } finally {
      await setStatus('active')
    }
  })
})

describe('the member list the inbox reads', () => {
  /**
   * The inbox labels each row with who owns the customer, and the owner control in the
   * sidebar lists colleagues. Both read this endpoint, so a viewer has to be able to: if it
   * were admin-only the badges would simply be absent for viewers, with no error to notice.
   */
  test('is readable by everyone who can read the inbox', async () => {
    for (const actor of [fixture.admin, fixture.agent, fixture.viewer]) {
      const response = await fixture.as(actor, '/api/v1/settings/members')
      expect(response.status).toBe(200)
      const body = (await response.json()) as { members: { userId: string }[] }
      expect(body.members).toHaveLength(3)
    }
  })
})
