import { loadEnv } from '@ci/config'
import { createApp } from './app'
import { createApiContext } from './context'

const env = loadEnv()
const ctx = createApiContext(env)
const app = createApp(ctx)

app.listen(env.API_PORT)

ctx.runtime.logger.info('api started', {
  port: env.API_PORT,
  url: env.PUBLIC_API_URL,
})

const shutdown = async (signal: string) => {
  ctx.runtime.logger.info('shutting down', { signal })
  await app.stop()
  await ctx.runtime.close()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
