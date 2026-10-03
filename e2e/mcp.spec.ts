import { type ChildProcess, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { expect, test } from '@playwright/test'
import {
  apiSignIn,
  clearTools,
  configureMockProvider,
  customerSays,
  findTestChannelId,
  signIn,
  uniqueCustomer,
  uniqueToken,
} from './helpers'

/**
 * Connecting an MCP server from Settings and the AI using it (ADR 0011). The server is the
 * SDK's own, run as a process: Playwright runs on Node and the test server is Bun's.
 */

const processes: ChildProcess[] = []
let mcpUrl = ''
let oauthUrl = ''

/** Start a test server script and read the URL it prints. */
async function serve(script: string): Promise<string> {
  const child = spawn('bun', ['run', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  processes.push(child)
  const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream })
  for await (const line of lines) return line
  throw new Error(`${script} printed nothing`)
}

test.beforeAll(async () => {
  mcpUrl = await serve('packages/infra/test/helpers/mcp-server-cli.ts')
  oauthUrl = await serve('packages/infra/test/helpers/oauth-mcp-server-cli.ts')
})

test.afterAll(() => {
  for (const child of processes) child.kill()
})

test.beforeEach(async ({ request }) => {
  await apiSignIn(request)
  await configureMockProvider(request)
  await clearTools(request)
})

test.afterEach(async ({ request }) => {
  await clearTools(request)
})

test('an admin connects a server, allows a tool, and the AI answers from it', async ({
  page,
  request,
}) => {
  await signIn(page)
  await page.goto('/settings?tab=integrations')
  const card = page.getByTestId('mcp-card')
  await card.getByTestId('mcp-add').click()
  await card.getByTestId('mcp-name').fill('shop')
  await card.getByTestId('mcp-url').fill(mcpUrl)
  await card.getByTestId('mcp-header-name').fill('x-api-key')
  await card.getByTestId('mcp-token').fill('sesame')
  await card.getByTestId('mcp-save').click()

  await card.getByTestId('mcp-open-shop').click()
  await card.getByTestId('mcp-fetch-shop').click()
  await expect(card.getByTestId('mcp-tool-lookup_order')).toBeVisible()

  // The server marks it read-only, so it is a read once ticked; one it marks as changing
  // things cannot be a read at all.
  await card.getByTestId('mcp-allow-lookup_order').check()
  await expect(card.getByTestId('mcp-effect-lookup_order')).toHaveValue('read')
  await card.getByTestId('mcp-allow-cancel-order').check()
  await expect(card.getByTestId('mcp-effect-cancel-order')).toHaveValue('write')
  await expect(
    card.getByTestId('mcp-effect-cancel-order').locator('option[value="read"]'),
  ).toBeDisabled()
  await card.getByTestId('mcp-allow-cancel-order').uncheck()
  await card.getByTestId('mcp-allow-save-shop').click()
  await expect(card.getByTestId('mcp-test-tool')).toBeVisible()

  await card.getByTestId('mcp-test-args').fill('{"order_id":"SO-1"}')
  await card.getByTestId('mcp-test-run').click()
  await expect(card.getByTestId('mcp-test-result')).toContainText('order SO-1 for nobody: shipped')

  // And a customer asking about an order gets the server's answer.
  const channelId = await findTestChannelId(request)
  const customer = uniqueCustomer('mcp')
  const order = `SO-${uniqueToken()}`
  await customerSays(request, channelId, customer, `Where is my order ${order}?`)
  await page.goto('/')
  await page.getByTestId('conversation-row').filter({ hasText: customer }).click({
    timeout: 25_000,
  })
  // In the thread and in the row's preview alike; either proves it reached the customer.
  await expect(
    page.getByText(`ผลการตรวจสอบ: order ${order} for nobody: shipped`).first(),
  ).toBeVisible({ timeout: 25_000 })
})

test('an admin signs in to an OAuth server and comes back connected', async ({ page }) => {
  await signIn(page)
  await page.goto('/settings?tab=integrations')
  const card = page.getByTestId('mcp-card')
  await card.getByTestId('mcp-add').click()
  await card.getByTestId('mcp-name').fill('hosted')
  await card.getByTestId('mcp-url').fill(oauthUrl)
  await card.getByTestId('mcp-auth').selectOption('oauth')
  await card.getByTestId('mcp-save').click()
  await expect(card.getByTestId('mcp-signin-state-hosted')).toBeVisible()

  // Off to the server's own page, which approves at once, and back through the callback.
  await card.getByTestId('mcp-signin-hosted').click()
  await page.waitForURL(/\/settings\?tab=integrations&mcp=connected/)
  await expect(page.getByTestId('mcp-signed-in')).toBeVisible()
  await expect(page.getByTestId('mcp-card').getByTestId('mcp-signin-state-hosted')).toHaveText(
    /Signed in|ลงชื่อเข้าใช้แล้ว/,
  )

  // Signed in, its tools can be fetched.
  await page.getByTestId('mcp-card').getByTestId('mcp-open-hosted').click()
  await page.getByTestId('mcp-card').getByTestId('mcp-fetch-hosted').click()
  await expect(page.getByTestId('mcp-card').getByTestId('mcp-tool-lookup_order')).toBeVisible()
})
