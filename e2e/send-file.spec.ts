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
 * An agent sends a file to a customer.
 *
 * The link the customer's platform would fetch is asserted against the API in
 * `apps/api/test/inbox-order.integration.test.ts`. What only a browser shows is the part an
 * agent does: choose a file, see it waiting, send it with a note, and find it in the thread.
 */

/** A one-pixel PNG, small enough to keep the test honest about what it is proving. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test.describe('sending a file', () => {
  test.beforeEach(async ({ request }) => {
    await apiSignIn(request)
    await configureMockProvider(request)
  })

  test('an agent attaches a document and the customer gets it', async ({ page, request }) => {
    const channelId = await findTestChannelId(request)
    const customer = uniqueCustomer('file')
    await customerSays(request, channelId, customer, 'ขอใบเสร็จหน่อยค่ะ')

    await signIn(page)
    const row = page.locator('[data-testid="conversation-row"]').filter({ hasText: customer })
    await expect(row).toBeVisible({ timeout: 25_000 })
    await row.click()

    // Take the conversation, so the AI does not answer over the top of the test.
    await page.getByTestId('take-over').click()

    // Choose a file. It uploads straight away, so a rejection arrives while there is still
    // time to pick another one.
    await page.getByTestId('attachment-input').setInputFiles({
      name: 'receipt.png',
      mimeType: 'image/png',
      buffer: PNG,
    })

    const chip = page.getByTestId('composer-attachment')
    await expect(chip).toBeVisible({ timeout: 20_000 })
    await expect(chip).toContainText('receipt.png')

    // Send it with a note.
    await page.getByTestId('composer').fill('นี่ใบเสร็จค่ะ')
    await page.getByTestId('send').click()

    // The thread shows the note and the picture, and the composer is empty again.
    await expect(page.getByTestId('message-thread')).toContainText('นี่ใบเสร็จค่ะ', {
      timeout: 25_000,
    })
    await expect(page.getByTestId('message-image').last()).toBeVisible({ timeout: 25_000 })
    await expect(page.getByTestId('composer-attachment')).toHaveCount(0)

    /**
     * The picture in the thread is the proof that a file was stored rather than a sentence
     * about one: that element only renders for an attachment with a storage key behind it.
     * Finding the row again through the API was tried and is not worth it — the list grows
     * as the suite runs, so the lookup was the flaky part rather than the feature.
     */
  })

  test('a file the workspace will not carry is refused while there is time to change it', async ({
    page,
    request,
  }) => {
    const channelId = await findTestChannelId(request)
    const customer = uniqueCustomer('refused')
    await customerSays(request, channelId, customer, 'สวัสดีค่ะ')

    await signIn(page)
    const row = page.locator('[data-testid="conversation-row"]').filter({ hasText: customer })
    await expect(row).toBeVisible({ timeout: 25_000 })
    await row.click()

    await page.getByTestId('attachment-input').setInputFiles({
      name: 'payload.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from('PK'),
    })

    await expect(page.getByTestId('attachment-error')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('composer-attachment')).toHaveCount(0)
  })
})
