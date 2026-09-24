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
