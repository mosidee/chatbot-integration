import cors from '@elysiajs/cors'
import openapi from '@elysiajs/openapi'
import Elysia from 'elysia'
import { authHandler } from './auth-plugin'
import type { ApiContext } from './context'
import { conversationRoutes } from './routes/conversations'
import { dashboardRoutes } from './routes/dashboard'
import { knowledgeRoutes } from './routes/knowledge'
import { settingsRoutes } from './routes/settings'
import { simulatorRoutes } from './routes/simulator'
import { traceRoutes } from './routes/traces'
import { uploadRoutes } from './routes/uploads'
import { webhookRoutes } from './routes/webhooks'
import { widgetRoutes } from './routes/widget'
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

  return (
    new Elysia()
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

      // Public, and deliberately outside /api/v1: the widget's contract is with embedded
      // browsers rather than with the console, and versioning them together would tie a
      // customer's page to our internal changes.
      .group('/api/widget', (app) => app.use(widgetRoutes(ctx)))

      .group('/api/v1', (app) =>
        app
          .use(conversationRoutes(ctx))
          .use(dashboardRoutes(ctx))
          .use(simulatorRoutes(ctx))
          .use(settingsRoutes(ctx))
          .use(knowledgeRoutes(ctx))
          .use(traceRoutes(ctx))
          .use(uploadRoutes(ctx))
          .use(webhookRoutes(ctx)),
      )

      .onError(async ({ code, error, set, request }) => {
        if (code === 'VALIDATION') {
          set.status = 422
          return { error: 'Validation failed', detail: String(error) }
        }

        if (code === 'NOT_FOUND') {
          /**
           * The single-page app is served from here rather than from a `/*` route.
           *
           * A wildcard route shadows Elysia's `.mount()`, so every GET to the mounted auth
           * handler returned 404 while POST worked. That broke the browser's session check
           * and would have broken OAuth callbacks, which are GETs. Serving the shell only
           * once nothing else matched leaves every real route intact.
           */
          const url = new URL(request.url)
          const isApi = url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')

          /**
           * The widget is served in every environment, not only production.
           *
           * Unlike the console, nothing else serves it during development: there is no Vite
           * dev server in front of it, and the browser tests embed it from this origin. It
           * is a built artefact either way, so serving it from disk is the same operation
           * whichever environment we are in.
           */
          if (url.pathname.startsWith('/widget')) {
            const root = `${process.cwd()}/apps/widget/dist`
            const requested = url.pathname.replace(/^\/widget\/?/, '') || 'index.html'
            const asset = Bun.file(`${root}/${requested}`)
            if (await asset.exists()) return new Response(asset)

            const shell = Bun.file(`${root}/index.html`)
            if (await shell.exists()) {
              return new Response(shell, { headers: { 'content-type': 'text/html' } })
            }
            return new Response('The widget has not been built. Run bun run build:widget.', {
              status: 404,
              headers: { 'content-type': 'text/plain' },
            })
          }

          if (env.NODE_ENV === 'production' && !isApi) {
            const root = `${process.cwd()}/apps/web/dist`
            const asset = Bun.file(`${root}${url.pathname}`)
            if (url.pathname !== '/' && (await asset.exists())) return new Response(asset)

            // Any other path is a client route; hand back the shell.
            return new Response(Bun.file(`${root}/index.html`), {
              headers: { 'content-type': 'text/html' },
            })
          }

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
  )
}

export type App = ReturnType<typeof createApp>
