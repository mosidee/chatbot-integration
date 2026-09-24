import { schema } from '@ci/db'
import { subscribeToWorkspace, type WorkspaceSubscriber } from '@ci/infra'
import type { UserRoleName, WsEvent } from '@ci/shared'
import { wsClientMessageSchema } from '@ci/shared'
import { and, eq } from 'drizzle-orm'
import Elysia from 'elysia'
import { workspaceRefusal } from './auth-plugin'
import type { ApiContext } from './context'
import { loadMemberships, resolveMembership } from './context'

/**
 * Realtime updates for the agent GUI.
 *
 * One Redis subscriber is shared by every socket watching the same workspace, rather than
 * one per connection: a busy inbox with a dozen agents open should cost one subscription,
 * not a dozen. Since each replica maintains its own, the deployment scales horizontally
 * without sticky sessions.
 *
 * Authorisation is not only a question asked at open. A socket outlives the session and
 * the membership it was opened with, so it is asked again whenever either may have
 * changed (`auth.changed`, `workspace.status`) and on a timer as a backstop, and a socket
 * that no longer qualifies is closed with a code the console knows not to retry:
 * 4401 not signed in, 4403 not allowed here.
 */

/** How often every socket re-proves itself, whatever was or was not announced. */
const REVALIDATE_EVERY_MS = 5 * 60 * 1000

type SocketLike = {
  send: (data: string) => unknown
  close: (code?: number, reason?: string) => unknown
}

type SocketState = {
  workspaceId: string
  userId: string
  role: UserRoleName
  /** The headers it opened with: the session cookie, re-checked on every revalidation. */
  headers: Headers
  timer: ReturnType<typeof setInterval>
}

type WorkspaceRoom = {
  sockets: Set<SocketLike>
  subscriber: WorkspaceSubscriber
  close: () => Promise<void>
}

export function createWsRoutes(ctx: ApiContext) {
  const rooms = new Map<string, WorkspaceRoom>()
  /**
   * Rooms being created. Two first joins at once used to both miss `rooms`, both
   * subscribe, and the loser's subscriber was never closed.
   */
  const opening = new Map<string, Promise<WorkspaceRoom>>()
  const states = new WeakMap<object, SocketState>()

  /** The console's own origins. A page elsewhere must not ride an agent's cookie in here. */
  const ownOrigins = new Set(
    [ctx.env.PUBLIC_WEB_URL, ctx.env.PUBLIC_API_URL].flatMap((value) => {
      try {
        return [new URL(value).origin]
      } catch {
        return []
      }
    }),
  )

  const refuse = (socket: SocketLike, code: number, message: string) => {
    try {
      socket.send(JSON.stringify({ type: 'error', message }))
      socket.close(code, message)
    } catch {
      // Already gone.
    }
  }

  /** Still signed in, still a member, workspace still active? Closes the socket if not. */
  async function revalidate(socket: SocketLike): Promise<void> {
    const state = states.get(socket as object)
    if (!state) return
    const session = await ctx.auth.api.getSession({ headers: state.headers }).catch(() => null)
    if (!session || session.user.id !== state.userId) {
      refuse(socket, 4401, 'Not signed in')
      return
    }
    const membership = (await loadMemberships(ctx.db, state.userId)).find(
      (m) => m.workspaceId === state.workspaceId,
    )
    if (!membership) {
      refuse(socket, 4403, 'No workspace membership')
      return
    }
    if (membership.status !== 'active') {
      refuse(socket, 4403, workspaceRefusal(membership.status).error)
      return
    }
    state.role = membership.role
  }

  function fanOut(sockets: Set<SocketLike>, event: WsEvent) {
    /**
     * Announcements that somebody's access changed are for this process, not the browser:
     * each affected socket re-proves itself, and one that fails is closed. A status change
     * is forwarded as well, because the console shows it.
     */
    if (event.type === 'auth.changed' || event.type === 'workspace.status') {
      for (const s of sockets) {
        const state = states.get(s as object)
        if (event.type === 'auth.changed' && event.userId && state?.userId !== event.userId)
          continue
        void revalidate(s)
      }
      if (event.type === 'auth.changed') return
    }
    const payload = JSON.stringify(event)
    for (const s of sockets) {
      try {
        s.send(payload)
      } catch {
        // A dead socket is cleaned up by its own close handler.
      }
    }
  }

  async function openRoom(workspaceId: string): Promise<WorkspaceRoom> {
    const connection = ctx.runtime.subscriberFactory()
    const sockets = new Set<SocketLike>()
    const subscriber = await subscribeToWorkspace(connection, workspaceId, (event: WsEvent) =>
      fanOut(sockets, event),
    )
    return {
      sockets,
      subscriber,
      close: async () => {
        await subscriber.close()
        await connection.quit()
      },
    }
  }

  async function join(workspaceId: string, socket: SocketLike): Promise<void> {
    let room = rooms.get(workspaceId)
    if (!room) {
      let pending = opening.get(workspaceId)
      if (!pending) {
        pending = openRoom(workspaceId)
        opening.set(workspaceId, pending)
      }
      try {
        room = await pending
      } finally {
        opening.delete(workspaceId)
      }
      // Whoever resolved first installs it; everybody else joins that one.
      const installed = rooms.get(workspaceId)
      if (installed && installed !== room) {
        room = installed
      } else {
        rooms.set(workspaceId, room)
      }
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
        const socket = ws as unknown as SocketLike
        const headers = ws.data.request.headers

        // Absent for a non-browser client, which has no ambient cookie to abuse.
        const origin = headers.get('origin')
        if (origin && !ownOrigins.has(origin)) {
          refuse(socket, 4403, 'Origin not allowed')
          return
        }

        const session = await ctx.auth.api.getSession({ headers })
        if (!session) {
          refuse(socket, 4401, 'Not signed in')
          return
        }

        const membership = await resolveMembership(
          ctx.db,
          session.user.id,
          (session.session as { activeOrganizationId?: string | null }).activeOrganizationId,
        )
        if (!membership) {
          refuse(socket, 4403, 'No workspace membership')
          return
        }

        // The same refusal the HTTP guard makes.
        if (membership.status !== 'active') {
          refuse(socket, 4403, workspaceRefusal(membership.status).error)
          return
        }

        const state: SocketState = {
          workspaceId: membership.workspaceId,
          userId: session.user.id,
          role: membership.role,
          headers: new Headers(headers),
          timer: setInterval(() => void revalidate(socket), REVALIDATE_EVERY_MS),
        }
        states.set(ws as unknown as object, state)
        await join(membership.workspaceId, socket)

        // Closed while joining: the close handler found no room yet, so leave now.
        if (!states.has(ws as unknown as object)) {
          await leave(membership.workspaceId, socket)
          return
        }
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
          const state = states.get(ws as unknown as object)
          // A viewer cannot reply, so it has nothing to be seen typing.
          if (!state || state.role === 'viewer') return
          // Only a conversation of this socket's own workspace.
          const owned = await ctx.db
            .select({ id: schema.conversations.id })
            .from(schema.conversations)
            .where(
              and(
                eq(schema.conversations.id, parsed.data.conversationId),
                eq(schema.conversations.workspaceId, state.workspaceId),
              ),
            )
            .limit(1)
          if (owned.length === 0) return
          await ctx.runtime.publisher.publish(state.workspaceId, {
            type: 'typing',
            conversationId: parsed.data.conversationId,
            actor: 'human',
            userId: state.userId,
          })
        }
      },

      async close(ws) {
        const state = states.get(ws as unknown as object)
        if (!state) return
        clearInterval(state.timer)
        states.delete(ws as unknown as object)
        await leave(state.workspaceId, ws as unknown as SocketLike)
      },
    })
    .onStop(async () => {
      await Promise.allSettled([...rooms.values()].map((room) => room.close()))
      rooms.clear()
    })
}
