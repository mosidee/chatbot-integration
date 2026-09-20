import type { WsEvent } from '@ci/shared'
import { useEffect, useRef } from 'react'

/**
 * Live updates from the API.
 *
 * Reconnects with backoff, because an agent's laptop sleeping should not require a page
 * reload to see new customer messages.
 */
export function useRealtime(onEvent: (event: WsEvent) => void): void {
  const handler = useRef(onEvent)
  handler.current = onEvent

  useEffect(() => {
    let socket: WebSocket | null = null
    let closed = false
    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | undefined

    const connect = () => {
      if (closed) return
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(`${protocol}//${location.host}/ws`)

      socket.onopen = () => {
        attempt = 0
      }

      socket.onmessage = (raw) => {
        try {
          const parsed = JSON.parse(String(raw.data)) as WsEvent | { type: string }
          if ('type' in parsed) handler.current(parsed as WsEvent)
        } catch {
          // A malformed frame must not kill the connection.
        }
      }

      socket.onclose = () => {
        if (closed) return
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
  }, [])
}
