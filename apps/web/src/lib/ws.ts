import type { WsEvent } from '@ci/shared'
import { useQueryClient } from '@tanstack/react-query'
import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'

/**
 * Live updates from the API: one socket for the whole console.
 *
 * Reconnects with backoff, because an agent's laptop sleeping should not require a page
 * reload to see new customer messages. Redis does not replay what was published while the
 * socket was down, so a reconnect refetches everything on screen; a socket that just
 * reconnected is otherwise a plausible, stale picture. A close the server means — 4401 not
 * signed in, 4403 not allowed here — is not retried: the session or workspace is refreshed
 * instead, which is what shows the sign-in or the locked page.
 */

export type RealtimeStatus = 'connecting' | 'open' | 'reconnecting' | 'stopped'

type Listener = (event: WsEvent) => void

type Realtime = {
  status: RealtimeStatus
  subscribe: (listener: Listener) => () => void
  /** Which conversation is on screen, or null; see `useViewing`. */
  setViewing: (conversationId: string | null) => void
}

/** How often the console says again what it is showing; the server forgets after 75 s. */
const VIEWING_RENEW_MS = 30_000

const RealtimeContext = createContext<Realtime | null>(null)

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const listeners = useRef(new Set<Listener>())
  const [status, setStatus] = useState<RealtimeStatus>('connecting')
  const socketRef = useRef<WebSocket | null>(null)
  const viewing = useRef<string | null>(null)

  /**
   * Tell the server what is on screen: the open conversation while the page is visible,
   * nothing while it is hidden. A conversation in a background tab is not being read.
   */
  const reportViewing = useRef(() => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    const shown = document.visibilityState === 'visible' ? viewing.current : null
    socket.send(JSON.stringify({ type: 'viewing', conversationId: shown }))
  })

  useEffect(() => {
    const report = () => reportViewing.current()
    const renew = setInterval(() => {
      if (viewing.current && document.visibilityState === 'visible') report()
    }, VIEWING_RENEW_MS)
    document.addEventListener('visibilitychange', report)
    return () => {
      clearInterval(renew)
      document.removeEventListener('visibilitychange', report)
    }
  }, [])

  useEffect(() => {
    let socket: WebSocket | null = null
    let closed = false
    let attempt = 0
    let opened = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const connect = () => {
      if (closed) return
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(`${protocol}//${location.host}/ws`)
      socketRef.current = socket

      socket.onopen = () => {
        attempt = 0
        setStatus('open')
        // Everything published while we were away is gone; ask again for what is shown.
        // Not Settings: that page shows one version on purpose and moves it itself.
        if (opened) {
          void queryClient.invalidateQueries({
            predicate: (query) => query.queryKey[0] !== 'workspace-settings',
          })
        }
        opened = true
      }

      socket.onmessage = (raw) => {
        try {
          const parsed = JSON.parse(String(raw.data)) as WsEvent | { type: string }
          if (!('type' in parsed)) return
          // The server has placed this socket; only now does it accept what we show.
          if (parsed.type === 'ready') reportViewing.current()
          // The workspace was suspended or restored: the shell decides what to show.
          if (parsed.type === 'workspace.status') {
            void queryClient.invalidateQueries({ queryKey: ['me'] })
          }
          for (const listener of listeners.current) listener(parsed as WsEvent)
        } catch {
          // A malformed frame must not kill the connection.
        }
      }

      socket.onclose = (event) => {
        if (closed) return
        if (event.code === 4401 || event.code === 4403) {
          setStatus('stopped')
          void queryClient.invalidateQueries({ queryKey: ['me'] })
          return
        }
        setStatus('reconnecting')
        attempt += 1
        const delay = Math.min(1000 * 2 ** attempt, 30_000)
        timer = setTimeout(connect, delay)
      }

      socket.onerror = () => socket?.close()
    }

    connect()

    return () => {
      closed = true
      if (timer) clearTimeout(timer)
      socket?.close()
    }
  }, [queryClient])

  const value: Realtime = {
    status,
    subscribe: (listener) => {
      listeners.current.add(listener)
      return () => {
        listeners.current.delete(listener)
      }
    },
    setViewing: (conversationId) => {
      viewing.current = conversationId
      reportViewing.current()
    },
  }
  return createElement(RealtimeContext.Provider, { value }, children)
}

/** Hear every event while this component is mounted. */
export function useRealtime(onEvent: (event: WsEvent) => void): void {
  const realtime = useContext(RealtimeContext)
  const handler = useRef(onEvent)
  handler.current = onEvent
  useEffect(() => realtime?.subscribe((event) => handler.current(event)), [realtime])
}

/**
 * Say that this conversation is on screen for as long as the component is mounted, so a
 * customer's message to it does not also buzz this person's devices.
 */
export function useViewing(conversationId: string | null): void {
  const realtime = useContext(RealtimeContext)
  useEffect(() => {
    realtime?.setViewing(conversationId)
    return () => realtime?.setViewing(null)
  }, [realtime, conversationId])
}

/** Whether the live feed is up, for the header. */
export function useRealtimeStatus(): RealtimeStatus {
  return useContext(RealtimeContext)?.status ?? 'connecting'
}
