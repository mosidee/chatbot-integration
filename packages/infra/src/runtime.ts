import { type Env, loadEnv } from '@ci/config'
import type { BlobStore, FetchLike, Logger } from '@ci/core'
import { createDb, type Database } from '@ci/db'
import type { Redis } from 'ioredis'
import { createBlobStore } from './blob'
import { createFilesystemBlobStore } from './blob-fs'
import { createRestrictedFetch } from './egress'
import { createLogger } from './logger'
import { createOutbox, type Outbox } from './outbox'
import { createPublisher } from './publisher'
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
  /**
   * How work is asked for.
   *
   * Writes a row in the caller's own transaction; the worker's relay moves it to BullMQ
   * afterwards. There is deliberately no `queues` here to reach past it with: the rule that
   * nothing but the relay talks to the queue is worth more as something the types refuse
   * than as something a comment asks for. The worker builds its own queues for the relay
   * and its workers, because it is the one process that has to. See ADR 0006.
   */
  outbox: Outbox
  blob: BlobStore
  /** The client tenant-defined tools are fetched through. Restricted; see `egress.ts`. */
  toolFetch: FetchLike
  /**
   * The client model providers and external retrieval are fetched through, for a tenant.
   *
   * Restricted like `toolFetch`, since a tenant admin types these URLs too, except that the
   * origins given are reachable although private or plain http: a self-hosted gateway on the
   * operator's network is a legitimate configuration, but only a platform admin may approve
   * one, per tenant (`workspaces.private_egress_origins`). Use `workspaceProviderFetch`
   * rather than calling this with a list of your own. The same list returns the same client,
   * which the model caches in `packages/core` are keyed on.
   */
  providerFetch: (allowedOrigins: readonly string[]) => FetchLike
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
      'TOOL_EGRESS_ALLOW_PRIVATE must not be set in production: it would let any URL a tenant types — a tool, a provider, a retrieval endpoint — reach Postgres, Redis, MinIO and the model gateway. Approve a private gateway for one tenant from the Platform page instead.',
    )
  }

  const { db, close: closeDb } = createDb(env.DATABASE_URL)
  const redis = createRedis(env.REDIS_URL, { forQueue: true })

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
  const providerClients = new Map<string, FetchLike>()

  return {
    env,
    queuePrefix: options.queuePrefix,
    db,
    redis,
    subscriberFactory: () => createRedis(env.REDIS_URL),
    outbox: createOutbox(),
    blob,
    toolFetch: createRestrictedFetch({ allowPrivate: allowPrivateEgress }),
    providerFetch: (allowedOrigins) => {
      const key = [...allowedOrigins].sort().join(' ')
      let client = providerClients.get(key)
      if (!client) {
        client = createRestrictedFetch({ allowPrivate: allowPrivateEgress, allowedOrigins })
        providerClients.set(key, client)
      }
      return client
    },
    publisher,
    logger,
    close: async () => {
      await Promise.allSettled([redis.quit(), closeDb()])
    },
  }
}
