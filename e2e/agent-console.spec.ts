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
 * The three flows that would embarrass us if they broke.
 *
 * Each drives the real API, worker and database through a browser, with only the model
 * provider mocked.
 */

test.beforeEach(async ({ request }) => {
  await apiSignIn(request)
  await configureMockProvider(request)
})

test('an agent signs in and sees a new conversation arrive without reloading', async ({
  page,
  request,
}) => {
  await signIn(page)
  await expect(page.getByTestId('conversation-row').first()).toBeVisible({ timeout: 20_000 })

  const channelId = await findTestChannelId(request)
  const customer = uniqueCustomer('live')

  // The page is already open. The conversation must appear over the socket.
  await customerSays(request, channelId, customer, 'สวัสดีค่ะ ราคาเท่าไหร่')

  await expect(page.getByText(customer, { exact: false })).toBeVisible({ timeout: 20_000 })
})

test('an agent takes over and replies, and the AI falls silent', async ({ page, request }) => {
  const channelId = await findTestChannelId(request)
  const customer = uniqueCustomer('takeover')
  await customerSays(request, channelId, customer, 'ขอสอบถามเรื่องแพ็กเกจค่ะ')

  await signIn(page)

  await page.getByText(customer, { exact: false }).click()

  // The AI answers first, while it still owns the conversation.
  await expect(page.locator('[data-sender="ai"]').first()).toBeVisible({ timeout: 20_000 })

  await page.getByTestId('take-over').click()
  await expect(page.getByTestId('return-to-ai')).toBeVisible()

  const reply = `Handled by a person at ${Date.now()}`
  await page.getByTestId('composer').fill(reply)
  await page.getByTestId('send').click()
  await expect(page.getByTestId('message-thread').getByText(reply)).toBeVisible()

  const aiBubblesBefore = await page.locator('[data-sender="ai"]').count()
  expect(aiBubblesBefore).toBeGreaterThan(0)

  // The customer writes again while a human owns the conversation. The AI must stay silent.
  // The text is unique per run: the inbox list shows message previews, so a phrase reused
  // across runs would match more than one element.
  const followUp = `แล้วมีโปรโมชั่นไหมคะ ${Date.now()}`
  await customerSays(request, channelId, customer, followUp)

  // Wait for the new message to arrive rather than a fixed duration, so the assertion runs
  // after the system had every chance to reply. Scoped to the thread, not the whole page.
  const thread = page.getByTestId('message-thread')
  await expect(thread.getByText(followUp)).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(5000)

  await page.reload()
  await page.getByText(customer, { exact: false }).click()
  // Anchor on content before counting: count() does not wait for the thread to render.
  await expect(page.getByTestId('message-thread').getByText(reply)).toBeVisible({
    timeout: 20_000,
  })

  const aiBubblesAfter = await page.locator('[data-sender="ai"]').count()
  expect(aiBubblesAfter).toBe(aiBubblesBefore)

  // And the conversation is still owned by the human.
  await expect(page.getByTestId('return-to-ai')).toBeVisible()
})

test('an agent hands the conversation back to the AI', async ({ page, request }) => {
  const channelId = await findTestChannelId(request)
  const customer = uniqueCustomer('return')
  await customerSays(request, channelId, customer, 'คำถามแรกค่ะ')

  await signIn(page)
  await page.getByText(customer, { exact: false }).click()

  await page.getByTestId('take-over').click()
  await expect(page.getByTestId('return-to-ai')).toBeVisible()

  await page.getByTestId('return-to-ai').click()
  await expect(page.getByTestId('take-over')).toBeVisible()
})
