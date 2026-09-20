import { type Env, loadEnv } from '@ci/config'
import type { Logger } from '@ci/core'
import { createDb, type Database } from '@ci/db'
import type { Redis } from 'ioredis'
import { createBlobStore } from './blob'
import { createLogger } from './logger'
import { createPublisher } from './publisher'
import { createQueues, type Queues } from './queues'
import { createRedis } from './redis'

/**
 * The shared runtime both the API and the worker build at startup.
 *
 * Constructing it in one place keeps connection settings identical across processes and
 * gives every module one object to depend on rather than a widening parameter list.
 */
export type Runtime = {
  env: Env
  db: Database
  redis: Redis
  /** Separate connection: a subscribed client cannot issue other commands. */
  subscriberFactory: () => Redis
  queues: Queues
  blob: ReturnType<typeof createBlobStore>
  publisher: ReturnType<typeof createPublisher>
  logger: Logger
  close: () => Promise<void>
}

export function createRuntime(service: string, env: Env = loadEnv()): Runtime {
  const logger = createLogger(service, env.NODE_ENV === 'production' ? 'info' : 'debug')

  const { db, close: closeDb } = createDb(env.DATABASE_URL)
  const redis = createRedis(env.REDIS_URL, { forQueue: true })
  const queues = createQueues(redis)

  const blob = createBlobStore({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    publicUrl: env.S3_PUBLIC_URL,
  })

  const publisher = createPublisher(redis)

  return {
    env,
    db,
    redis,
    subscriberFactory: () => createRedis(env.REDIS_URL),
    queues,
    blob,
    publisher,
    logger,
    close: async () => {
      await Promise.allSettled([
        ...Object.values(queues).map((q) => q.close()),
        redis.quit(),
        closeDb(),
      ])
    },
  }
}
