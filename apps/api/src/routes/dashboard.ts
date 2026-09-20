import { loadDashboard } from '@ci/infra'
import Elysia from 'elysia'
import { z } from 'zod'
import { authPlugin } from '../auth-plugin'
import type { ApiContext } from '../context'

/** The pilot's numbers. Readable by anyone who can read the inbox. */
export function dashboardRoutes(ctx: ApiContext) {
  return new Elysia({ prefix: '/dashboard' })
    .use(authPlugin(ctx))
    .get(
      '/',
      async ({ workspaceId, query }) =>
        loadDashboard(ctx.db, { workspaceId, days: query.days ?? 14 }),
      {
        auth: 'viewer',
        // Bounded on purpose: an unbounded window is a table scan somebody triggers by
        // editing the address bar.
        query: z.object({ days: z.coerce.number().int().min(1).max(90).optional() }),
      },
    )
}
