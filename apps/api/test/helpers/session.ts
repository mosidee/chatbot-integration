import { createWorkspace, newId, schema } from '@ci/db'
import type { UserRoleName } from '@ci/shared'
import { eq, inArray } from 'drizzle-orm'
import type { App } from '../../src/app'
import type { ApiContext } from '../../src/context'

/**
 * Signing in, in process.
 *
 * Until now nothing here had a session: every API test called an endpoint with no cookie
 * and asserted 401, so the role gate itself — the 403 that separates an agent from an
 * admin — was never exercised anywhere but in the browser, and only as the seeded admin.
 *
 * The sign-in goes through `app.handle` rather than Better Auth's api object, because the
 * cookie a real browser gets is the one the HTTP layer sets, and that is the thing worth
 * asserting against. The cookie's name is the same whatever `NODE_ENV` says: Better Auth
 * decides on secure cookies from the base URL's protocol, and these tests speak http to
 * localhost either way.
 */

/** Accounts are created through the sign-up instance, the one the public API never mounts. */
export async function createUser(
  ctx: ApiContext,
  input: { email: string; password: string; name?: string },
): Promise<{ userId: string }> {
  const created = await ctx.authSignUp.api.signUpEmail({
    body: { email: input.email, password: input.password, name: input.name ?? 'Test User' },
  })
  return { userId: created.user.id }
}

/**
 * A cookie header, as a browser would send it back.
 *
 * The origin header is set because Better Auth checks it against `trustedOrigins`, and a
 * request built by hand has none.
 */
export async function signInAs(
  app: App,
  input: { email: string; password: string; origin: string },
): Promise<string> {
  const response = await app.handle(
    new Request('http://localhost/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: input.origin },
      body: JSON.stringify({ email: input.email, password: input.password }),
    }),
  )
  if (response.status !== 200) {
    throw new Error(
      `sign-in failed for ${input.email}: ${response.status} ${await response.text()}`,
    )
  }
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ')
}

export type ApiActor = {
  userId: string
  email: string
  cookie: string
}

export type ApiFixture = {
  workspaceId: string
  slug: string
  admin: ApiActor
  agent: ApiActor
  viewer: ApiActor
  /** Call an endpoint as one of them. */
  as: (actor: ApiActor | null, path: string, init?: RequestInit) => Promise<Response>
  /** Everything this fixture created, so a failed test does not poison the next one. */
  cleanup: () => Promise<void>
}

/**
 * A workspace with one person in each role.
 *
 * Built through `createWorkspace`, so the tenant a test asserts against is the same shape a
 * platform admin creates, channels included.
 */
export async function createApiFixture(ctx: ApiContext, app: App): Promise<ApiFixture> {
  const token = newId().slice(0, 8)
  const slug = `api-test-${token}`
  const { workspaceId } = await createWorkspace(ctx.db, { name: slug, slug })

  const password = 'test-password-12345'
  const actors: Record<UserRoleName, ApiActor> = {} as Record<UserRoleName, ApiActor>

  for (const role of ['admin', 'agent', 'viewer'] as const) {
    const email = `${role}-${token}@example.com`
    const { userId } = await createUser(ctx, { email, password, name: `Test ${role}` })
    await ctx.db.insert(schema.member).values({
      id: newId(),
      organizationId: workspaceId,
      userId,
      role,
      createdAt: new Date(),
    })
    const cookie = await signInAs(app, { email, password, origin: ctx.env.PUBLIC_WEB_URL })
    actors[role] = { userId, email, cookie }
  }

  const userIds = Object.values(actors).map((actor) => actor.userId)

  return {
    workspaceId,
    slug,
    admin: actors.admin,
    agent: actors.agent,
    viewer: actors.viewer,
    as: (actor, path, init) =>
      app.handle(
        new Request(`http://localhost${path}`, {
          ...init,
          headers: {
            ...(init?.body ? { 'content-type': 'application/json' } : {}),
            ...(init?.headers as Record<string, string> | undefined),
            ...(actor ? { cookie: actor.cookie } : {}),
            origin: ctx.env.PUBLIC_WEB_URL,
          },
        }),
      ),
    cleanup: async () => {
      // The organization cascades to the workspace and everything under it; the users are
      // Better Auth's and have to go by hand.
      await ctx.db.delete(schema.organization).where(eq(schema.organization.id, workspaceId))
      await ctx.db.delete(schema.user).where(inArray(schema.user.id, userIds))
    },
  }
}
