import { expect, test } from '@playwright/test'
import {
  apiSignIn,
  configureMockProvider,
  customerSays,
  findTestChannelId,
  signIn,
  uniqueCustomer,
} from './helpers'

/**
 * Reviewing what the AI said when nobody was watching.
 *
 * The queue's whole promise is that a conversation leaves it once a person has looked, and
 * these drive that through the browser: rate a reply, or say plainly that it was read, and
 * the conversation is gone from the tab. Both routes out are covered because an agent will
 * use whichever is in front of them.
 */

test.beforeEach(async ({ request }) => {
  await apiSignIn(request)
  await configureMockProvider(request)
})

/** Open the review tab and wait for this customer's conversation to be listed in it. */
async function openInReviewTab(page: import('@playwright/test').Page, customer: string) {
  await page.getByTestId('inbox-tab-review').click()
  const row = page.getByTestId('conversation-row').filter({ hasText: customer })
  await expect(row).toBeVisible({ timeout: 25_000 })
  await row.click()
  await expect(page.locator('[data-sender="ai"]').first()).toBeVisible({ timeout: 25_000 })
  return row
}

test('rating a reply takes the conversation out of the review queue', async ({ page, request }) => {
  const channelId = await findTestChannelId(request)
  const customer = uniqueCustomer('review-rate')
  await customerSays(request, channelId, customer, 'ขอถามเรื่องแพ็กเกจค่ะ')

  await signIn(page)
  const row = await openInReviewTab(page, customer)

  // The AI answered alone, so the sidebar offers to record that someone has now looked.
  await expect(page.getByTestId('review-panel')).toBeVisible()

  await page.getByTestId('feedback-message-down').first().click()
  await page.getByTestId('feedback-message-reason-missing_knowledge').click()
  await page.getByTestId('feedback-message-save').click()

  // Rating is itself a review: the row leaves the tab and the panel goes with it.
  await expect(row).toHaveCount(0, { timeout: 20_000 })
  await expect(page.getByTestId('review-panel')).toHaveCount(0)

  // And the reason reaches the dashboard, which is the point of collecting it.
  await page.goto('/dashboard')
  await expect(page.getByTestId('feedback-reasons')).toContainText('missing_knowledge', {
    timeout: 20_000,
  })
})

test('an agent can simply say they have read it', async ({ page, request }) => {
  const channelId = await findTestChannelId(request)
  const customer = uniqueCustomer('review-mark')
  await customerSays(request, channelId, customer, 'สนใจสมัครใช้งานค่ะ')

  await signIn(page)
  const row = await openInReviewTab(page, customer)

  await page.getByTestId('mark-reviewed').click()

  await expect(row).toHaveCount(0, { timeout: 20_000 })
  await expect(page.getByTestId('review-panel')).toHaveCount(0)
})

test('the AI answering again puts a reviewed conversation back', async ({ page, request }) => {
  const channelId = await findTestChannelId(request)
  const customer = uniqueCustomer('review-return')
  await customerSays(request, channelId, customer, 'สวัสดีค่ะ')

  await signIn(page)
  const row = await openInReviewTab(page, customer)
  await page.getByTestId('mark-reviewed').click()
  await expect(row).toHaveCount(0, { timeout: 20_000 })

  // The customer writes again and the AI answers it, unwatched all over again.
  await customerSays(request, channelId, customer, 'แล้วมีโปรโมชั่นไหมคะ')

  await expect(page.getByTestId('conversation-row').filter({ hasText: customer })).toBeVisible({
    timeout: 30_000,
  })
})
