import { schema } from '@ci/db'
import { and, desc, eq } from 'drizzle-orm'
import Elysia from 'elysia'
import { z } from 'zod'
import { authPlugin } from '../auth-plugin'
import type { ApiContext } from '../context'

/**
 * AI traces: the exact prompt, tool calls, model, tokens, latency and cost behind any
 * reply. This is the debugging tool for everything the AI does, and the evidence behind
 * the cost figures an agent sees in the sidebar.
 */
export function traceRoutes(ctx: ApiContext) {
  const { db } = ctx

  return new Elysia({ prefix: '/ai-traces' })
    .use(authPlugin(ctx))

    .get(
      '/:id',
      async ({ workspaceId, params, status }) => {
        const rows = await db
          .select()
          .from(schema.aiTraces)
          .where(
            and(eq(schema.aiTraces.id, params.id), eq(schema.aiTraces.workspaceId, workspaceId)),
          )
          .limit(1)
        const trace = rows[0]
        if (!trace) return status(404, { error: 'Trace not found' })
        return { trace }
      },
      { auth: 'agent', params: z.object({ id: z.string() }) },
    )

    .get(
      '/',
      async ({ workspaceId, query }) => {
        const filters = [eq(schema.aiTraces.workspaceId, workspaceId)]
        if (query.conversationId) {
          filters.push(eq(schema.aiTraces.conversationId, query.conversationId))
        }
        const rows = await db
          .select()
          .from(schema.aiTraces)
          .where(and(...filters))
          .orderBy(desc(schema.aiTraces.createdAt))
          .limit(query.limit ?? 50)
        return { traces: rows }
      },
      {
        auth: 'agent',
        query: z.object({
          conversationId: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      },
    )
}
