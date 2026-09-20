import { expect, test } from '@playwright/test'
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  apiSignIn,
  configureMockProvider,
  customerSays,
  customerSendsImage,
  findTestChannelId,
  resetEmbedSlot,
  signIn,
  uniqueCustomer,
  uniqueToken,
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

  const reply = `Handled by a person at ${uniqueToken()}`
  await page.getByTestId('composer').fill(reply)
  await page.getByTestId('send').click()
  // The composer clears only once the request succeeded, so this separates "the send
  // failed" from "the bubble has not rendered yet".
  await expect(page.getByTestId('composer')).toHaveValue('', { timeout: 20_000 })
  await expect(page.getByTestId('message-thread').getByText(reply)).toBeVisible({
    timeout: 20_000,
  })

  // Outbound messages carry a delivery tick, the way every messaging app shows one. The
  // test channel reports nothing beyond acceptance, so one tick is the honest state.
  await expect(page.getByTestId('delivery-sent').first()).toBeVisible()
  await expect(page.getByTestId('delivery-read')).toHaveCount(0)

  const aiBubblesBefore = await page.locator('[data-sender="ai"]').count()
  expect(aiBubblesBefore).toBeGreaterThan(0)

  // The customer writes again while a human owns the conversation. The AI must stay silent.
  // The text is unique per run: the inbox list shows message previews, so a phrase reused
  // across runs would match more than one element.
  const followUp = `แล้วมีโปรโมชั่นไหมคะ ${uniqueToken()}`
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

test('every model the provider serves is offered, and an id can still be typed', async ({
  page,
}) => {
  // Before this, the model was typed from memory. A gateway can serve dozens of ids and a
  // typo only surfaced when a customer message failed.
  await signIn(page)
  await page.goto('/settings')

  const modelField = page.getByTestId('slot-agent_chat-primary-model')
  await expect(modelField).toHaveValue('mock-model', { timeout: 20_000 })

  // Every model, not only the ones resembling what the field already holds. This is what a
  // datalist got wrong: it filtered its options by the saved value, hiding the rest.
  // Values, not labels: the console defaults to Thai, so matching visible words would make
  // this test depend on the active language.
  const offered = await modelField
    .locator('option')
    .evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value))
  expect(offered.slice(0, 4)).toEqual(['', 'mock-model', 'mock-model-vision', 'mock-embedding'])
  expect(offered).toHaveLength(5)

  // Choosing one saves it without a save button, and it survives a reload.
  await modelField.selectOption('mock-model-vision')
  await page.reload()
  await expect(page.getByTestId('slot-agent_chat-primary-model')).toHaveValue('mock-model-vision', {
    timeout: 20_000,
  })

  // A gateway need not serve a list at all, so free text has to stay reachable.
  await page.getByTestId('slot-agent_chat-primary-model').selectOption({ index: 4 })
  const typed = page.getByTestId('slot-agent_chat-primary-model')
  await expect(typed).toHaveJSProperty('tagName', 'INPUT')
  await typed.fill('some/model-the-gateway-never-listed')
  await typed.blur()
  await page.reload()

  // A saved model the provider does not list is shown rather than silently dropped.
  const restored = page.getByTestId('slot-agent_chat-primary-model')
  await expect(restored).toHaveValue('some/model-the-gateway-never-listed', { timeout: 20_000 })
  await expect(restored.locator('option').nth(1)).toHaveJSProperty(
    'value',
    'some/model-the-gateway-never-listed',
  )

  // A slot with no provider cannot offer a model, and says so instead of taking free text
  // that could never be reached.
  await expect(page.getByTestId('slot-agent_chat-fallback-model')).toBeDisabled()
})

test('the embedding slot can stop sending the dimensions field, and remembers it', async ({
  page,
  request,
}) => {
  // Not every gateway accepts `dimensions`, and the console saves a slot whenever a provider
  // or model changes. Those saves used to replace the slot's params wholesale, so an option
  // set here would survive only until the next model change.
  // The slot is put into a known state through the API, so the test does not depend on what
  // a previous run left behind.
  await resetEmbedSlot(request)

  await signIn(page)
  await page.goto('/settings')

  const sendDimensions = page.getByTestId('slot-embed-send-dimensions')
  await expect(sendDimensions).toBeChecked({ timeout: 20_000 })

  // Offered for embeddings only: no other task sends the field.
  await expect(page.locator('[data-testid$="-send-dimensions"]')).toHaveCount(1)

  await sendDimensions.uncheck()
  await page.reload()
  await expect(page.getByTestId('slot-embed-send-dimensions')).not.toBeChecked({ timeout: 20_000 })

  // Changing the model saves the slot without mentioning params. The option must survive it.
  await page.getByTestId('slot-embed-primary-provider').selectOption({ index: 1 })
  await page.getByTestId('slot-embed-primary-model').selectOption('mock-embedding')
  await page.reload()
  await expect(page.getByTestId('slot-embed-primary-model')).toHaveValue('mock-embedding', {
    timeout: 20_000,
  })
  await expect(page.getByTestId('slot-embed-send-dimensions')).not.toBeChecked()

  await resetEmbedSlot(request)
})

test('a model can be tested from settings before a customer finds out', async ({
  page,
  request,
}) => {
  // A gateway's catalogue lists what it is configured to offer, not what it will serve.
  await resetEmbedSlot(request)
  await signIn(page)
  await page.goto('/settings')

  const verify = page.getByTestId('slot-agent_chat-primary-model-verify')
  await expect(verify).toBeEnabled({ timeout: 20_000 })
  await verify.click()

  const result = page.getByTestId('slot-agent_chat-primary-model-verify-result')
  await expect(result).toBeVisible({ timeout: 20_000 })
  await expect(result).toContainText('ใช้งานได้')

  // A model the provider will not serve reports the provider's own words, not ours.
  await page.getByTestId('slot-agent_chat-primary-model').selectOption({ index: 4 })
  const typed = page.getByTestId('slot-agent_chat-primary-model')
  await typed.fill('no/such-model')
  await typed.blur()
  await page.getByTestId('slot-agent_chat-primary-model-verify').click()
  await expect(page.getByTestId('slot-agent_chat-primary-model-verify-result')).toContainText(
    'ใช้ไม่ได้',
    { timeout: 20_000 },
  )

  // Nothing to test until a model is chosen. The button stays in place, so the two rows of
  // a slot keep the same column widths, but it cannot be pressed.
  await expect(page.getByTestId('slot-summarize-primary-model-verify')).toBeDisabled()
})

test('an agent opens a customer photo full size', async ({ page, request }) => {
  // A customer sends a screenshot of an error or a receipt. In the thread it is a couple of
  // hundred pixels tall, which is right for scanning and useless for reading.
  const channelId = await findTestChannelId(request)
  const customer = uniqueCustomer('photo')

  await signIn(page)
  await customerSendsImage(request, channelId, customer)

  const row = page.getByTestId('conversation-row').filter({ hasText: customer })
  await expect(row).toBeVisible({ timeout: 25_000 })
  await row.click()

  const thumbnail = page.getByTestId('message-image').first()
  await expect(thumbnail).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('lightbox')).toHaveCount(0)

  await thumbnail.click()
  await expect(page.getByTestId('lightbox')).toBeVisible()
  await expect(page.getByTestId('lightbox-image')).toBeVisible()

  // Clicking the picture itself must not close it: that is the one place nobody expects it.
  await page.getByTestId('lightbox-image').click()
  await expect(page.getByTestId('lightbox')).toBeVisible()

  // Escape closes, because that is what every other overlay on a computer does.
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('lightbox')).toHaveCount(0)

  // And so does clicking the backdrop.
  await thumbnail.click()
  await expect(page.getByTestId('lightbox')).toBeVisible()
  await page.getByTestId('lightbox-close').click()
  await expect(page.getByTestId('lightbox')).toHaveCount(0)
})
