import { expect, test } from '@playwright/test'
import { API_URL, apiSignIn, findWebChannelId } from './helpers'

/**
 * #15 and U08: the widget on a genuinely different site.
 *
 * Every other widget test opens the iframe app on the API's own origin, which never
 * exercised the embedding rule or the session request an iframe really makes. Here a host
 * page on another origin is served by the test itself.
 */

/**
 * Two other origins that are still this machine. A made-up public hostname is not: Chrome
 * refuses to let a public page load a script from localhost, so the loader never ran.
 * `127.0.0.1` is a different origin from `localhost`, which is all this needs.
 */
const HOST = 'http://127.0.0.1:3000'
const STRANGER = 'http://127.0.0.1:5173'

test.beforeEach(async ({ request }) => {
  await apiSignIn(request)
})

async function setOrigins(
  request: import('@playwright/test').APIRequestContext,
  channelId: string,
  allowedOrigins: string[],
) {
  const response = await request.patch(`${API_URL}/api/v1/settings/channels/${channelId}`, {
    data: { config: { allowedOrigins } },
  })
  expect(response.ok()).toBe(true)
}

async function serveHost(
  page: import('@playwright/test').Page,
  origin: string,
  channelId: string,
  lang = 'en',
) {
  await page.route(`${origin}/e2e-host-page`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      // A viewport tag, as any mobile site has: without one a phone lays the page out at
      // 980px and the widget, correctly, treats it as a desktop.
      body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><h1>A salon's site</h1>
        <script src="${API_URL}/widget/loader.js" data-channel="${channelId}" data-lang="${lang}"></script>
        </body></html>`,
    }),
  )
}

test('an allowed site embeds the widget, in the language it asks for', async ({
  page,
  request,
}) => {
  const channelId = await findWebChannelId(request)
  await setOrigins(request, channelId, [HOST])
  try {
    await serveHost(page, HOST, channelId, 'en')
    await page.goto(`${HOST}/e2e-host-page`)
    const launcher = page.locator('button[aria-expanded]')
    await expect(launcher).toBeVisible({ timeout: 15_000 })
    await launcher.click()
    await expect(launcher).toHaveAttribute('aria-expanded', 'true')

    const frame = page.frameLocator('iframe')
    // The session request comes from the iframe, on our origin: allowed although the list
    // names only the host. English, because the embed tag said so.
    await expect(frame.locator('#send')).toHaveText('Send', { timeout: 20_000 })
    await expect(frame.locator('#send')).toBeEnabled()
    await expect(frame.locator('html')).toHaveAttribute('lang', 'en')
  } finally {
    await setOrigins(request, channelId, [])
  }
})

test('a site that is not listed cannot frame it', async ({ page, request }) => {
  const channelId = await findWebChannelId(request)
  await setOrigins(request, channelId, [HOST])
  try {
    const refused: string[] = []
    page.on('console', (message) => {
      if (/frame-ancestors|Refused to frame/i.test(message.text())) refused.push(message.text())
    })
    await serveHost(page, STRANGER, channelId)
    await page.goto(`${STRANGER}/e2e-host-page`)
    await page.locator('button[aria-expanded]').click()
    await expect.poll(() => refused.length, { timeout: 15_000 }).toBeGreaterThan(0)
  } finally {
    await setOrigins(request, channelId, [])
  }
})

test('on a phone the chat fills the screen @mobile', async ({ page, request }) => {
  const channelId = await findWebChannelId(request)
  await serveHost(page, HOST, channelId, 'th')
  await page.goto(`${HOST}/e2e-host-page`)
  await page.locator('button[aria-expanded]').click()
  const box = await page.locator('iframe').boundingBox()
  const viewport = page.viewportSize()
  expect(box?.width).toBe(viewport?.width)
  // And the launcher is not floating over the composer.
  await expect(page.locator('button[aria-expanded]')).toBeHidden()
})
