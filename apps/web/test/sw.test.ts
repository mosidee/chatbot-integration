import { describe, expect, test } from 'bun:test'

/**
 * The service worker (ADR 0010), run against a stand-in for its global scope.
 *
 * No browser under automation can receive a real push, so this is where the worker's own
 * rules are held: every push shows a notification, the badge follows the count, and a tap
 * opens the conversation without leaving the console's origin.
 */

const source = await Bun.file(new URL('../public/sw.js', import.meta.url)).text()

type Handler = (event: Record<string, unknown>) => void

function worker(options: { windows?: { url: string }[]; badge?: boolean } = {}) {
  const handlers: Record<string, Handler> = {}
  const calls: { method: string; args: unknown[] }[] = []
  const record =
    (method: string) =>
    async (...args: unknown[]) => {
      calls.push({ method, args })
    }
  const windows = (options.windows ?? []).map((window) => ({
    url: window.url,
    focus: record('focus'),
    navigate: record('navigate'),
  }))
  const self = {
    location: { origin: 'https://chat.example.com' },
    addEventListener: (type: string, handler: Handler) => {
      handlers[type] = handler
    },
    skipWaiting: record('skipWaiting'),
    registration: { showNotification: record('showNotification') },
    clients: {
      claim: record('claim'),
      matchAll: async () => windows,
      openWindow: record('openWindow'),
    },
    navigator:
      options.badge === false
        ? {}
        : { setAppBadge: record('setAppBadge'), clearAppBadge: record('clearAppBadge') },
  }
  new Function('self', source)(self)

  async function dispatch(type: string, event: Record<string, unknown>) {
    const pending: Promise<unknown>[] = []
    handlers[type]?.({ ...event, waitUntil: (promise: Promise<unknown>) => pending.push(promise) })
    await Promise.all(pending)
  }
  return { calls, dispatch }
}

const payload = (value: unknown) => ({ json: () => value })

describe('a push', () => {
  test('shows the notification and puts the count on the app icon', async () => {
    const { calls, dispatch } = worker()
    await dispatch('push', {
      data: payload({
        title: 'Khun A · salon',
        body: 'Waiting for a person: hello',
        tag: 'c1',
        url: '/salon?tab=waiting&c=c1',
        badge: 3,
      }),
    })
    const shown = calls.find((call) => call.method === 'showNotification')
    expect(shown?.args[0]).toBe('Khun A · salon')
    expect(shown?.args[1]).toMatchObject({
      body: 'Waiting for a person: hello',
      tag: 'c1',
      data: { url: '/salon?tab=waiting&c=c1' },
    })
    expect(calls).toContainEqual({ method: 'setAppBadge', args: [3] })
  })

  test('shows something even when the payload is unreadable', async () => {
    const { calls, dispatch } = worker()
    await dispatch('push', {
      data: {
        json: () => {
          throw new SyntaxError('bad')
        },
      },
    })
    expect(calls.filter((call) => call.method === 'showNotification')).toHaveLength(1)
  })

  test('clears the icon at zero, and copes where there is no badge at all', async () => {
    const counted = worker()
    await counted.dispatch('push', { data: payload({ title: 't', badge: 0 }) })
    expect(counted.calls).toContainEqual({ method: 'clearAppBadge', args: [] })

    const plain = worker({ badge: false })
    await plain.dispatch('push', { data: payload({ title: 't', badge: 2 }) })
    expect(plain.calls.filter((call) => call.method === 'showNotification')).toHaveLength(1)
  })
})

describe('a tap', () => {
  const notification = (url: string) => ({ close: () => {}, data: { url } })

  test('reuses an open console window', async () => {
    const { calls, dispatch } = worker({ windows: [{ url: 'https://chat.example.com/' }] })
    await dispatch('notificationclick', { notification: notification('/salon?c=c1') })
    expect(calls).toContainEqual({
      method: 'navigate',
      args: ['https://chat.example.com/salon?c=c1'],
    })
    expect(calls.map((call) => call.method)).not.toContain('openWindow')
  })

  test('opens one when none is open', async () => {
    const { calls, dispatch } = worker()
    await dispatch('notificationclick', { notification: notification('/salon?c=c1') })
    expect(calls).toContainEqual({
      method: 'openWindow',
      args: ['https://chat.example.com/salon?c=c1'],
    })
  })

  test('never leaves the console’s origin', async () => {
    const { calls, dispatch } = worker()
    await dispatch('notificationclick', { notification: notification('https://evil.example/') })
    expect(calls.map((call) => call.method)).not.toContain('openWindow')
  })
})
