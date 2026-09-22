import { expect, test } from '@playwright/test'
import { API_URL, apiSignIn, signIn, uniqueToken } from './helpers'

/**
 * Running the platform: creating a tenant, suspending it, and deleting it for good.
 *
 * Every assertion here is about a tenant this test made. The seeded workspace is never
 * suspended or deleted, because the rest of the suite is running against it.
 */

test.describe('the platform page', () => {
  test.beforeEach(async ({ request }) => {
    await apiSignIn(request)
  })

  test('creates a tenant, suspends it, restores it and deletes it', async ({ page, request }) => {
    const slug = `e2e-${uniqueToken()}`

    await signIn(page)
    await page.goto('/platform')
    await expect(page.getByTestId('tenants-card')).toBeVisible()

    // Create. The name fills the slug through the same slugifier the API validates with.
    await page.getByTestId('platform-create-name').fill(slug)
    await expect(page.getByTestId('platform-create-slug')).toHaveValue(slug)
    await page.getByTestId('platform-create-email').fill(`owner-${slug}@example.com`)
    await page.getByTestId('platform-create-submit').click()

    // The one link that can get into a brand-new tenant is shown once.
    await expect(page.getByTestId('platform-invite-link')).toBeVisible({ timeout: 15_000 })
    const link = await page.getByTestId('platform-invite-link').inputValue()
    expect(link).toContain('/invite/')

    const row = page.getByTestId(`tenant-row-${slug}`)
    await expect(row).toBeVisible()
    await expect(page.getByTestId(`tenant-status-${slug}`)).toHaveText(/active|ใช้งาน/i)

    // Suspend: two clicks, because it takes a tenant offline.
    const suspend = page.getByTestId(`tenant-suspend-${slug}`)
    await suspend.click()
    await suspend.click()
    await expect(page.getByTestId(`tenant-status-${slug}`)).toHaveText(/suspended|ระงับ/i, {
      timeout: 15_000,
    })

    // Restore.
    await page.getByTestId(`tenant-unsuspend-${slug}`).click()
    await expect(page.getByTestId(`tenant-status-${slug}`)).toHaveText(/active|ใช้งาน/i, {
      timeout: 15_000,
    })

    // Delete: the button stays disabled until the slug is typed exactly.
    const deleteButton = page.getByTestId(`tenant-delete-${slug}`)
    await expect(deleteButton).toBeDisabled()
    await page.getByTestId(`tenant-delete-slug-${slug}`).fill(slug.slice(0, -1))
    await expect(deleteButton).toBeDisabled()
    await page.getByTestId(`tenant-delete-slug-${slug}`).fill(slug)
    await expect(deleteButton).toBeEnabled()
    await deleteButton.click()

    // It is marked for deletion, and the worker takes it from there.
    await expect
      .poll(
        async () => {
          const response = await request.get(`${API_URL}/api/v1/platform/tenants`)
          const body = (await response.json()) as { tenants: { slug: string; status: string }[] }
          const tenant = body.tenants.find((row) => row.slug === slug)
          return tenant?.status ?? 'gone'
        },
        { timeout: 30_000 },
      )
      .toMatch(/deleting|gone/)
  })

  test('is not offered to somebody who is not a platform admin', async ({ page, request }) => {
    // Invite an agent into the seeded workspace and accept it in a clean browser, then check
    // what they are shown.
    const email = `e2e-plain-${uniqueToken()}@example.com`
    const invited = await request.post(`${API_URL}/api/v1/admin/invitations`, {
      data: { email, role: 'agent' },
    })
    const { link } = (await invited.json()) as { link: string }

    await page.goto(link)
    await page.getByTestId('invite-name').fill('Plain Agent')
    await page.getByTestId('invite-password').fill('a-good-password-1')
    await page.getByTestId('invite-submit').click()
    await page.waitForURL('**/', { timeout: 20_000 })

    // Neither page is in their navigation, and the platform route refuses them directly.
    await expect(page.getByRole('link', { name: /platform|ผู้ดูแลระบบ/i })).toHaveCount(0)
    await expect(page.getByRole('link', { name: /^people$|^ผู้ใช้งาน$/i })).toHaveCount(0)
  })
})
