import { schema } from '@ci/db'
import { foreignStorageKey, ingestInternal } from '@ci/infra'
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

        // Refused here rather than in the worker, so the caller is told. `storeMessage`
        // refuses it again downstream; this is the same rule, answered in the request.
        if (foreignStorageKey(workspaceId, body.message)) {
          return status(400, { error: 'Attachment does not belong to this workspace' })
        }

        /**
         * Internal ingestion: the caller is an agent with a console session, checked by the
         * guard on this route, not a platform with a signature. The test adapter has no
         * signature to offer and the public webhook route no longer serves it.
         */
        const outcome = await ingestInternal(runtime, db, {
          channelId: params.channelId,
          expectedType: 'test',
          body,
        })

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
