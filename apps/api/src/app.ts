import cors from '@elysiajs/cors'
import openapi from '@elysiajs/openapi'
import Elysia from 'elysia'
import { authHandler } from './auth-plugin'
import type { ApiContext } from './context'
import { conversationRoutes } from './routes/conversations'
import { settingsRoutes } from './routes/settings'
import { simulatorRoutes } from './routes/simulator'
import { traceRoutes } from './routes/traces'
import { webhookRoutes } from './routes/webhooks'
import { createWsRoutes } from './ws'

/**
 * The HTTP surface.
 *
 * Deliberately thin: routes validate input, call into core or the repository, and return.
 * No domain rule lives here, which is what keeps the port to another runtime a matter of
 * swapping this layer.
 */
export function createApp(ctx: ApiContext) {
  const { env } = ctx

  return new Elysia()
    .use(
      cors({
        origin: [env.PUBLIC_WEB_URL],
        credentials: true,
      }),
    )
    .use(openapi({ path: '/api/openapi' }))

    .get('/healthz', async () => {
      const [dbOk, redisOk] = await Promise.all([
        ctx.db
          .execute('select 1')
          .then(() => true)
          .catch(() => false),
        ctx.runtime.redis
          .ping()
          .then(() => true)
          .catch(() => false),
      ])
      const healthy = dbOk && redisOk
      return new Response(
        JSON.stringify({ status: healthy ? 'ok' : 'degraded', db: dbOk, redis: redisOk }),
        {
          status: healthy ? 200 : 503,
          headers: { 'content-type': 'application/json' },
        },
      )
    })

    // Better Auth owns /api/auth/*; mounted at the root so its paths are not prefixed.
    .use(authHandler(ctx))

    .use(createWsRoutes(ctx))

    .group('/api/v1', (app) =>
      app
        .use(conversationRoutes(ctx))
        .use(simulatorRoutes(ctx))
        .use(settingsRoutes(ctx))
        .use(traceRoutes(ctx))
        .use(webhookRoutes(ctx)),
    )

    .onError(({ code, error, set }) => {
      if (code === 'VALIDATION') {
        set.status = 422
        return { error: 'Validation failed', detail: String(error) }
      }
      if (code === 'NOT_FOUND') {
        set.status = 404
        return { error: 'Not found' }
      }
      ctx.runtime.logger.error('unhandled request error', {
        code,
        error: error instanceof Error ? error.message : String(error),
      })
      set.status = 500
      return { error: 'Internal error' }
    })
}

export type App = ReturnType<typeof createApp>
