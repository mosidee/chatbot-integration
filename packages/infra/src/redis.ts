import { Redis } from 'ioredis'

/**
 * Redis connections.
 *
 * BullMQ v6 supports several drivers; ioredis is the battle-tested one and the plan
 * anticipated this swap. `maxRetriesPerRequest: null` is required by BullMQ workers,
 * which hold blocking connections.
 *
 * Pub/sub needs its own connection because a subscribed client cannot issue other
 * commands, so callers get separate publisher and subscriber instances.
 */
export function createRedis(url: string, options: { forQueue?: boolean } = {}): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: options.forQueue ? null : 3,
    enableReadyCheck: true,
    lazyConnect: false,
  })
}
