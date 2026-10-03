import { expect, test } from '@playwright/test'
import { API_URL, apiSignIn, signIn, uniqueToken } from './helpers'

/**
 * UX audit U11: after an edit the entry says it is being indexed, and then that the AI can
 * find it, without a reload.
 */
test('an edited entry says when the AI can find it', async ({ page, request }) => {
  await apiSignIn(request)
  const created = await request.post(`${API_URL}/api/v1/knowledge/sources`, {
    data: {
      title: `indexed ${uniqueToken()}`,
      language: 'en',
      question: null,
      body: 'Support answers within a day.',
    },
  })
  const { sourceId } = (await created.json()) as { sourceId: string }

  try {
    await signIn(page)
    await page.goto('/knowledge')
    await page.getByTestId(`knowledge-source-${sourceId}`).click()
    await expect(page.getByTestId('entry-ready')).toBeVisible({ timeout: 20_000 })

    const body = page.getByTestId('entry-body')
    await body.fill('Support answers within an hour.')
    const saved = page.waitForResponse(
      (r) => r.request().method() === 'PATCH' && r.url().includes('/knowledge/entries/'),
    )
    await body.blur()
    expect((await saved).ok()).toBe(true)
    // The worker indexes the new text and records which revision it holds.
    await expect
      .poll(
        async () => {
          const { entries } = (await (
            await request.get(`${API_URL}/api/v1/knowledge/sources/${sourceId}/entries`)
          ).json()) as {
            entries: { body: string; updatedAt: string; indexedRevision: string | null }[]
          }
          const entry = entries[0]
          return (
            entry?.body === 'Support answers within an hour.' &&
            entry.indexedRevision === entry.updatedAt
          )
        },
        { timeout: 20_000 },
      )
      .toBe(true)
    // And the page says so on its own, without a reload.
    await expect(page.getByTestId('entry-ready')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('entry-indexing')).toHaveCount(0)
  } finally {
    await request.delete(`${API_URL}/api/v1/knowledge/sources/${sourceId}`)
  }
})
