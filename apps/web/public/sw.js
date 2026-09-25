/**
 * The console's service worker: notifications and nothing else (ADR 0010).
 *
 * No fetch handler, on purpose. A worker that caches pins the console to whatever build it
 * cached, and an app saved to an iPhone's home screen is hard to shake loose of an old one;
 * every request goes to the network exactly as it would without this file.
 */

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

/**
 * Every push shows a notification. Safari withdraws the subscription of a site that
 * receives pushes without showing one, and Chrome shows a generic one in its place, so
 * there is no quiet path here even when the console is open and focused.
 */
self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    // Shown anyway, generically, for the reason above.
  }
  const title = payload.title || 'AI Chat Desk'
  const shown = self.registration.showNotification(title, {
    body: payload.body || '',
    tag: payload.tag || 'chat',
    renotify: true,
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    data: { url: payload.url || '/' },
  })
  event.waitUntil(Promise.all([shown, setBadge(payload.badge)]))
})

/** The count on the app icon, where the platform draws one. */
function setBadge(count) {
  const nav = self.navigator
  if (typeof count !== 'number' || !nav || !('setAppBadge' in nav)) return Promise.resolve()
  return (count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge()).catch(() => {})
}

/** Open the conversation: in a console window already open if there is one. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL(event.notification.data?.url || '/', self.location.origin)
  if (target.origin !== self.location.origin) return

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue
        await client.focus()
        if ('navigate' in client) {
          try {
            await client.navigate(target.href)
            return
          } catch {
            // An uncontrolled window cannot be navigated from here; open one instead.
          }
        }
      }
      await self.clients.openWindow(target.href)
    })(),
  )
})
