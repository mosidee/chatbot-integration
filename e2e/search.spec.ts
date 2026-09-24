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

/** U03: an agent looking for one customer types what they know about them. */

test('the inbox finds a conversation by something the customer said', async ({ page, request }) => {
  await apiSignIn(request)
  await configureMockProvider(request)
  const channelId = await findTestChannelId(request)

  const phrase = `ordernumber${uniqueToken()}`
  const wanted = uniqueCustomer('search')
  const other = uniqueCustomer('search-other')
  await customerSays(request, channelId, wanted, `my reference is ${phrase}`)
  await customerSays(request, channelId, other, `hello ${uniqueToken()}`)

  await signIn(page)
  await expect(
    page.getByTestId('conversation-row').filter({ hasText: wanted }).first(),
  ).toBeVisible({ timeout: 25_000 })

  await page.getByTestId('inbox-search').fill(phrase)
  await expect(page.getByTestId('conversation-row')).toHaveCount(1)
  await expect(page.getByTestId('conversation-row')).toContainText(wanted)

  await page.getByTestId('inbox-search').fill('')
  await expect(
    page.getByTestId('conversation-row').filter({ hasText: other }).first(),
  ).toBeVisible()
})
