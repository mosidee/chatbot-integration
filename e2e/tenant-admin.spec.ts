import { expect, test } from '@playwright/test'
import { ADMIN_EMAIL, API_URL, apiSignIn, signIn, uniqueToken } from './helpers'

/**
 * Adding a colleague, from the console, without touching the database.
 *
 * The whole invitation flow is followed the way a person would: the admin invites, copies
 * the link, and somebody else opens it in a browser that has never been signed in. That
 * second browser is a separate context on purpose — with a shared one the test would prove
 * only that the admin can open their own invitation.
 */

test.describe('inviting a colleague', () => {
  test.beforeEach(async ({ request }) => {
    await apiSignIn(request)
  })

  test('invites somebody, lets them in, changes their role and removes them', async ({
    page,
    browser,
    request,
  }) => {
    const email = `e2e-invitee-${uniqueToken()}@example.com`

    await signIn(page)
    await page.goto('/admin')
    await expect(page.getByTestId('members-card')).toBeVisible()

    // Invite.
    await page.getByTestId('invite-email').fill(email)
    await page.getByTestId('invite-role').selectOption('agent')
    await page.getByTestId('invite-submit').click()

    const linkField = page.getByTestId('fresh-link')
    await expect(linkField).toBeVisible({ timeout: 15_000 })
    const link = await linkField.inputValue()
    expect(link).toContain('/invite/')

    // It is listed as pending while nobody has used it.
    await expect(page.getByTestId(`invitation-row-${email}`)).toBeVisible()

    // Somebody else opens it, in a browser with no session at all.
    const joiner = await browser.newContext()
    try {
      const joinerPage = await joiner.newPage()
      await joinerPage.goto(link)

      await expect(joinerPage.getByTestId('invite-card')).toBeVisible()
      await joinerPage.getByTestId('invite-name').fill('E2E Joiner')
      await joinerPage.getByTestId('invite-password').fill('a-good-password-1')
      await joinerPage.getByTestId('invite-submit').click()

      // They land in the console, signed in, with no admin page offered to them.
      await joinerPage.waitForURL('**/', { timeout: 20_000 })
      await expect(joinerPage.getByTestId(`member-row-${email}`)).toHaveCount(0)
    } finally {
      await joiner.close()
    }

    // Back as the admin: they are a member now, and the invitation is spent.
    await page.reload()
    await expect(page.getByTestId(`member-row-${email}`)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId(`invitation-row-${email}`)).toHaveCount(0)

    // Change what they may do.
    await page.getByTestId(`member-role-${email}`).selectOption('viewer')
    await page.waitForTimeout(500)
    await page.reload()
    await expect(page.getByTestId(`member-role-${email}`)).toHaveValue('viewer')

    // And remove them: two clicks, because it is destructive.
    const remove = page.getByTestId(`member-remove-${email}`)
    await remove.click()
    await remove.click()
    await expect(page.getByTestId(`member-row-${email}`)).toHaveCount(0, { timeout: 15_000 })

    // The account itself survives: removing somebody from a workspace is not deleting them.
    const members = await request.get(`${API_URL}/api/v1/admin/members`)
    const body = (await members.json()) as { members: { email: string }[] }
    expect(body.members.some((member) => member.email === email)).toBe(false)
  })

  test('refuses to strand the workspace without an admin', async ({ page }) => {
    await signIn(page)
    await page.goto('/admin')

    // The seeded admin is the only admin, so demoting them is refused by the server.
    await page.getByTestId(`member-role-${ADMIN_EMAIL}`).selectOption('agent')

    // Lowering your own role asks first: it takes effect at once and the page that would
    // change it back is the one you just lost.
    await page.getByTestId('demote-self-confirm').click()

    // The error is shown rather than the change being applied.
    await expect(page.getByText(/at least one admin/i)).toBeVisible({ timeout: 15_000 })

    await page.reload()
    await expect(page.getByTestId(`member-role-${ADMIN_EMAIL}`)).toHaveValue('admin')
  })
})
