import { expect, test } from '@playwright/test'
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
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
  // Signed in and on the inbox. Asserting a conversation exists here would be wrong: a
  // freshly seeded database has none, which is exactly the state CI starts from.
  await expect(page.getByTestId('composer-or-empty-inbox')).toBeVisible({ timeout: 20_000 })

  const channelId = await findTestChannelId(request)
  const customer = uniqueCustomer('live')

  // The page is already open. The conversation must appear over the socket.
  await customerSays(request, channelId, customer, 'สวัสดีค่ะ ราคาเท่าไหร่')

  await expect(page.getByTestId('conversation-row').filter({ hasText: customer })).toBeVisible({
    timeout: 25_000,
  })
})

test('an agent takes over and replies, and the AI falls silent', async ({ page, request }) => {
  const channelId = await findTestChannelId(request)
  const customer = uniqueCustomer('takeover')
  await customerSays(request, channelId, customer, 'ขอสอบถามเรื่องแพ็กเกจค่ะ')

  await signIn(page)

  const row = page.getByTestId('conversation-row').filter({ hasText: customer })
  await expect(row).toBeVisible({ timeout: 25_000 })
  await row.click()

  // The AI answers first, while it still owns the conversation.
  await expect(page.locator('[data-sender="ai"]').first()).toBeVisible({ timeout: 25_000 })

  await page.getByTestId('take-over').click()
  await expect(page.getByTestId('return-to-ai')).toBeVisible()

  const reply = `Handled by a person at ${Date.now()}`
  await page.getByTestId('composer').fill(reply)
  await page.getByTestId('send').click()
  // The composer clears only once the request succeeded, so this separates "the send
  // failed" from "the bubble has not rendered yet".
  await expect(page.getByTestId('composer')).toHaveValue('', { timeout: 20_000 })
  await expect(page.getByTestId('message-thread').getByText(reply)).toBeVisible({
    timeout: 20_000,
  })

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
  const rowAgain = page.getByTestId('conversation-row').filter({ hasText: customer })
  await expect(rowAgain).toBeVisible({ timeout: 25_000 })
  await rowAgain.click()
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
  const row = page.getByTestId('conversation-row').filter({ hasText: customer })
  await expect(row).toBeVisible({ timeout: 25_000 })
  await row.click()

  await page.getByTestId('take-over').click()
  await expect(page.getByTestId('return-to-ai')).toBeVisible()

  await page.getByTestId('return-to-ai').click()
  await expect(page.getByTestId('take-over')).toBeVisible()
})

test('the console cannot be opened without signing in', async ({ page }) => {
  // Opening the address without a session used to render the shell: navigation and an empty
  // inbox, with every request behind it failing. No data leaked, but it looked like being
  // signed in.
  await page.context().clearCookies()

  await page.goto('/')
  await page.waitForURL('**/login**', { timeout: 20_000 })
  await expect(page.getByTestId('login-email')).toBeVisible()

  // A deeper route is guarded too, and remembers where it was headed.
  await page.goto('/settings')
  await page.waitForURL('**/login**', { timeout: 20_000 })
  expect(new URL(page.url()).searchParams.get('next')).toBe('/settings')
})

test('signing in returns to the page that was asked for', async ({ page }) => {
  await page.context().clearCookies()
  await page.goto('/knowledge')
  await page.waitForURL('**/login**', { timeout: 20_000 })

  await page.getByTestId('login-email').fill(ADMIN_EMAIL)
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD)
  await page.getByTestId('login-submit').click()

  await page.waitForURL('**/knowledge', { timeout: 20_000 })
})

test('a model is chosen from the list the provider serves', async ({ page }) => {
  // Before this, the model was typed from memory. A gateway can serve dozens of ids and a
  // typo only surfaced when a customer message failed.
  await signIn(page)
  await page.goto('/settings')

  const modelField = page.getByTestId('slot-agent_chat-primary-model')
  await expect(modelField).toHaveValue('mock-model', { timeout: 20_000 })

  // The field offers the provider's models. A datalist is drawn by the browser, not the
  // page, so the options are asserted in the document rather than clicked.
  const listId = await modelField.getAttribute('list')
  expect(listId).toBeTruthy()
  const options = page.locator(`#${listId} option`)
  await expect(options).toHaveCount(3, { timeout: 20_000 })
  await expect(options.nth(1)).toHaveAttribute('value', 'mock-model-vision')

  // Choosing one saves it without a save button, and it survives a reload.
  await modelField.fill('mock-model-vision')
  await modelField.blur()
  await page.reload()
  await expect(page.getByTestId('slot-agent_chat-primary-model')).toHaveValue('mock-model-vision', {
    timeout: 20_000,
  })

  // A slot with no provider cannot offer a model, and says so instead of taking free text
  // that could never be reached.
  await expect(page.getByTestId('slot-agent_chat-fallback-model')).toBeDisabled()
})
