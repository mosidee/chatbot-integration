import { isPlatformAdmin } from '@ci/db'
import type { UserRoleName } from '@ci/shared'
import Elysia from 'elysia'
import type { ApiContext, Membership } from './context'
import { chooseMembership, loadMemberships } from './context'

/**
 * Session authentication and role enforcement.
 *
 * Three guards, because there are three different questions to ask about a caller:
 *
 *  - `auth: 'agent'` — who are you, which workspace, and may you do this in it? The
 *    workspace has to be usable, so a suspended tenant is refused here rather than in each
 *    of ninety handlers.
 *  - `session: true` — who are you, in no particular workspace? Used by the one endpoint
 *    that has to answer while every workspace you belong to is suspended, which is the
 *    endpoint that tells the console so.
 *  - `platform: true` — may you manage tenants? Deliberately no workspace at all: a
 *    platform admin's authority is over tenants, not inside one.
 *
 * Each guard resolves its own shape and nothing wider. In particular `session` and
 * `platform` do not resolve a workspace at all, rather than resolving an optional one: an
 * optional `workspaceId` in scope is exactly the ambient tenant this codebase refuses to
 * have, and it would typecheck everywhere it was forgotten.
 */

const RANK: Record<UserRoleName, number> = { viewer: 0, agent: 1, admin: 2 }

export type AuthedUser = {
  id: string
  email: string
  name: string
}

/**
 * Better Auth's own routes.
 *
 * Routed explicitly rather than with `.mount()`. A bare mount attaches at the root and then
 * receives every request Elysia did not match, answering with its own 404 — which meant the
 * console could not be served at all once the wildcard route that had been hiding the
 * problem was removed. Matching `/api/auth/*` keeps it to its own territory, and the handler
 * still receives the untouched request, so the paths it expects are intact.
 */
export function authHandler(ctx: ApiContext) {
  return new Elysia({ name: 'auth-handler' }).all('/api/auth/*', ({ request }) =>
    ctx.auth.handler(request),
  )
}

type StatusFn = (code: number, body?: unknown) => unknown

type SessionFacts = { user: AuthedUser; activeOrganizationId: string | null }

async function sessionFor(ctx: ApiContext, request: Request): Promise<SessionFacts | null> {
  const session = await ctx.auth.api.getSession({ headers: request.headers })
  if (!session) return null
  return {
    user: { id: session.user.id, email: session.user.email, name: session.user.name },
    activeOrganizationId:
      (session.session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null,
  }
}

/**
 * What a workspace that is not active says, and the code the console branches on.
 *
 * A message rather than a bare 403 because the person is not doing anything wrong and there
 * is nothing for them to fix: somebody with authority over the tenant did this.
 */
export function workspaceRefusal(status: Membership['status']): { error: string; code: string } {
  return status === 'suspended'
    ? { error: 'This workspace is suspended', code: 'workspace_suspended' }
    : { error: 'This workspace is being deleted', code: 'workspace_deleting' }
}

export function authPlugin(ctx: ApiContext) {
  return new Elysia({ name: 'auth' })
    .macro({
      auth: (minimumRole: UserRoleName) => ({
        async resolve({ status, request }: { status: StatusFn; request: Request }) {
          const session = await ctx.auth.api.getSession({ headers: request.headers })
          if (!session) return status(401, { error: 'Not signed in' }) as never

          const memberships = await loadMemberships(ctx.db, session.user.id)
          const membership = chooseMembership(
            memberships,
            (session.session as { activeOrganizationId?: string | null }).activeOrganizationId,
          )
          if (!membership) return status(403, { error: 'No workspace membership' }) as never

          // Before the role check on purpose. A suspended workspace is refused to its own
          // admin as much as to a viewer; the role is not the question.
          if (membership.status !== 'active') {
            return status(403, workspaceRefusal(membership.status)) as never
          }

          if (RANK[membership.role] < RANK[minimumRole]) {
            return status(403, { error: `Requires the ${minimumRole} role` }) as never
          }

          return {
            user: {
              id: session.user.id,
              email: session.user.email,
              name: session.user.name,
            } satisfies AuthedUser,
            membership: membership satisfies Membership,
            workspaceId: membership.workspaceId,
          }
        },
      }),

      /**
       * Signed in, and that is all that is asked.
       *
       * The parameter exists so a route reads `{ session: true }` rather than a bare key.
       * It is not branched on: a macro only runs for a route that names it, so returning an
       * empty object for `false` would do nothing but widen every handler's type until
       * `user` is no longer known to be there.
       */
      session: (_enabled: boolean) => ({
        async resolve({ status, request }: { status: StatusFn; request: Request }) {
          const facts = await sessionFor(ctx, request)
          if (!facts) return status(401, { error: 'Not signed in' }) as never
          return facts
        },
      }),

      /** Signed in, and holds a row in `platform_admins`. See `session` on the parameter. */
      platform: (_enabled: boolean) => ({
        async resolve({ status, request }: { status: StatusFn; request: Request }) {
          const facts = await sessionFor(ctx, request)
          if (!facts) return status(401, { error: 'Not signed in' }) as never

          if (!(await isPlatformAdmin(ctx.db, facts.user.id))) {
            return status(403, { error: 'Requires platform admin' }) as never
          }
          return { user: facts.user }
        },
      }),
    })
    .as('global')
}
