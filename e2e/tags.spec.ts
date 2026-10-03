import { expect, test } from '@playwright/test'
import {
  apiSignIn,
  configureMockProvider,
  customerSays,
  findTestChannelId,
  signIn,
  uniqueCustomer,
  uniqueToken,
} from './helpers'

/**
 * Tagging a conversation and finding it again by tag. The tag lives in the address
 * (`?tag=`), so a filtered queue survives a reload and can be linked to.
 */

test.beforeEach(async ({ request }) => {
  await apiSignIn(request)
  await configureMockProvider(request)
})

test('an agent tags a conversation, filters the inbox by it, and removes it', async ({
  page,
  request,
}) => {
  const channelId = await findTestChannelId(request)
  const tagged = uniqueCustomer('tagged')
  const other = uniqueCustomer('untagged')
  await customerSays(request, channelId, tagged, 'สอบถามเรื่องการคืนเงินค่ะ')
  await customerSays(request, channelId, other, 'สวัสดีค่ะ')
  // Typed with capitals and spaces; stored in the one spelling.
  const token = uniqueToken()
  const typed = `Refund ${token.toUpperCase()}`
  const tag = `refund ${token}`

  await signIn(page)
  const row = page.getByTestId('conversation-row').filter({ hasText: tagged })
  await expect(row).toBeVisible({ timeout: 25_000 })
  await expect(page.getByTestId('conversation-row').filter({ hasText: other })).toBeVisible({
    timeout: 25_000,
  })
  await row.click()

  const strip = page.getByTestId('conversation-tags')
  await strip.getByTestId('tag-input').fill(typed)
  await strip.getByTestId('tag-input').press('Enter')
  await expect(strip.getByTestId(`tag-chip-${tag}`)).toBeVisible()
  // The row in the list shows it too.
  await expect(row.getByTestId(`tag-chip-${tag}`)).toBeVisible()

  // Filter by it from the open conversation.
  await strip.getByTestId(`tag-select-${tag}`).click()
  await expect(page).toHaveURL(/[?&]tag=/)
  await expect(page.getByTestId('tag-filter').getByTestId(`tag-chip-${tag}`)).toBeVisible()
  await expect(row).toBeVisible()
  await expect(page.getByTestId('conversation-row').filter({ hasText: other })).toHaveCount(0)

  // A reload keeps the filter.
  await page.reload()
  await expect(page.getByTestId('tag-filter').getByTestId(`tag-chip-${tag}`)).toBeVisible()
  await expect(page.getByTestId('conversation-row').filter({ hasText: tagged })).toBeVisible({
    timeout: 25_000,
  })
  await expect(page.getByTestId('conversation-row').filter({ hasText: other })).toHaveCount(0)

  // Clear the filter, then take the tag off the conversation.
  await page.getByTestId('tag-filter').getByTestId(`tag-remove-${tag}`).click()
  await expect(page).not.toHaveURL(/[?&]tag=/)
  await page.getByTestId('conversation-tags').getByTestId(`tag-remove-${tag}`).click()
  await expect(page.getByTestId('conversation-tags').getByTestId(`tag-chip-${tag}`)).toHaveCount(0)
})

test('the tag box suggests tags the workspace already uses', async ({ page, request }) => {
  const channelId = await findTestChannelId(request)
  const first = uniqueCustomer('suggest-a')
  const second = uniqueCustomer('suggest-b')
  await customerSays(request, channelId, first, 'สวัสดีค่ะ')
  await customerSays(request, channelId, second, 'สวัสดีค่ะ')
  const tag = `pricing ${uniqueToken()}`

  await signIn(page)
  const firstRow = page.getByTestId('conversation-row').filter({ hasText: first })
  await expect(firstRow).toBeVisible({ timeout: 25_000 })
  await firstRow.click()
  await page.getByTestId('tag-input').fill(tag)
  await page.getByTestId('tag-input').press('Enter')
  await expect(page.getByTestId('conversation-tags').getByTestId(`tag-chip-${tag}`)).toBeVisible()

  await page.getByTestId('conversation-row').filter({ hasText: second }).click()
  await page.getByTestId('tag-input').fill(tag.slice(0, 10))
  await page.getByTestId(`tag-suggestion-${tag}`).click()
  await expect(page.getByTestId('conversation-tags').getByTestId(`tag-chip-${tag}`)).toBeVisible()
})
