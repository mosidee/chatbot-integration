import { expect, test } from '@playwright/test'
import { API_URL, apiSignIn, signIn, uniqueToken } from './helpers'

/**
 * U11: two admins with Settings open. The one who saves second used to put back whatever
 * their page had loaded, over a colleague's change they never saw.
 */

test('a save over a colleague’s newer settings is refused and shows their version', async ({
  page,
  request,
}) => {
  await apiSignIn(request)
  const original = (await (await request.get(`${API_URL}/api/v1/settings/workspace`)).json()) as {
    settings: { persona: string }
  }

  try {
    await signIn(page)
    await page.goto('/settings?tab=general')
    const persona = page.locator('#persona')
    await expect(persona).toBeVisible()

    // A colleague saves from the same version the page loaded.
    const loaded = (await (await request.get(`${API_URL}/api/v1/settings/workspace`)).json()) as {
      revision: string
    }
    const theirs = `colleague persona ${uniqueToken()}`
    const saved = await request.patch(`${API_URL}/api/v1/settings/workspace`, {
      data: { persona: theirs, revision: loaded.revision },
    })
    expect(saved.ok()).toBe(true)

    await persona.fill(`my persona ${uniqueToken()}`)
    await persona.blur()

    await expect(page.getByTestId('settings-conflict')).toBeVisible()
    await expect(page.locator('#persona')).toHaveValue(theirs)

    // Editing from the version now shown goes through.
    const mine = `my second try ${uniqueToken()}`
    await page.locator('#persona').fill(mine)
    await page.locator('#persona').blur()
    await expect(page.getByTestId('settings-conflict')).toHaveCount(0)
    await expect
      .poll(async () => {
        const now = (await (await request.get(`${API_URL}/api/v1/settings/workspace`)).json()) as {
          settings: { persona: string }
        }
        return now.settings.persona
      })
      .toBe(mine)
  } finally {
    await request.patch(`${API_URL}/api/v1/settings/workspace`, {
      data: { persona: original.settings.persona },
    })
  }
})

test('an entry edit started before a colleague’s change is refused, even after a refresh', async ({
  page,
  request,
}) => {
  await apiSignIn(request)
  const title = `revision ${uniqueToken()}`
  const created = await request.post(`${API_URL}/api/v1/knowledge/sources`, {
    data: { title, language: 'en', question: null, body: 'The trial is fourteen days.' },
  })
  const { sourceId } = (await created.json()) as { sourceId: string }

  try {
    await signIn(page)
    await page.goto('/knowledge')
    await page.getByTestId(`knowledge-source-${sourceId}`).click()
    const body = page.getByTestId('entry-body')
    await expect(body).toHaveValue('The trial is fourteen days.')
    // Editing starts from the version on screen.
    await body.click()

    const { entries } = (await (
      await request.get(`${API_URL}/api/v1/knowledge/sources/${sourceId}/entries`)
    ).json()) as { entries: { id: string; updatedAt: string }[] }
    const entry = entries[0]
    if (!entry) throw new Error('the source has no entry')
    const theirs = 'The trial is thirty days.'
    const saved = await request.patch(`${API_URL}/api/v1/knowledge/entries/${entry.id}`, {
      data: { body: theirs, revision: entry.updatedAt },
    })
    expect(saved.ok()).toBe(true)

    // The console refreshes the entry in the background while the field is being edited,
    // which is what used to hand the save the colleague's revision.
    // Past the console's ten-second freshness, so returning to the tab refetches.
    await page.waitForTimeout(10_500)
    const refreshed = page.waitForResponse((r) => r.url().endsWith(`/sources/${sourceId}/entries`))
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
    await refreshed

    await body.fill('The trial is seven days.')
    await body.blur()
    await expect(page.getByTestId('entry-conflict')).toBeVisible()
    await expect(body).toHaveValue(theirs)
  } finally {
    await request.delete(`${API_URL}/api/v1/knowledge/sources/${sourceId}`)
  }
})
