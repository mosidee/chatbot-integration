import { schema } from '@ci/db'
import { ingestWebhook, toWebhookRequest } from '@ci/infra'
import { normalizedMessageSchema } from '@ci/shared'
import { and, eq } from 'drizzle-orm'
import Elysia from 'elysia'
import { z } from 'zod'
import { authPlugin } from '../auth-plugin'
import type { ApiContext } from '../context'

/**
 * The simulator: act as a customer without a platform account.
 *
 * It feeds the very same ingestion path a real webhook takes, so what is exercised here is
 * the real pipeline rather than a test-only shortcut. This is how the AI loop, handoff and
 * suggestions are developed without a phone, a tunnel or Meta's review queue.
 */
export function simulatorRoutes(ctx: ApiContext) {
  const { db, runtime } = ctx

  return new Elysia({ prefix: '/simulator' })
    .use(authPlugin(ctx))

    .get(
      '/channels',
      async ({ workspaceId }) => {
        const rows = await db
          .select()
          .from(schema.channels)
          .where(
            and(eq(schema.channels.workspaceId, workspaceId), eq(schema.channels.type, 'test')),
          )
        return { channels: rows.map((r) => ({ id: r.id, name: r.name })) }
      },
      { auth: 'agent' },
    )

    .post(
      '/:channelId/inbound',
      async ({ workspaceId, params, body, status }) => {
        const rows = await db
          .select()
          .from(schema.channels)
          .where(
            and(
              eq(schema.channels.id, params.channelId),
              eq(schema.channels.workspaceId, workspaceId),
            ),
          )
          .limit(1)

        const channel = rows[0]
        if (!channel) return status(404, { error: 'Unknown channel' })
        if (channel.type !== 'test') {
          return status(400, { error: 'The simulator only drives test channels' })
        }

        const outcome = await ingestWebhook(
          runtime,
          db,
          params.channelId,
          toWebhookRequest(JSON.stringify(body), {}, {}),
        )

        if (!outcome.ok) return status(400, { error: outcome.reason })
        return { received: true, duplicate: outcome.duplicate }
      },
      {
        auth: 'agent',
        params: z.object({ channelId: z.string() }),
        body: z.object({
          externalId: z.string().min(1),
          message: normalizedMessageSchema,
          eventId: z.string().optional(),
          displayName: z.string().optional(),
        }),
      },
    )
}
