import { subscribeToWorkspace, type WorkspaceSubscriber } from '@ci/infra'
import type { WsEvent } from '@ci/shared'
import { wsClientMessageSchema } from '@ci/shared'
import Elysia from 'elysia'
import type { ApiContext } from './context'
import { resolveMembership } from './context'

/**
 * Realtime updates for the agent GUI.
 *
 * One Redis subscriber is shared by every socket watching the same workspace, rather than
 * one per connection: a busy inbox with a dozen agents open should cost one subscription,
 * not a dozen. Since each replica maintains its own, the deployment scales horizontally
 * without sticky sessions.
 */

type SocketLike = {
  send: (data: string) => unknown
  close: () => unknown
}

type WorkspaceRoom = {
  sockets: Set<SocketLike>
  subscriber: WorkspaceSubscriber
  close: () => Promise<void>
}

export function createWsRoutes(ctx: ApiContext) {
  const rooms = new Map<string, WorkspaceRoom>()
  const socketWorkspace = new WeakMap<object, string>()

  async function join(workspaceId: string, socket: SocketLike): Promise<void> {
    let room = rooms.get(workspaceId)

    if (!room) {
      const connection = ctx.runtime.subscriberFactory()
      const sockets = new Set<SocketLike>()
      const subscriber = await subscribeToWorkspace(connection, workspaceId, (event: WsEvent) => {
        const payload = JSON.stringify(event)
        for (const s of sockets) {
          try {
            s.send(payload)
          } catch {
            // A dead socket is cleaned up by its own close handler.
          }
        }
      })

      room = {
        sockets,
        subscriber,
        close: async () => {
          await subscriber.close()
          await connection.quit()
        },
      }
      rooms.set(workspaceId, room)
    }

    room.sockets.add(socket)
  }

  async function leave(workspaceId: string, socket: SocketLike): Promise<void> {
    const room = rooms.get(workspaceId)
    if (!room) return
    room.sockets.delete(socket)
    if (room.sockets.size === 0) {
      rooms.delete(workspaceId)
      await room.close()
    }
  }

  return new Elysia()
    .ws('/ws', {
      async open(ws) {
        const session = await ctx.auth.api.getSession({ headers: ws.data.request.headers })
        if (!session) {
          ws.send(JSON.stringify({ type: 'error', message: 'Not signed in' }))
          ws.close()
          return
        }

        const membership = await resolveMembership(
          ctx.db,
          session.user.id,
          (session.session as { activeOrganizationId?: string | null }).activeOrganizationId,
        )
        if (!membership) {
          ws.send(JSON.stringify({ type: 'error', message: 'No workspace membership' }))
          ws.close()
          return
        }

        socketWorkspace.set(ws as unknown as object, membership.workspaceId)
        await join(membership.workspaceId, ws as unknown as SocketLike)
        ws.send(JSON.stringify({ type: 'ready', workspaceId: membership.workspaceId }))
      },

      async message(ws, raw) {
        const parsed = wsClientMessageSchema.safeParse(raw)
        if (!parsed.success) return

        if (parsed.data.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }))
          return
        }

        if (parsed.data.type === 'typing') {
          const workspaceId = socketWorkspace.get(ws as unknown as object)
          if (!workspaceId) return
          await ctx.runtime.publisher.publish(workspaceId, {
            type: 'typing',
            conversationId: parsed.data.conversationId,
            actor: 'human',
            userId: null,
          })
        }
      },

      async close(ws) {
        const workspaceId = socketWorkspace.get(ws as unknown as object)
        if (workspaceId) await leave(workspaceId, ws as unknown as SocketLike)
      },
    })
    .onStop(async () => {
      await Promise.allSettled([...rooms.values()].map((room) => room.close()))
      rooms.clear()
    })
}
