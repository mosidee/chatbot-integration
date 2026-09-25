import { api } from './api'

/**
 * Notifications on this device (ADR 0010).
 *
 * The browser holds one push subscription for the whole origin; the server holds a row per
 * workspace that this device was turned on in. So "on" here means both: the browser is
 * subscribed and this workspace knows the endpoint.
 */

export type PushState =
  /** Nothing to offer: the installation has no push keys. */
  | 'unavailable'
  /** iPhone or iPad in Safari: push exists only once the console is on the home screen. */
  | 'needs-install'
  /** A browser without Web Push. */
  | 'unsupported'
  /** Blocked for this site; only the browser's own settings can undo it. */
  | 'denied'
  | 'off'
  | 'on'

function isAppleMobile(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS asks for the desktop site and says it is a Mac; the touch screen gives it away.
    (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1)
  )
}

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

function supported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

/**
 * Register the worker on every load, so a device subscribed earlier keeps receiving.
 * `updateViaCache: 'none'` fetches it past the HTTP cache too, as the server's no-cache
 * header already asks.
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {
    // Notifications are then unavailable, which the settings card reports; nothing else
    // in the console depends on the worker.
  })
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration('/')
  return (await registration?.pushManager.getSubscription()) ?? null
}

export async function pushState(publicKey: string | null): Promise<PushState> {
  if (!publicKey) return 'unavailable'
  if (isAppleMobile() && !isStandalone()) return 'needs-install'
  if (!supported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  if (Notification.permission !== 'granted') return 'off'
  const subscription = await currentSubscription()
  if (!subscription) return 'off'
  const { subscribed } = await api.push.check(subscription.endpoint)
  return subscribed ? 'on' : 'off'
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false
  const left = new Uint8Array(a)
  return left.length === b.length && left.every((byte, i) => byte === b[i])
}

/**
 * Must be called straight from a click. Safari grants the permission prompt only to a
 * user gesture, and an `await` before it can spend the gesture.
 */
export async function enablePush(publicKey: string): Promise<PushState> {
  const permission = await Notification.requestPermission()
  if (permission === 'denied') return 'denied'
  if (permission !== 'granted') return 'off'

  const registration = await navigator.serviceWorker.ready
  const key = keyBytes(publicKey)
  let subscription = await registration.pushManager.getSubscription()
  // Subscribed under keys this installation no longer has: those pushes could never arrive.
  if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
    await subscription.unsubscribe()
    subscription = null
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key,
  })
  await api.push.subscribe(subscription.toJSON())
  return 'on'
}

/**
 * Stop this device. For one workspace the browser stays subscribed, since other workspaces
 * may still use it; `everywhere` (signing out) lets it go entirely.
 */
export async function disablePush(everywhere = false): Promise<void> {
  if (!supported()) return
  const subscription = await currentSubscription()
  if (!subscription) return
  await api.push.unsubscribe(subscription.endpoint, everywhere)
  if (everywhere) await subscription.unsubscribe()
}

export async function sendTestPush(): Promise<'sent' | 'not_subscribed' | 'gone' | 'failed'> {
  const subscription = await currentSubscription()
  if (!subscription) return 'not_subscribed'
  return (await api.push.test(subscription.endpoint)).result
}

/** The number on the app icon: this workspace's conversations waiting for a person. */
export function setAppBadge(count: number): void {
  const nav = navigator as Navigator & {
    setAppBadge?: (n: number) => Promise<void>
    clearAppBadge?: () => Promise<void>
  }
  const done = count > 0 ? nav.setAppBadge?.(count) : nav.clearAppBadge?.()
  done?.catch(() => {
    // Not installed, or a browser that draws no badge: nothing to show it on.
  })
}
