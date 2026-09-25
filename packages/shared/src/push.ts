import { z } from 'zod'

/**
 * Web Push: notifications that reach an agent's device with the console closed (ADR 0010).
 */

/**
 * The hosts browsers hand out push endpoints on.
 *
 * A subscription's endpoint arrives in a request body and the worker posts to it, so an
 * endpoint anywhere else would let a member aim our servers at an address of their
 * choosing, a private one included. Every browser that can subscribe uses one of these:
 * Chrome and Edge on Android and desktop (FCM, and Windows' own service for Edge), Safari
 * on iOS, iPadOS and macOS (Apple), Firefox (Mozilla).
 */
const PUSH_SERVICE_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com']
const PUSH_SERVICE_SUFFIXES = ['.push.apple.com', '.notify.windows.com']

export function isPushServiceEndpoint(endpoint: string): boolean {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false
  const host = url.hostname.toLowerCase()
  return (
    PUSH_SERVICE_HOSTS.includes(host) ||
    PUSH_SERVICE_SUFFIXES.some((suffix) => host.endsWith(suffix))
  )
}

/** What `PushSubscription.toJSON()` gives the browser, and what the console posts. */
export const pushSubscriptionSchema = z.object({
  endpoint: z
    .string()
    .max(2048)
    .refine(isPushServiceEndpoint, 'endpoint is not a known push service'),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(64),
  }),
})
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>

/**
 * What the service worker receives, decrypted.
 *
 * `badge` is the workspace's waiting count, for the app icon where the platform shows one.
 * `tag` collapses notifications about one conversation into the newest.
 */
export type PushPayload = {
  title: string
  body: string
  tag: string
  url: string
  badge: number
}
