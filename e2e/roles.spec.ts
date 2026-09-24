import { expect, test } from '@playwright/test'
import {
  apiSignIn,
  customerSays,
  findTestChannelId,
  signInAs,
  uniqueCustomer,
  uniqueToken,
} from './helpers'

/**
 * U06: nobody is offered what the API will refuse them. A viewer reads; an agent replies;
 * admin-only settings stay with admins.
 */

test.beforeEach(async ({ request }) => {
  await apiSignIn(request)
})

test('a viewer can read a conversation and is not offered a reply', async ({ page, request }) => {
  const channelId = await findTestChannelId(request)
  const customer = uniqueCustomer('viewer')
  await customerSays(request, channelId, customer, `question ${uniqueToken()}`)

  const viewer = await signInAs(page, request, 'viewer')
  try {
    const row = page.getByTestId('conversation-row').filter({ hasText: customer })
    await expect(row).toBeVisible({ timeout: 25_000 })
    await row.click()
    await expect(page.getByTestId('message-thread')).toBeVisible()
    await expect(page.getByTestId('read-only-note')).toBeVisible()
    await expect(page.getByTestId('take-over')).toHaveCount(0)
    await expect(page.getByTestId('composer')).toBeHidden()

    // Knowledge: readable, not editable.
    await page.goto('/knowledge')
    await expect(page.getByTestId('knowledge-read-only')).toBeVisible()

    // Settings: general only, read-only, and no admin-only requests fired.
    const refused: string[] = []
    page.on('response', (response) => {
      if (response.status() === 403) refused.push(response.url())
    })
    await page.goto('/settings')
    await expect(page.getByTestId('settings-read-only')).toBeVisible()
    await expect(page.getByTestId('settings-tab-models')).toHaveCount(0)
    await page.waitForTimeout(1000)
    expect(refused).toEqual([])

    // The simulator is not in their navigation.
    await expect(page.getByRole('link', { name: /simulator|ทดลองแชท/i })).toHaveCount(0)
  } finally {
    await viewer.cleanup()
  }
})
