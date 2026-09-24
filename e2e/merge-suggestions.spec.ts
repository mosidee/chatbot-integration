import { expect, test } from '@playwright/test'
import {
  apiSignIn,
  configureMockProvider,
  confirmTwice,
  customerSays,
  findTestChannelId,
  signIn,
  uniqueCustomer,
  uniquePhone,
} from './helpers'

/**
 * Two records, one person.
 *
 * Each channel identity gets its own customer row on arrival, so the same person writing
 * from two places is two records until somebody says otherwise. These drive that from the
 * customer's message all the way to the panel: the phone number is extracted, the pair is
 * proposed, and nothing is joined until an agent says so twice.
 */

test.beforeEach(async ({ request }) => {
  await apiSignIn(request)
  await configureMockProvider(request)
})

/** Two identities on the test channel, both offering the same number, written differently. */
async function twoRecordsOnePhone(request: import('@playwright/test').APIRequestContext) {
  const channelId = await findTestChannelId(request)
  const first = uniqueCustomer('merge-a')
  const second = uniqueCustomer('merge-b')
  const phone = uniquePhone()
  // Written two ways, as the same person naturally would across two channels.
  const spaced = `${phone.slice(0, 3)}-${phone.slice(3, 6)}-${phone.slice(6)}`
  await customerSays(request, channelId, first, `เบอร์ติดต่อ ${spaced} ค่ะ`)
  await customerSays(request, channelId, second, `เบอร์เดิมนะคะ ${phone}`)
  return { first, second, phone }
}

test('the same phone on two records is proposed to a human', async ({ page, request }) => {
  const { second, phone } = await twoRecordsOnePhone(request)

  await signIn(page)
  const row = page.getByTestId('conversation-row').filter({ hasText: second })
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()

  // The AI recorded the number; the match is put in front of a person, not acted on.
  await expect(page.getByTestId('merge-suggestion')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('merge-match-value')).toHaveText(phone)
})

test('accepting joins the two, and the panel then shows both channels', async ({
  page,
  request,
}) => {
  const { second } = await twoRecordsOnePhone(request)

  await signIn(page)
  const row = page.getByTestId('conversation-row').filter({ hasText: second })
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
  await expect(page.getByTestId('merge-suggestion')).toBeVisible({ timeout: 30_000 })

  // Twice on purpose: the first click arms, the second performs. It cannot be undone.
  await confirmTwice(page.getByTestId('merge-accept'))

  await expect(page.getByTestId('merge-suggestion')).toHaveCount(0, { timeout: 30_000 })
  // One customer, known on two identities: the only visible proof the merge happened.
  await expect(page.getByTestId('customer-identities').locator('li')).toHaveCount(2, {
    timeout: 20_000,
  })
})

test('rejecting removes the proposal for good', async ({ page, request }) => {
  const { second } = await twoRecordsOnePhone(request)

  await signIn(page)
  const row = page.getByTestId('conversation-row').filter({ hasText: second })
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
  await expect(page.getByTestId('merge-suggestion')).toBeVisible({ timeout: 30_000 })

  await page.getByTestId('merge-reject').click()
  await expect(page.getByTestId('merge-suggestion')).toHaveCount(0, { timeout: 20_000 })

  // Still two separate people, and reloading does not bring the question back.
  await page.reload()
  const rowAgain = page.getByTestId('conversation-row').filter({ hasText: second })
  await expect(rowAgain).toBeVisible({ timeout: 25_000 })
  await rowAgain.click()
  await expect(page.getByTestId('customer-identities').locator('li')).toHaveCount(1)
  await expect(page.getByTestId('merge-suggestion')).toHaveCount(0)
})
