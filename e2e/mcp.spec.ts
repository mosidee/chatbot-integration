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

let mcp: ChildProcess | null = null
let mcpUrl = ''

test.beforeAll(async () => {
  mcp = spawn('bun', ['run', 'packages/infra/test/helpers/mcp-server-cli.ts'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const lines = createInterface({ input: mcp.stdout as NodeJS.ReadableStream })
  for await (const line of lines) {
    mcpUrl = line
    break
  }
})

test.afterAll(() => {
  mcp?.kill()
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
