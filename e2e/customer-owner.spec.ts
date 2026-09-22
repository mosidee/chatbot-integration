import { expect, test } from '@playwright/test'
import {
  API_URL,
  apiSignIn,
  customerSays,
  findTestChannelId,
  signIn,
  uniqueCustomer,
} from './helpers'

/**
 * Giving a customer an owner, and watching the queue reorder because of it.
 *
 * The ordering is asserted properly against the database in
 * `apps/api/test/inbox-order.integration.test.ts`. What this adds is the part only a browser
 * can show: that an agent can hand a customer to somebody from the sidebar, and that the
 * list they are looking at rearranges itself as a result.
 */

test.describe('the account owner', () => {
  test.beforeEach(async ({ request }) => {
    await apiSignIn(request)
  })

  test('is set from the sidebar and lifts that customer up the inbox', async ({
    page,
    request,
  }) => {
    const channelId = await findTestChannelId(request)

    // Two customers. The quiet one is claimed, so ownership has to beat recency for it to
    // come first: without the feature the newest conversation would be at the top.
    const mine = uniqueCustomer('owned')
    const theirs = uniqueCustomer('unowned')
    await customerSays(request, channelId, mine, 'สวัสดีค่ะ ขอสอบถามเรื่องแพ็กเกจ')
    await customerSays(request, channelId, theirs, 'สวัสดีค่ะ')

    await signIn(page)

    const ownedRow = page.locator('[data-testid="conversation-row"]').filter({ hasText: mine })
    await expect(ownedRow).toBeVisible({ timeout: 25_000 })
    await ownedRow.click()

    // Claim the customer. Selected by id rather than by the visible label: the console
    // defaults to Thai, so matching an English option name would pick nothing.
    const me = await (await request.get(`${API_URL}/api/v1/settings/me`)).json()
    const picker = page.getByTestId('customer-assignee')
    await expect(picker).toBeVisible({ timeout: 15_000 })
    await picker.selectOption(me.userId)

    // The row now says who owns it, and sits at the top of the queue.
    const firstRow = page.locator('[data-testid="conversation-row"]').first()
    await expect(firstRow).toContainText(mine, { timeout: 25_000 })
    await expect(ownedRow.getByTestId('conversation-owner')).toBeVisible()

    // And it survives a reload, because it is on the customer rather than the session.
    await page.reload()
    await expect(page.locator('[data-testid="conversation-row"]').first()).toContainText(mine, {
      timeout: 25_000,
    })

    // Let them go again, so the seeded workspace is left as it was found.
    await ownedRow.click()
    await expect(page.getByTestId('customer-assignee')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('customer-assignee').selectOption('')

    // Wait for the list to agree before asking the API, or the check races the request.
    await expect(ownedRow.getByTestId('conversation-owner')).toHaveCount(0, { timeout: 15_000 })

    const customers = await request.get(`${API_URL}/api/v1/conversations?limit=100`)
    const body = (await customers.json()) as {
      conversations: { customer: { displayName: string | null; assigneeUserId: string | null } }[]
    }
    const row = body.conversations.find((c) => c.customer.displayName === mine)
    expect(row?.customer.assigneeUserId ?? null).toBeNull()
  })
})
