import { expect, test } from '@playwright/test'
import { apiSignIn, customerSays, findTestChannelId, signIn, uniqueCustomer } from './helpers'

/**
 * A long thread opens at its most recent messages, and reaches further back on demand.
 *
 * The window itself is asserted against the database in
 * `apps/api/test/inbox-order.integration.test.ts`. What only a browser can show is that the
 * panel opens at the end a person needs, and that scrolling up brings the rest.
 */

test.describe('a long conversation', () => {
  test.beforeEach(async ({ request }) => {
    await apiSignIn(request)
  })

  test('opens at the newest messages and loads earlier ones on demand', async ({
    page,
    request,
  }) => {
    const channelId = await findTestChannelId(request)
    const customer = uniqueCustomer('long')

    // Enough to need more than one window. Numbered so the test can say which end it sees.
    for (let index = 0; index < 34; index += 1) {
      await customerSays(request, channelId, customer, `ข้อความที่ ${index}`)
    }

    await signIn(page)
    const row = page.locator('[data-testid="conversation-row"]').filter({ hasText: customer })
    await expect(row).toBeVisible({ timeout: 25_000 })
    await row.click()

    const thread = page.getByTestId('message-thread')
    await expect(thread).toBeVisible({ timeout: 15_000 })

    // The newest message is there; the first one is not, because it is above the window.
    await expect(thread.getByText('ข้อความที่ 33', { exact: true })).toBeVisible({
      timeout: 25_000,
    })
    await expect(thread.getByText('ข้อความที่ 0', { exact: true })).toHaveCount(0)

    /**
     * Reach back until the whole thread is shown. More than one press, because the AI
     * answers each of those messages, so the conversation is roughly twice as long as the
     * number sent and one window does not cover it.
     */
    await expect(page.getByTestId('load-older-messages')).toBeVisible()

    /**
     * Where the reader is looking, so the next assertion can prove they stay there.
     * Prepending content pushes everything down, and without restoring the scroll position
     * the message being read jumps off screen.
     */
    const anchor = thread.getByText('ข้อความที่ 33', { exact: true })
    await page.getByTestId('load-older-messages').click()
    await page.waitForTimeout(600)

    // Not thrown to the top, and the thread did not silently reset to the bottom either.
    const scrollTop = await thread.evaluate((element) => element.scrollTop)
    expect(scrollTop).toBeGreaterThan(0)
    await expect(anchor).toBeVisible()

    for (let press = 0; press < 8; press += 1) {
      const button = page.getByTestId('load-older-messages')
      if ((await button.count()) === 0) break
      await button.click()
      await page.waitForTimeout(400)
    }

    await expect(thread.getByText('ข้อความที่ 0', { exact: true })).toBeVisible({
      timeout: 25_000,
    })
    // Once everything is shown, the offer goes away.
    await expect(page.getByTestId('load-older-messages')).toHaveCount(0)

    // The newest is still there: reaching back must widen the window, not move it.
    await expect(thread.getByText('ข้อความที่ 33', { exact: true })).toBeVisible()
  })
})
