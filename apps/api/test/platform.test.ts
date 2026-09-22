import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { loadEnv } from '@ci/config'
import { grantPlatformAdmin, schema } from '@ci/db'
import { eq } from 'drizzle-orm'
import { createApp } from '../src/app'
import { createApiContext } from '../src/context'
import { type ApiFixture, createApiFixture } from './helpers/session'

/**
 * Managing tenants, and being refused when you may not.
 *
 * The delete tests stop at the queue on purpose: what the job does with the rows and the
 * stored media is asserted in `packages/infra/test/erasure.integration.test.ts`, where a
 * real blob store is at hand.
 */

const env = { ...loadEnv(), TOOL_EGRESS_ALLOW_PRIVATE: false }
const ctx = createApiContext(env)
const app = createApp(ctx)

let fixture: ApiFixture
const createdTenants: string[] = []

beforeAll(async () => {
  fixture = await createApiFixture(ctx, app)
  // The admin of the fixture workspace is also the platform admin for these tests.
  await grantPlatformAdmin(ctx.db, { userId: fixture.admin.userId, grantedByUserId: null })
})

afterAll(async () => {
  for (const id of createdTenants) {
    await ctx.db.delete(schema.organization).where(eq(schema.organization.id, id))
    await ctx.db
      .delete(schema.workspaceErasures)
      .where(eq(schema.workspaceErasures.workspaceId, id))
  }
  await ctx.db
    .delete(schema.platformAdmins)
    .where(eq(schema.platformAdmins.userId, fixture.admin.userId))
  await fixture.cleanup()
  await ctx.runtime.close()
})

const slugFor = (label: string) => `plat-${label}-${Math.random().toString(36).slice(2, 8)}`

const createTenant = async (slug: string) => {
  const response = await fixture.as(fixture.admin, '/api/v1/platform/tenants', {
    method: 'POST',
    body: JSON.stringify({ name: slug, slug, adminEmail: `owner-${slug}@example.com` }),
  })
  if (response.status === 200) createdTenants.push((await response.clone().json()).id)
  return response
}

describe('the platform guard', () => {
  test('refuses somebody who is only a workspace admin', async () => {
    const response = await fixture.as(fixture.agent, '/api/v1/platform/tenants')
    expect(response.status).toBe(403)
    expect((await response.json()).error).toContain('platform admin')
  })

  test('refuses an anonymous caller with 401 rather than 403', async () => {
    expect((await fixture.as(null, '/api/v1/platform/tenants')).status).toBe(401)
  })

  test('lets a platform admin list tenants', async () => {
    const response = await fixture.as(fixture.admin, '/api/v1/platform/tenants')
    expect(response.status).toBe(200)
    const { tenants } = await response.json()
    expect(Array.isArray(tenants)).toBe(true)
  })
})

describe('creating a tenant', () => {
  test('returns the one link that can get into it', async () => {
    const slug = slugFor('new')
    const response = await createTenant(slug)
    expect(response.status).toBe(200)

    const created = await response.json()
    expect(created.inviteLink).toContain('/invite/')

    // The workspace exists, with its channels, and nobody in it yet.
    const listed = await (await fixture.as(fixture.admin, '/api/v1/platform/tenants')).json()
    const tenant = listed.tenants.find((row: { slug: string }) => row.slug === slug)
    expect(tenant).toBeDefined()
    expect(tenant.memberCount).toBe(0)
    expect(tenant.status).toBe('active')

    const channels = await ctx.db
      .select({ type: schema.channels.type })
      .from(schema.channels)
      .where(eq(schema.channels.workspaceId, created.id))
    expect(channels.map((c) => c.type).sort()).toEqual(['test', 'web'])
  })

  test('refuses a slug that is taken', async () => {
    const slug = slugFor('dupe')
    expect((await createTenant(slug)).status).toBe(200)
    expect((await createTenant(slug)).status).toBe(409)
  })
})

describe('suspending and restoring', () => {
  test('locks the tenant, then gives it back', async () => {
    const slug = slugFor('susp')
    const { id } = await (await createTenant(slug)).json()

    const suspend = await fixture.as(fixture.admin, `/api/v1/platform/tenants/${id}/suspend`, {
      method: 'POST',
    })
    expect(suspend.status).toBe(200)

    // Suspending twice is refused rather than quietly repeated.
    expect(
      (
        await fixture.as(fixture.admin, `/api/v1/platform/tenants/${id}/suspend`, {
          method: 'POST',
        })
      ).status,
    ).toBe(409)

    const restore = await fixture.as(fixture.admin, `/api/v1/platform/tenants/${id}/unsuspend`, {
      method: 'POST',
    })
    expect(restore.status).toBe(200)

    // And restoring an active one is refused too.
    expect(
      (
        await fixture.as(fixture.admin, `/api/v1/platform/tenants/${id}/unsuspend`, {
          method: 'POST',
        })
      ).status,
    ).toBe(409)
  })
})

describe('deleting a tenant', () => {
  test('insists the slug is typed, then marks it and queues the work', async () => {
    const slug = slugFor('del')
    const { id } = await (await createTenant(slug)).json()

    const wrong = await fixture.as(fixture.admin, `/api/v1/platform/tenants/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ slug: 'not-the-slug' }),
    })
    expect(wrong.status).toBe(400)

    const deleted = await fixture.as(fixture.admin, `/api/v1/platform/tenants/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ slug }),
    })
    expect(deleted.status).toBe(200)

    // Marked, recorded and queued, with nothing yet destroyed.
    const rows = await ctx.db
      .select({ status: schema.workspaces.status })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, id))
    expect(rows[0]?.status).toBe('deleting')

    const record = await ctx.db
      .select()
      .from(schema.workspaceErasures)
      .where(eq(schema.workspaceErasures.workspaceId, id))
    expect(record[0]?.slug).toBe(slug)
    expect(record[0]?.rowsDeleted).toBe(false)

    const job = await ctx.runtime.queues.workspace_erasure.getJob(`workspace-erasure-${id}`)
    expect(job).toBeTruthy()
    await job?.remove()

    // Asking twice is refused.
    const again = await fixture.as(fixture.admin, `/api/v1/platform/tenants/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ slug }),
    })
    expect(again.status).toBe(409)
  })
})

describe('platform admins', () => {
  test('are granted by address and never reduced to none', async () => {
    const granted = await fixture.as(fixture.admin, '/api/v1/platform/admins', {
      method: 'POST',
      body: JSON.stringify({ email: fixture.viewer.email }),
    })
    expect(granted.status).toBe(200)

    try {
      const { admins } = await (await fixture.as(fixture.admin, '/api/v1/platform/admins')).json()
      expect(admins.some((row: { userId: string }) => row.userId === fixture.viewer.userId)).toBe(
        true,
      )

      // With two, either may go.
      const revoked = await fixture.as(
        fixture.admin,
        `/api/v1/platform/admins/${fixture.viewer.userId}`,
        { method: 'DELETE' },
      )
      expect(revoked.status).toBe(200)
    } finally {
      await ctx.db
        .delete(schema.platformAdmins)
        .where(eq(schema.platformAdmins.userId, fixture.viewer.userId))
    }
  })

  test('refuse to remove the last one', async () => {
    /**
     * The set is made to contain exactly one, rather than hoping it already does.
     *
     * A seeded installation has its own platform admin, so branching on the count meant
     * this assertion ran on a clean database and silently did nothing on a developer's
     * machine — which is precisely where somebody would be exercising the page by hand.
     * Losing the last platform admin is the one irreversible mistake here, so the rule gets
     * a test that always runs.
     */
    const others = await ctx.db.select().from(schema.platformAdmins)
    const toRestore = others.filter((row) => row.userId !== fixture.admin.userId)
    for (const row of toRestore) {
      await ctx.db.delete(schema.platformAdmins).where(eq(schema.platformAdmins.userId, row.userId))
    }

    try {
      const response = await fixture.as(
        fixture.admin,
        `/api/v1/platform/admins/${fixture.admin.userId}`,
        { method: 'DELETE' },
      )
      expect(response.status).toBe(409)
      expect((await response.json()).error).toContain('at least one')

      // And it is still there: a refusal must not half-succeed.
      const still = await ctx.db
        .select({ userId: schema.platformAdmins.userId })
        .from(schema.platformAdmins)
      expect(still.map((row) => row.userId)).toEqual([fixture.admin.userId])
    } finally {
      for (const row of toRestore) {
        await ctx.db.insert(schema.platformAdmins).values(row).onConflictDoNothing()
      }
    }
  })

  test('refuse an address with no account', async () => {
    const response = await fixture.as(fixture.admin, '/api/v1/platform/admins', {
      method: 'POST',
      body: JSON.stringify({ email: 'nobody-at-all@example.com' }),
    })
    expect(response.status).toBe(404)
  })
})
