import { expect, test } from '@playwright/test'
import {
  apiSignIn,
  configureMockProvider,
  customerSays,
  failNext,
  findTestChannelId,
  signIn,
  uniqueCustomer,
  uniqueToken,
} from './helpers'

/**
 * U01, U02: what the console does when something fails, and what happens to what an agent
 * was writing. Each of these used to fail in silence or throw the words away.
 */

test.beforeEach(async ({ request }) => {
  await apiSignIn(request)
  await configureMockProvider(request)
})

async function openConversation(
  page: import('@playwright/test').Page,
  request: import('@playwright/test').APIRequestContext,
  label: string,
) {
  const channelId = await findTestChannelId(request)
  const customer = uniqueCustomer(label)
  await customerSays(request, channelId, customer, `hello ${uniqueToken()}`)
  const row = page.getByTestId('conversation-row').filter({ hasText: customer })
  await expect(row).toBeVisible({ timeout: 25_000 })
  await row.click()
  await expect(page.getByTestId('message-thread')).toBeVisible()
  return { customer, row }
}

test('a failed send says so and keeps the reply in the box', async ({ page, request }) => {
  await signIn(page)
  await openConversation(page, request, 'sendfail')
  await page.getByTestId('take-over').click()

  const reply = `reply ${uniqueToken()}`
  await page.getByTestId('composer').fill(reply)
  await failNext(page, /\/api\/v1\/conversations\/[^/]+\/messages$/, { method: 'POST' })
  await page.getByTestId('send').click()

  await expect(page.getByTestId('send-error')).toBeVisible()
  await expect(page.getByTestId('composer')).toHaveValue(reply)

  // And trying again works, without a reload.
  await page.getByTestId('send').click()
  await expect(page.getByTestId('message-thread')).toContainText(reply, { timeout: 20_000 })
  await expect(page.getByTestId('send-error')).toHaveCount(0)
})

test('a queue that failed to load is not shown as empty', async ({ page }) => {
  await signIn(page)
  await failNext(page, /\/api\/v1\/conversations\?/, { status: 'network', times: 5 })
  await page.goto('/?tab=resolved')
  await expect(page.getByTestId('inbox-load-failed')).toBeVisible()
})

test('a draft stays with its conversation when the agent looks at another', async ({
  page,
  request,
}) => {
  await signIn(page)
  const first = await openConversation(page, request, 'draft-a')
  const draft = `half-written ${uniqueToken()}`
  await page.getByTestId('composer').fill(draft)

  await openConversation(page, request, 'draft-b')
  await expect(page.getByTestId('composer')).toHaveValue('')

  await first.row.click()
  await expect(page.getByTestId('composer')).toHaveValue(draft)
})

test('the open conversation survives a reload', async ({ page, request }) => {
  await signIn(page)
  const { customer } = await openConversation(page, request, 'reload')
  await expect(page).toHaveURL(/[?&]c=/)
  await page.reload()
  await expect(page.getByTestId('message-thread')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('conversation-channel-header')).toBeVisible()
  await expect(page.getByTestId('message-thread')).toBeVisible()
  await expect(page.locator('main header')).toContainText(customer)
})
