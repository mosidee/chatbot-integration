import Elysia from 'elysia'
import type { ApiContext, Membership } from './context'
import { resolveMembership } from './context'

/**
 * Session authentication and role enforcement.
 *
 * Exposed as a macro so a route declares `auth: 'agent'` and receives a resolved user and
 * workspace. Every handler then scopes its queries by that workspace id; there is no
 * ambient tenant.
 */

const RANK = { viewer: 0, agent: 1, admin: 2 } as const

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

export function authPlugin(ctx: ApiContext) {
  return new Elysia({ name: 'auth' })
    .macro({
      auth: (minimumRole: 'viewer' | 'agent' | 'admin') => ({
        async resolve({
          status,
          request,
        }: {
          status: (code: number, body?: unknown) => unknown
          request: Request
        }) {
          const session = await ctx.auth.api.getSession({ headers: request.headers })
          if (!session) return status(401, { error: 'Not signed in' }) as never

          const membership = await resolveMembership(
            ctx.db,
            session.user.id,
            (session.session as { activeOrganizationId?: string | null }).activeOrganizationId,
          )
          if (!membership) return status(403, { error: 'No workspace membership' }) as never

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
    })
    .as('global')
}
