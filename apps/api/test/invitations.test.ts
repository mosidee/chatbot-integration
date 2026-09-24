import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { loadEnv } from '@ci/config'
import { newId, schema } from '@ci/db'
import { eq, inArray } from 'drizzle-orm'
import { createApp } from '../src/app'
import { createApiContext } from '../src/context'
import { type ApiFixture, createApiFixture, signInAs } from './helpers/session'

/**
 * Inviting somebody, and letting them back in.
 *
 * The whole point of this milestone is that an admin can add a colleague without anybody
 * touching the database, so these assertions follow a link the way a person would: read it,
 * open it, use it, and find that it does not work twice.
 */

const env = { ...loadEnv(), TOOL_EGRESS_ALLOW_PRIVATE: false }
const ctx = createApiContext(env)
const app = createApp(ctx)

let fixture: ApiFixture
const strays: string[] = []

beforeAll(async () => {
  fixture = await createApiFixture(ctx, app)
})

afterAll(async () => {
  if (strays.length > 0) {
    await ctx.db.delete(schema.user).where(inArray(schema.user.id, strays))
  }
  await fixture.cleanup()
  await ctx.runtime.close()
})

const json = async (response: Response) => response.json()

const invite = async (email: string, role: 'admin' | 'agent' | 'viewer' = 'agent') =>
  fixture.as(fixture.admin, '/api/v1/admin/invitations', {
    method: 'POST',
    body: JSON.stringify({ email, role }),
  })

const tokenOf = (link: string): string => link.split('/invite/')[1] ?? ''

const accept = (token: string, body: Record<string, unknown>, cookie?: string) =>
  app.handle(
    new Request(`http://localhost/api/invitations/${token}/accept`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: env.PUBLIC_WEB_URL,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  )

describe('issuing an invitation', () => {
  test('is refused to an agent', async () => {
    const response = await fixture.as(fixture.agent, '/api/v1/admin/invitations', {
      method: 'POST',
      body: JSON.stringify({ email: 'nobody@example.com', role: 'agent' }),
    })
    expect(response.status).toBe(403)
  })

  test('refuses somebody who is already a member', async () => {
    const response = await invite(fixture.viewer.email)
    expect(response.status).toBe(409)
  })

  test('hands back a link, and lists it as pending', async () => {
    const email = `invitee-${newId().slice(0, 8)}@example.com`
    const created = await json(await invite(email))

    expect(created.link).toContain('/invite/')
    expect(created.existingAccount).toBe(false)

    const listed = await json(await fixture.as(fixture.admin, '/api/v1/admin/members'))
    expect(listed.invitations.some((row: { email: string }) => row.email === email)).toBe(true)
  })

  test('stores the hash of the token and never the token', async () => {
    const email = `hashed-${newId().slice(0, 8)}@example.com`
    const { link } = await json(await invite(email))
    const token = tokenOf(link)

    const rows = await ctx.db
      .select({ tokenHash: schema.workspaceInvitations.tokenHash })
      .from(schema.workspaceInvitations)
      .where(eq(schema.workspaceInvitations.email, email))

    expect(rows).toHaveLength(1)
    expect(rows[0]?.tokenHash).not.toBe(token)
    expect(rows[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('opening a link', () => {
  test('is a 404 when the token means nothing', async () => {
    const response = await app.handle(new Request('http://localhost/api/invitations/nonsense'))
    expect(response.status).toBe(404)
  })

  test('describes the workspace without spending the invitation', async () => {
    const email = `peek-${newId().slice(0, 8)}@example.com`
    const { link } = await json(await invite(email, 'viewer'))
    const token = tokenOf(link)

    for (const _attempt of [1, 2]) {
      const response = await app.handle(new Request(`http://localhost/api/invitations/${token}`))
      expect(response.status).toBe(200)
      const info = await response.json()
      expect(info.email).toBe(email)
      expect(info.role).toBe('viewer')
      expect(info.workspaceName).toBe(fixture.slug)
      expect(info.existingAccount).toBe(false)
    }
  })
})

describe('accepting with a new account', () => {
  test('creates the account, joins the workspace and signs them in', async () => {
    const email = `joiner-${newId().slice(0, 8)}@example.com`
    const { link } = await json(await invite(email, 'agent'))
    const token = tokenOf(link)

    const response = await accept(token, { name: 'New Joiner', password: 'a-good-password-1' })
    expect(response.status).toBe(200)

    const body = await response.json()
    strays.push(body.userId)
    expect(body.workspaceId).toBe(fixture.workspaceId)

    // The response carries a session, so they are already signed in.
    const cookie = response.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ')
    expect(cookie).toContain('better-auth')

    const me = await json(
      await app.handle(new Request('http://localhost/api/v1/settings/me', { headers: { cookie } })),
    )
    expect(me.role).toBe('agent')
    expect(me.workspace.id).toBe(fixture.workspaceId)

    // And the link is spent.
    const second = await accept(token, { name: 'Again', password: 'a-good-password-1' })
    expect(second.status).toBe(404)
  })

  test('refuses without a password, and leaves the link usable', async () => {
    const email = `careless-${newId().slice(0, 8)}@example.com`
    const { link } = await json(await invite(email))
    const token = tokenOf(link)

    expect((await accept(token, { name: 'No Password' })).status).toBe(422)

    // Still good: a rejected attempt must not burn somebody's only way in.
    const retry = await accept(token, { name: 'No Password', password: 'a-good-password-1' })
    expect(retry.status).toBe(200)
    strays.push((await retry.json()).userId)
  })
})

describe('accepting with an account that already exists', () => {
  test('asks them to sign in, refuses the wrong address, then joins them', async () => {
    // A second workspace, so the existing person has somewhere to be invited from.
    const other = await createApiFixture(ctx, app)
    try {
      const response = await other.as(other.admin, '/api/v1/admin/invitations', {
        method: 'POST',
        body: JSON.stringify({ email: fixture.agent.email, role: 'viewer' }),
      })
      const { link, existingAccount } = await response.json()
      expect(existingAccount).toBe(true)
      const token = tokenOf(link)

      // Nobody signed in.
      const anonymous = await accept(token, {})
      expect(anonymous.status).toBe(401)
      expect((await anonymous.json()).code).toBe('sign_in_required')

      // Signed in as somebody else.
      const wrong = await accept(token, {}, fixture.admin.cookie)
      expect(wrong.status).toBe(403)

      // The right person.
      const right = await accept(token, {}, fixture.agent.cookie)
      expect(right.status).toBe(200)
      expect((await right.json()).workspaceId).toBe(other.workspaceId)

      // They now belong to both, and the new one is active.
      const me = await json(
        await app.handle(
          new Request('http://localhost/api/v1/settings/me', {
            headers: { cookie: fixture.agent.cookie },
          }),
        ),
      )
      expect(me.memberships).toHaveLength(2)
    } finally {
      await ctx.db.delete(schema.member).where(eq(schema.member.organizationId, other.workspaceId))
      await other.cleanup()
    }
  })
})

describe('a password reset link', () => {
  test('sets a new password, drops old sessions and refuses the old one', async () => {
    const email = `locked-${newId().slice(0, 8)}@example.com`
    const { link: inviteUrl } = await json(await invite(email, 'agent'))
    const joined = await accept(tokenOf(inviteUrl), {
      name: 'Locked Out',
      password: 'first-password-1',
    })
    const { userId } = await joined.json()
    strays.push(userId)

    const oldCookie = joined.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ')

    const reset = await json(
      await fixture.as(fixture.admin, `/api/v1/admin/members/${userId}/reset-link`, {
        method: 'POST',
      }),
    )
    const response = await accept(tokenOf(reset.link), { password: 'second-password-2' })
    expect(response.status).toBe(200)

    // The new password works.
    const cookie = await signInAs(app, {
      email,
      password: 'second-password-2',
      origin: env.PUBLIC_WEB_URL,
    })
    expect(cookie).toContain('better-auth')

    // The old one does not.
    const stale = await app.handle(
      new Request('http://localhost/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: env.PUBLIC_WEB_URL },
        body: JSON.stringify({ email, password: 'first-password-1' }),
      }),
    )
    expect(stale.status).not.toBe(200)

    // And the session they held before the reset is gone.
    const before = await app.handle(
      new Request('http://localhost/api/v1/settings/me', { headers: { cookie: oldCookie } }),
    )
    expect(before.status).toBe(401)
  })
})

describe('the last admin', () => {
  test('cannot be demoted or removed', async () => {
    const demote = await fixture.as(
      fixture.admin,
      `/api/v1/admin/members/${fixture.admin.userId}`,
      { method: 'PATCH', body: JSON.stringify({ role: 'agent' }) },
    )
    expect(demote.status).toBe(409)

    const remove = await fixture.as(
      fixture.admin,
      `/api/v1/admin/members/${fixture.admin.userId}`,
      { method: 'DELETE' },
    )
    expect(remove.status).toBe(409)
  })

  test('may be demoted once somebody else is an admin', async () => {
    const promote = await fixture.as(
      fixture.admin,
      `/api/v1/admin/members/${fixture.agent.userId}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ role: 'admin' }),
      },
    )
    expect(promote.status).toBe(200)

    try {
      const demote = await fixture.as(
        fixture.admin,
        `/api/v1/admin/members/${fixture.admin.userId}`,
        { method: 'PATCH', body: JSON.stringify({ role: 'agent' }) },
      )
      expect(demote.status).toBe(200)
    } finally {
      // Put the fixture back the way the other tests expect it.
      await ctx.db
        .update(schema.member)
        .set({ role: 'admin' })
        .where(eq(schema.member.userId, fixture.admin.userId))
      await ctx.db
        .update(schema.member)
        .set({ role: 'agent' })
        .where(eq(schema.member.userId, fixture.agent.userId))
    }
  })

  /**
   * Recommendation #2. A workspace admin's link is checked again when it is spent: the
   * account may since have come to reach further than the issuer's authority covers.
   */
  const joinAndIssueReset = async () => {
    const email = `reach-${Math.random().toString(36).slice(2, 10)}@example.com`
    const { link } = await json(await invite(email, 'agent'))
    const { userId } = await (
      await accept(tokenOf(link), { name: 'Reach', password: 'pw-first-1234' })
    ).json()
    strays.push(userId)
    const reset = await json(
      await fixture.as(fixture.admin, `/api/v1/admin/members/${userId}/reset-link`, {
        method: 'POST',
      }),
    )
    return { userId, token: tokenOf(reset.link) }
  }

  test('is refused once the account also belongs to another workspace', async () => {
    const { userId, token } = await joinAndIssueReset()
    const other = await createApiFixture(ctx, app)
    try {
      await ctx.db.insert(schema.member).values({
        id: newId(),
        organizationId: other.workspaceId,
        userId,
        role: 'agent',
        createdAt: new Date(),
      })
      const response = await accept(token, { password: 'pw-takeover-1234' })
      expect(response.status).toBe(409)
      expect((await response.json()).code).toBe('reset_requires_platform')
    } finally {
      await ctx.db.delete(schema.member).where(eq(schema.member.organizationId, other.workspaceId))
      await other.cleanup()
    }
  })

  test('is refused once the account administers the platform', async () => {
    const { userId, token } = await joinAndIssueReset()
    await ctx.db.insert(schema.platformAdmins).values({ userId, grantedByUserId: null })
    try {
      expect((await accept(token, { password: 'pw-takeover-1234' })).status).toBe(409)
    } finally {
      await ctx.db.delete(schema.platformAdmins).where(eq(schema.platformAdmins.userId, userId))
    }
  })

  test('is refused once the person has left the workspace', async () => {
    const { userId, token } = await joinAndIssueReset()
    await ctx.db.delete(schema.member).where(eq(schema.member.userId, userId))
    expect((await accept(token, { password: 'pw-takeover-1234' })).status).toBe(409)
  })
})

describe('accepting two invitations at once', () => {
  /** Recommendation #14: one membership, whichever link wins. */
  test('leaves one membership', async () => {
    const email = `twice-${Math.random().toString(36).slice(2, 10)}@example.com`
    const first = await json(await invite(email, 'agent'))
    const { userId } = await (
      await accept(tokenOf(first.link), { name: 'Twice', password: 'pw-twice-1234' })
    ).json()
    strays.push(userId)
    // Leave the workspace, then accept two fresh links together.
    await ctx.db.delete(schema.member).where(eq(schema.member.userId, userId))
    const cookie = await signInAs(app, {
      email,
      password: 'pw-twice-1234',
      origin: env.PUBLIC_WEB_URL,
    })
    const a = await json(await invite(email, 'agent'))
    // A second live link: issued directly, since issuing through the route revokes the first.
    const { issueInvitation, INVITE_TTL_MS } = await import('@ci/infra')
    const b = await issueInvitation(ctx.db, {
      workspaceId: fixture.workspaceId,
      purpose: 'invite',
      email: `${email.toUpperCase()}`,
      role: 'agent',
      ttlMs: INVITE_TTL_MS,
    })
    await Promise.all([accept(tokenOf(a.link), {}, cookie), accept(b.token, {}, cookie)])
    const rows = await ctx.db
      .select({ id: schema.member.id })
      .from(schema.member)
      .where(eq(schema.member.userId, userId))
    expect(rows).toHaveLength(1)
  })
})
