import { expect, type Page, test } from '@playwright/test'
import { signIn, uniqueToken } from './helpers'

/**
 * Notifications on this device (ADR 0010).
 *
 * A browser under automation can neither show the permission prompt nor register with a
 * real push service (headless reports notifications as blocked; headed Chrome refuses the
 * registration), so the browser's half is stood in for: permission is granted and
 * `PushManager` hands back a subscription on Google's push host, which is what the server
 * accepts. Everything from there — storing it, reporting it, turning it off — is real.
 * Whether a phone actually buzzes is checked on a phone.
 */

async function fakePush(page: Page): Promise<string> {
  const endpoint = `https://fcm.googleapis.com/fcm/send/e2e-${uniqueToken()}`
  await page.addInitScript((endpoint) => {
    // Kept across a reload, as a real browser's subscription is.
    const KEY = 'e2e-push-subscribed'
    let subscribed = sessionStorage.getItem(KEY) === '1'
    Object.defineProperty(Notification, 'permission', { get: () => 'granted' })
    Notification.requestPermission = async () => 'granted'
    const subscription = {
      endpoint,
      options: { applicationServerKey: null as ArrayBuffer | null },
      toJSON: () => ({
        endpoint,
        expirationTime: null,
        keys: {
          p256dh:
            'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
          auth: 'tBHItJI5svbpez7KI4CCXg',
        },
      }),
      unsubscribe: async () => {
        subscribed = false
        sessionStorage.removeItem(KEY)
        return true
      },
    }
    PushManager.prototype.getSubscription = async () =>
      (subscribed ? subscription : null) as unknown as PushSubscription
    PushManager.prototype.subscribe = async (options) => {
      subscribed = true
      sessionStorage.setItem(KEY, '1')
      subscription.options.applicationServerKey = options?.applicationServerKey as ArrayBuffer
      return subscription as unknown as PushSubscription
    }
  }, endpoint)
  return endpoint
}

test('an agent turns notifications on for this device, and off again', async ({ page }) => {
  await fakePush(page)
  await signIn(page)
  await page.goto('/settings?tab=general')

  await page.getByTestId('push-enable').click()
  await expect(page.getByTestId('push-on')).toBeVisible()

  // The server remembers it: a fresh look at the page asks it, and it says on.
  await page.reload()
  await expect(page.getByTestId('push-on')).toBeVisible()

  // Off for this workspace; the server forgets it, so a reload still says off.
  await page.getByTestId('push-disable').click()
  await expect(page.getByTestId('push-enable')).toBeVisible()
  await page.reload()
  await expect(page.getByTestId('push-enable')).toBeVisible()
})

test('an iPhone in Safari is told to add the console to the Home Screen first', async ({
  browser,
}) => {
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  })
  const page = await context.newPage()
  await signIn(page)
  await page.goto('/settings?tab=general')
  await expect(page.getByTestId('push-needs-install')).toBeVisible()
  await expect(page.getByTestId('push-enable')).toHaveCount(0)
  await context.close()
})

test('the console is installable: manifest, icons and a worker that caches nothing', async ({
  request,
}) => {
  const manifest = await request.get('/manifest.webmanifest')
  expect(manifest.ok()).toBe(true)
  const body = (await manifest.json()) as { display: string; icons: { src: string }[] }
  expect(body.display).toBe('standalone')
  for (const icon of body.icons) {
    expect((await request.get(icon.src)).ok()).toBe(true)
  }
  expect((await request.get('/apple-touch-icon.png')).ok()).toBe(true)

  const worker = await (await request.get('/sw.js')).text()
  expect(worker).toContain("addEventListener('push'")
  expect(worker).not.toContain("addEventListener('fetch'")
})
