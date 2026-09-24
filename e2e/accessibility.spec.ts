import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { apiSignIn, signIn } from './helpers'

/**
 * U07, U15: an automated accessibility pass over the pages an agent lives in.
 *
 * Critical findings only: a floor the console must never fall through, not a certificate.
 * Keyboard and screen-reader behaviour still needs a person; see docs/UX-AUDIT.md.
 */

test.beforeEach(async ({ request }) => {
  await apiSignIn(request)
})

for (const path of ['/', '/dashboard', '/knowledge', '/settings']) {
  test(`${path} has no critical accessibility failures`, async ({ page }) => {
    await signIn(page)
    await page.goto(path)
    await page.waitForLoadState('networkidle')
    const results = await new AxeBuilder({ page }).analyze()
    const critical = results.violations.filter((violation) => violation.impact === 'critical')
    expect(
      critical.map(
        (violation) => `${violation.id}: ${violation.nodes.map((n) => n.target).join(', ')}`,
      ),
    ).toEqual([])
  })
}

test('the console in dark mode and Thai renders its main pages @theme', async ({ page }) => {
  await signIn(page)
  for (const path of ['/', '/dashboard', '/settings']) {
    await page.goto(path)
    await expect(page.locator('main')).toBeVisible()
  }
  const results = await new AxeBuilder({ page }).withTags(['wcag2aa']).analyze()
  const critical = results.violations.filter((violation) => violation.impact === 'critical')
  expect(critical.map((violation) => violation.id)).toEqual([])
})
