import { newId, schema } from '@ci/db'
import { loadWorkspaceSettings, sendTestPush, vapidKeys, vapidSubject } from '@ci/infra'
import { isPushServiceEndpoint, pushSubscriptionSchema } from '@ci/shared'
import { and, eq } from 'drizzle-orm'
import Elysia from 'elysia'
import { z } from 'zod'
import { authPlugin } from '../auth-plugin'
import type { ApiContext } from '../context'

const endpointBody = z.object({
  endpoint: z.string().max(2048).refine(isPushServiceEndpoint, 'not a push service'),
})

/**
 * Notifications on agents' devices (ADR 0010).
 *
 * Per person and per device, not a workspace setting: it lives beside the settings PATCH
 * rather than inside it, and nobody's choice here is a conflict with anybody else's.
 */
export function pushRoutes(ctx: ApiContext) {
  const { db, env } = ctx
  const vapid = vapidKeys(env)

  return (
    new Elysia({ prefix: '/push' })
      .use(authPlugin(ctx))

      /** The key a browser subscribes with, or null when this installation has no push. */
      .get('/config', () => ({ publicKey: vapid?.publicKey ?? null }), { auth: 'viewer' })

      /** Whether this device is subscribed to this workspace, as far as the server knows. */
      .post(
        '/check',
        async ({ workspaceId, user, body }) => {
          const rows = await db
            .select({ id: schema.pushSubscriptions.id })
            .from(schema.pushSubscriptions)
            .where(
              and(
                eq(schema.pushSubscriptions.workspaceId, workspaceId),
                eq(schema.pushSubscriptions.userId, user.id),
                eq(schema.pushSubscriptions.endpoint, body.endpoint),
              ),
            )
            .limit(1)
          return { subscribed: rows.length > 0 }
        },
        { auth: 'viewer', body: endpointBody },
      )

      /**
       * Agents and admins only: a viewer cannot answer, so would only be woken for nothing.
       * One device is one endpoint, so a phone handed to a colleague who signs in and
       * subscribes becomes theirs rather than notifying both.
       */
      .post(
        '/subscriptions',
        async ({ workspaceId, user, body, status }) => {
          if (!vapid) return status(404, { error: 'Push is not configured' })
          await db
            .insert(schema.pushSubscriptions)
            .values({
              id: newId(),
              workspaceId,
              userId: user.id,
              endpoint: body.endpoint,
              p256dh: body.keys.p256dh,
              auth: body.keys.auth,
            })
            .onConflictDoUpdate({
              target: [schema.pushSubscriptions.workspaceId, schema.pushSubscriptions.endpoint],
              set: { userId: user.id, p256dh: body.keys.p256dh, auth: body.keys.auth },
            })
          return { subscribed: true }
        },
        { auth: 'agent', body: pushSubscriptionSchema },
      )

      /**
       * Stop this device. `everywhere` is signing out: the device leaves every workspace
       * this person turned it on in. That reaches past the workspace in scope, which is
       * safe only because it is bounded by the caller's own user id and the endpoint their
       * own browser holds.
       */
      .delete(
        '/subscriptions',
        async ({ workspaceId, user, body }) => {
          await db
            .delete(schema.pushSubscriptions)
            .where(
              and(
                eq(schema.pushSubscriptions.userId, user.id),
                eq(schema.pushSubscriptions.endpoint, body.endpoint),
                body.everywhere ? undefined : eq(schema.pushSubscriptions.workspaceId, workspaceId),
              ),
            )
          return { subscribed: false }
        },
        {
          auth: 'viewer',
          body: endpointBody.extend({ everywhere: z.boolean().optional() }),
        },
      )

      .post(
        '/test',
        async ({ workspaceId, user, body, status }) => {
          if (!vapid) return status(404, { error: 'Push is not configured' })
          const settings = await loadWorkspaceSettings(db, workspaceId)
          const result = await sendTestPush(
            { db, vapid, subject: vapidSubject(env), logger: ctx.runtime.logger },
            {
              workspaceId,
              userId: user.id,
              endpoint: body.endpoint,
              language: settings.defaultLanguage === 'en' ? 'en' : 'th',
            },
          )
          return { result }
        },
        { auth: 'agent', body: endpointBody },
      )
  )
}
