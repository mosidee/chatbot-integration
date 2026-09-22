import { schema } from '@ci/db'
import { ingestWebhook, toWebhookRequest } from '@ci/infra'
import { eq } from 'drizzle-orm'
import Elysia from 'elysia'
import { z } from 'zod'
import type { ApiContext } from '../context'

/**
 * The public webhook endpoint.
 *
 * One route serves every channel: the adapter registered for the channel's type decides
 * how to verify and parse. LINE and Messenger plug in at M3 without this file changing.
 *
 * Unauthenticated by design — the platform is the caller, and the adapter's signature
 * check is what establishes trust.
 */
export function webhookRoutes(ctx: ApiContext) {
  const { db, runtime } = ctx

  return (
    new Elysia({ prefix: '/webhooks' })
      /** Meta's subscription handshake echoes a challenge back. */
      .get(
        '/:channelId',
        async ({ params, query, status }) => {
          const rows = await db
            .select()
            .from(schema.channels)
            .where(eq(schema.channels.id, params.channelId))
            .limit(1)
          const channel = rows[0]
          if (!channel) return status(404, { error: 'Unknown channel' })

          const challenge = query['hub.challenge']
          const verifyToken = query['hub.verify_token']
          if (challenge && verifyToken && verifyToken === channel.webhookSecret) {
            return new Response(challenge, { headers: { 'content-type': 'text/plain' } })
          }
          return status(403, { error: 'Verification failed' })
        },
        {
          params: z.object({ channelId: z.string() }),
          query: z.record(z.string(), z.string()).optional(),
        },
      )

      .post(
        '/:channelId',
        async ({ params, request, headers, query, status }) => {
          const rawBody = await request.text()
          const outcome = await ingestWebhook(
            runtime,
            db,
            params.channelId,
            toWebhookRequest(rawBody, headers, query ?? {}),
          )

          if (!outcome.ok) {
            runtime.logger.warn('webhook rejected', {
              channelId: params.channelId,
              reason: outcome.reason,
            })

            /**
             * A suspended tenant acknowledges and drops.
             *
             * Answering with an error would be the honest-looking thing to do and the wrong
             * one: LINE and Meta disable an endpoint that keeps failing, so a suspension of
             * a few days would cost the operator their webhook registration and a support
             * conversation to get it back. The message is discarded either way, and this way
             * the channel still works the moment the tenant is restored.
             */
            if (outcome.reason === 'workspace_suspended') {
              return { received: true, dropped: true }
            }

            // A wrong signature gets 401; an unknown channel gets 404. Neither is retried
            // usefully by the platform, and neither leaks whether a channel exists.
            return outcome.reason === 'invalid_signature'
              ? status(401, { error: 'Invalid signature' })
              : status(404, { error: 'Unknown channel' })
          }

          // Always 200 quickly: the work happens in the worker.
          return { received: true, duplicate: outcome.duplicate }
        },
        {
          params: z.object({ channelId: z.string() }),
          query: z.record(z.string(), z.string()).optional(),
        },
      )
  )
}
