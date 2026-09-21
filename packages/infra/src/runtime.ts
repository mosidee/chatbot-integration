import { type Env, loadEnv } from '@ci/config'
import type { BlobStore, FetchLike, Logger } from '@ci/core'
import { createDb, type Database } from '@ci/db'
import type { Redis } from 'ioredis'
import { createBlobStore } from './blob'
import { createFilesystemBlobStore } from './blob-fs'
import { createRestrictedFetch } from './egress'
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
  /** Set when queues are namespaced; workers must use the same prefix. */
  queuePrefix?: string | undefined
  db: Database
  redis: Redis
  /** Separate connection: a subscribed client cannot issue other commands. */
  subscriberFactory: () => Redis
  queues: Queues
  blob: BlobStore
  /**
   * The client tenant-defined tools are fetched through. Restricted on purpose; see
   * `egress.ts`. Provider and retrieval calls keep the plain `fetch`, because a self-hosted
   * gateway on a private address is a legitimate operator configuration.
   */
  toolFetch: FetchLike
  publisher: ReturnType<typeof createPublisher>
  logger: Logger
  close: () => Promise<void>
}

export type RuntimeOptions = {
  /** Namespaces all queue keys in Redis. Tests use it to isolate fixtures. */
  queuePrefix?: string
  /** Overrides the env flag, so an integration test can reach its own local endpoint. */
  allowPrivateEgress?: boolean
}

export function createRuntime(
  service: string,
  env: Env = loadEnv(),
  options: RuntimeOptions = {},
): Runtime {
  const logger = createLogger(service, env.NODE_ENV === 'production' ? 'info' : 'debug')

  const allowPrivateEgress = options.allowPrivateEgress ?? env.TOOL_EGRESS_ALLOW_PRIVATE
  if (allowPrivateEgress && env.NODE_ENV === 'production') {
    // The same refusal `db:reset` makes, for the same reason: this is a switch that is
    // harmless locally and hands the internal network to any tenant admin in production.
    throw new Error(
      'TOOL_EGRESS_ALLOW_PRIVATE must not be set in production: it would let a tenant-defined tool reach Postgres, Redis, MinIO and the model gateway.',
    )
  }

  const { db, close: closeDb } = createDb(env.DATABASE_URL)
  const redis = createRedis(env.REDIS_URL, { forQueue: true })
  const queues = createQueues(redis, options.queuePrefix)

  // A file:// endpoint selects filesystem storage, which local development on macOS needs;
  // see packages/infra/src/blob-fs.ts. Anything else is treated as S3-compatible.
  const blob = env.S3_ENDPOINT.startsWith('file://')
    ? createFilesystemBlobStore(
        env.S3_ENDPOINT.slice('file://'.length),
        env.S3_PUBLIC_URL ?? '/api/v1/uploads',
      )
    : createBlobStore({
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
    queuePrefix: options.queuePrefix,
    db,
    redis,
    subscriberFactory: () => createRedis(env.REDIS_URL),
    queues,
    blob,
    toolFetch: createRestrictedFetch({ allowPrivate: allowPrivateEgress }),
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
