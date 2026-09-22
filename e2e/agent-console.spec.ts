import { expect, test } from '@playwright/test'
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  API_URL,
  apiSignIn,
  configureMockProvider,
  customerSays,
  customerSendsImage,
  findTestChannelId,
  findWebChannelId,
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

  // Handing back now asks what to tell the AI, so whatever the colleague sorted out is not
  // invisible to the next turn. The note is optional; this one leaves one.
  await page.getByTestId('return-to-ai').click()
  await page.getByTestId('return-note').fill('Refund already issued, do not offer another.')
  await page.getByTestId('return-to-ai-confirm').click()
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
  await page.goto('/settings?tab=models')

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
  await page.goto('/settings?tab=models')

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
  await page.goto('/settings?tab=models')

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

test('an admin erases a customer, and it takes two clicks', async ({ page, request }) => {
  // Thailand's PDPA gives a person the right to be erased, and the agent reading the
  // request is who acts on it, so the control sits beside the conversation.
  const channelId = await findTestChannelId(request)
  const customer = uniqueCustomer('erase')

  await signIn(page)
  await customerSays(request, channelId, customer, 'ขอให้ลบข้อมูลของฉันด้วยค่ะ')

  const row = page.getByTestId('conversation-row').filter({ hasText: customer })
  await expect(row).toBeVisible({ timeout: 25_000 })
  await row.click()

  const erase = page.getByTestId('erase-customer')
  await expect(erase).toBeVisible({ timeout: 20_000 })

  // One click arms it and deletes nothing. Irreversible work does not happen on a stray
  // click, and no browser dialog is used, which nobody reads anyway.
  await erase.click()
  await expect(erase).toContainText('ยืนยัน')
  await expect(page.getByTestId('conversation-row').filter({ hasText: customer })).toBeVisible()

  // The second click queues it. The work itself happens in the worker, because it deletes
  // stored images as well as rows.
  await erase.click()
  await expect(page.getByText('ส่งคำสั่งลบแล้ว', { exact: false })).toBeVisible({
    timeout: 20_000,
  })

  // The conversation goes with the customer, so the inbox no longer lists them.
  await expect(page.getByTestId('conversation-row').filter({ hasText: customer })).toHaveCount(0, {
    timeout: 25_000,
  })
})

test('a visitor chats through the embedded widget and the AI answers', async ({
  page,
  request,
  context,
}) => {
  // The widget is what salon-saas will embed, so this drives the real thing: the public
  // widget API, a session token, the queue, the AI, and the poll that brings the reply back.
  const channelId = await findWebChannelId(request)

  // Against the API's own origin, which is what serves the widget. In production the
  // console and the widget share an origin; in development the console is on Vite.
  await page.goto(`${API_URL}/widget/index.html?channel=${channelId}&colour=%232563eb`)

  const input = page.locator('#text')
  await expect(input).toBeVisible({ timeout: 20_000 })
  await input.fill('สวัสดีค่ะ ราคาเท่าไหร่')
  await page.locator('#send').click()

  // The visitor's own message appears at once, before the round trip, and exactly once:
  // the poll brings back the stored copy with a different id, which must adopt the bubble
  // already on screen rather than drawing a second one.
  await expect(page.locator('.bubble.you')).toContainText('ราคาเท่าไหร่')

  // And the answer arrives on a poll, with no socket involved.
  await expect(page.locator('.bubble.support').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.bubble.you')).toHaveCount(1)

  // A second visitor is a different conversation. One widget session must never show
  // another person's messages, which is the whole reason the session carries the identity.
  const other = await context.newPage()
  await other.addInitScript(() => {
    try {
      localStorage.setItem('chat-widget:visitor', 'someone-else')
    } catch {
      // Storage is blocked; the widget falls back to a per-load id, which suits this test.
    }
  })
  await other.goto(`${API_URL}/widget/index.html?channel=${channelId}`)
  await expect(other.locator('#text')).toBeVisible({ timeout: 20_000 })
  await other.waitForTimeout(1500)
  await expect(other.locator('.bubble')).toHaveCount(0)
  await other.close()
})

test('a visitor who is handed to a person is told so', async ({ page, request }) => {
  /**
   * The rule the product is built on, from the only side that cannot check anywhere else.
   *
   * A handoff used to notify agents and say nothing to the visitor, so the thread simply
   * stopped. There is no inbox for them to check and no email telling them a reply came:
   * if the widget does not say it, nobody does.
   */
  const channelId = await findWebChannelId(request)
  await page.goto(`${API_URL}/widget/index.html?channel=${channelId}`)

  const input = page.locator('#text')
  await expect(input).toBeEnabled({ timeout: 20_000 })
  await input.fill('ขอคุยกับเจ้าหน้าที่ค่ะ')
  await page.locator('#send').click()

  // The product speaking, not the AI: the sentence that says somebody is coming.
  await expect(page.locator('.bubble.system')).toBeVisible({ timeout: 30_000 })
  // And a standing line saying why nobody is typing.
  await expect(page.locator('#state')).toBeVisible()
  await expect(page.locator('#state')).not.toBeEmpty()
})

test('the loader script is served for a host page to embed', async ({ request }) => {
  const response = await request.get(`${API_URL}/widget/loader.js`)

  expect(response.status()).toBe(200)
  const body = await response.text()
  // The contract with salon-saas: a script tag carrying data-channel, and nothing else.
  expect(body).toContain('data-channel')
  expect(body).toContain('/widget/index.html')
})

test('the widget is set up and previewed from settings', async ({ page }) => {
  // Everything needed to put the widget on a website, where an operator configures it.
  await signIn(page)
  await page.goto('/settings?tab=channels')

  // The web channel's own configure panel.
  const configure = page
    .locator('div', { hasText: /^Web widget/ })
    .getByRole('button', { name: 'ตั้งค่า' })
    .first()
  await expect(configure).toBeVisible({ timeout: 20_000 })
  await configure.click()

  // The snippet carries the real channel id, which is the one thing nobody can be expected
  // to remember and which fails silently on somebody else's page if it is wrong.
  const snippet = page.getByTestId('widget-snippet')
  await expect(snippet).toBeVisible()
  await expect(snippet).toContainText('data-channel=')
  await expect(snippet).toContainText('/widget/loader.js')

  // Unrestricted until somebody says otherwise, and it says so.
  await expect(page.getByTestId('allowed-origins')).toHaveValue('')

  // The preview runs the real widget against the same channel.
  await page.getByTestId('toggle-widget-preview').click()
  const preview = page.getByTestId('widget-preview')
  await expect(preview).toBeVisible()
  await expect(page.frameLocator('[data-testid="widget-preview"]').locator('#text')).toBeVisible({
    timeout: 20_000,
  })
})

test('setting the allowed origins keeps the rest of the channel config', async ({
  page,
  request,
}) => {
  // The console can only send what somebody edited, because it may not read a secret back.
  // Replacing the whole config meant saving the origins erased the visitor token secret.
  const channels = await request.get(`${API_URL}/api/v1/settings/channels`)
  const before = (await channels.json()) as { channels: { id: string; type: string }[] }
  const web = before.channels.find((c) => c.type === 'web')
  if (!web) throw new Error('no web channel')

  await request.patch(`${API_URL}/api/v1/settings/channels/${web.id}`, {
    data: { config: { visitorTokenSecret: 'a-secret-long-enough-to-pass' } },
  })
  await request.patch(`${API_URL}/api/v1/settings/channels/${web.id}`, {
    data: { config: { allowedOrigins: ['https://app.example.com'] } },
  })

  await signIn(page)
  await page.goto('/settings?tab=channels')
  const configure = page
    .locator('div', { hasText: /^Web widget/ })
    .getByRole('button', { name: 'ตั้งค่า' })
    .first()
  await configure.click()

  await expect(page.getByTestId('allowed-origins')).toHaveValue('https://app.example.com', {
    timeout: 20_000,
  })

  // The secret survived, so the widget can still identify a logged-in visitor.
  const after = await request.get(`${API_URL}/api/v1/settings/channels`)
  const web2 = ((await after.json()) as { channels: { id: string; hasConfig: boolean }[] }).channels
  expect(web2.find((c) => c.id === web.id)?.hasConfig).toBe(true)

  // Put it back, so a later run starts unrestricted like the seed leaves it.
  await request.patch(`${API_URL}/api/v1/settings/channels/${web.id}`, {
    data: { config: { allowedOrigins: [] } },
  })
})

test('the dashboard reports what the pilot is doing', async ({ page, request }) => {
  // Real traffic first, so the figures are computed from the same tables everything else
  // writes to rather than from a fixture.
  const channelId = await findTestChannelId(request)
  const customer = uniqueCustomer('dash')
  await customerSays(request, channelId, customer, 'สวัสดีค่ะ ราคาเท่าไหร่')

  await signIn(page)
  await page.goto('/dashboard')

  await expect(page.getByTestId('figure-conversations')).toBeVisible({ timeout: 20_000 })

  // Every day in the window has a bar, including the quiet ones: a gap would read as
  // missing data rather than as nothing having happened.
  await expect(page.locator('[data-testid="volume-chart"] > div')).toHaveCount(14)

  // The window is selectable, and the chart follows it.
  await page.getByTestId('window-7').click()
  await expect(page.locator('[data-testid="volume-chart"] > div')).toHaveCount(7)

  // The conversation just created is counted. Read as a number rather than matched as
  // text: the panel also carries a hint, and "0" appears inside plenty of larger figures.
  const counted = await page.getByTestId('figure-conversations').locator('div').nth(1).innerText()
  expect(Number(counted.replace(/[^0-9]/g, ''))).toBeGreaterThan(0)
  await expect(page.getByTestId('channel-breakdown')).toContainText('test', { timeout: 20_000 })

  // And the figures an operator acts on are present rather than blank panels.
  await expect(page.getByTestId('figure-answered')).toBeVisible()
  await expect(page.getByTestId('figure-first-response')).toBeVisible()
  await expect(page.getByTestId('figure-cost')).toBeVisible()
})

test('a note cannot be written against a conversation id the workspace does not own', async ({
  request,
}) => {
  // Every sibling route loads the conversation under the workspace before acting. The notes
  // route once did not, so a note posted at a foreign id would land in that workspace's
  // thread. The seeded workspace owns no conversation with this id, so it must be refused.
  const response = await request.post(
    `${API_URL}/api/v1/conversations/not-ours-${uniqueToken()}/notes`,
    {
      data: { body: 'should never be stored' },
    },
  )
  expect(response.status()).toBe(404)
})

/**
 * Which channel a thread is on, shown on the row and in the header.
 *
 * One person reaching us on two channels has two conversations that are otherwise identical
 * at a glance, which is the case this exists for.
 */
test('a conversation says which channel it arrived on', async ({ page, request }) => {
  await apiSignIn(request)
  await configureMockProvider(request)
  const channelId = await findTestChannelId(request)
  const customer = uniqueCustomer('channel')
  await customerSays(request, channelId, customer, 'สวัสดีค่ะ')

  await signIn(page)
  const row = page.locator('[data-testid="conversation-row"]').filter({ hasText: customer })
  await expect(row).toBeVisible({ timeout: 25_000 })

  // The simulator channel, in whichever language the console is showing.
  await expect(row.getByTestId('conversation-channel')).toHaveText(/Simulator|ทดลอง/)

  await row.click()
  await expect(page.getByTestId('conversation-channel-header')).toHaveText(/Simulator|ทดลอง/, {
    timeout: 15_000,
  })
})
