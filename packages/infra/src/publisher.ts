import { redisWsChannel, type WsEvent } from '@ci/shared'
import type { Redis } from 'ioredis'

/**
 * Realtime fan-out over Redis pub/sub.
 *
 * Every API replica subscribes to the workspace channel and forwards events to its own
 * connected sockets, so the agent GUI stays live whatever the replica count. This is the
 * piece that lets the deployment scale horizontally without sticky sessions.
 */

export function createPublisher(redis: Redis) {
  return {
    async publish(workspaceId: string, event: WsEvent): Promise<void> {
      await redis.publish(redisWsChannel(workspaceId), JSON.stringify(event))
    },
  }
}

export type WorkspaceSubscriber = {
  close: () => Promise<void>
}

/**
 * Subscribe to one workspace's event stream.
 * The caller supplies its own Redis connection because a subscribed client cannot issue
 * other commands.
 */
export async function subscribeToWorkspace(
  subscriber: Redis,
  workspaceId: string,
  onEvent: (event: WsEvent) => void,
): Promise<WorkspaceSubscriber> {
  const channel = redisWsChannel(workspaceId)

  const handler = (incoming: string, payload: string) => {
    if (incoming !== channel) return
    try {
      onEvent(JSON.parse(payload) as WsEvent)
    } catch {
      // A malformed payload must not take the socket down.
    }
  }

  subscriber.on('message', handler)
  await subscriber.subscribe(channel)

  return {
    close: async () => {
      subscriber.off('message', handler)
      await subscriber.unsubscribe(channel)
    },
  }
}
