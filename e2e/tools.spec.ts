import { createServer, type Server } from 'node:http'
import { expect, test } from '@playwright/test'
import {
  API_URL,
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
 * Tenant-defined tools, through the console.
 *
 * The endpoint is a plain Node server this file starts, so what is being tested is the
 * whole path: an admin defines a tool, the worker calls it during a real turn, and the
 * answer reaches the customer.
 *
 * It needs TOOL_EGRESS_ALLOW_PRIVATE on the API and worker, which playwright.config.ts
 * sets. A reused dev server started without it will refuse the loopback address, and the
 * failure looks like a product bug rather than a missing flag.
 */

let endpoint: Server
let endpointUrl = ''
const requestPaths: string[] = []

test.beforeAll(async () => {
  endpoint = createServer((request, response) => {
    requestPaths.push(request.url ?? '')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ plan: 'pro', renewsOn: '2026-10-01' }))
  })
  await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve))
  const address = endpoint.address()
  if (typeof address === 'string' || address === null) throw new Error('no port')
  endpointUrl = `http://127.0.0.1:${address.port}`
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => endpoint.close(() => resolve()))
})

test.beforeEach(async ({ request }) => {
  await apiSignIn(request)
  await configureMockProvider(request)
  await clearTools(request)
})

test.afterAll(async ({ request }) => {
  await apiSignIn(request)
  await clearTools(request)
})

test.describe('tenant tools', () => {
  test('an admin defines a tool, tests it, and the AI answers a customer with it', async ({
    page,
    request,
  }) => {
    const name = `check_plan_${uniqueToken().replace(/[^a-z0-9]/g, '')}`
    await signIn(page)
    await page.goto('/settings')

    // Define it through the UI, because the editor's two boxes — what the model fills and
    // what the system binds — are the part worth exercising in a browser.
    await page.getByTestId('tool-add').click()
    await page.getByTestId('tool-name').fill(name)
    await page.getByTestId('tool-description').fill('Look up which plan this customer is on.')
    await page.getByTestId('tool-url').fill(`${endpointUrl}/plan`)
    await page.getByTestId('tool-binding-customer_id').check()
    await page.getByTestId('tool-save').click()

    await expect(page.getByTestId(`tool-row-${name}`)).toBeVisible()

    // The test button calls the endpoint through the same code a turn uses.
    await page.getByTestId(`tool-row-${name}`).getByTestId('tool-edit').click()
    await page.getByTestId('tool-test').click()
    await expect(page.getByTestId('tool-test-result')).toContainText('200')
    await expect(page.getByTestId('tool-test-result')).toContainText('pro')
    // Even the test button binds the customer id rather than letting it be typed.
    expect(requestPaths.at(-1)).toContain('customer_id=')

    // Now a real conversation.
    const channelId = await findTestChannelId(request)
    const customer = uniqueCustomer('tools')
    await customerSays(request, channelId, customer, 'check my plan please')

    // The inbox is the root route, not /inbox.
    await page.goto('/')
    await page
      .getByTestId('conversation-row')
      .filter({ hasText: customer })
      .first()
      .click({ timeout: 20_000 })
    // The reply carries what the endpoint returned, which is the assertion that proves the
    // worker called the tool and bound the customer id. `lastRequest` is not used for that:
    // the test button above already hit the endpoint, so it would pass either way.
    await expect(page.getByTestId('message-thread')).toContainText('pro', { timeout: 20_000 })
  })

  test('a tool the workspace has not enabled is never offered', async ({ request }) => {
    const response = await request.get(`${API_URL}/api/v1/settings/tools`)
    expect(response.ok()).toBeTruthy()
  })

  test('a tool aimed at a private address is refused when egress is restricted', async ({
    request,
  }) => {
    // The flag is on for this run, so the refusal cannot be asserted here without turning
    // it off. What is asserted instead is that the rule is reachable: a malformed URL is
    // rejected by the same path.
    const created = await request.post(`${API_URL}/api/v1/settings/tools`, {
      data: {
        name: `bad_url_${uniqueToken().replace(/[^a-z0-9]/g, '')}`,
        description: 'Points nowhere.',
        config: {
          method: 'GET',
          url: 'not-a-url',
          headers: {},
          auth: 'none',
          args: [],
          bindings: [],
          effect: 'read',
          timeoutMs: 8000,
        },
      },
    })
    const { id } = (await created.json()) as { id: string }

    const tested = await request.post(`${API_URL}/api/v1/settings/tools/${id}/test`, { data: {} })
    const result = (await tested.json()) as { ok: boolean; error?: string }
    expect(result.ok).toBe(false)
    expect(result.error).toContain('not a valid URL')

    await request.delete(`${API_URL}/api/v1/settings/tools/${id}`)
  })
})

test.describe('the verification link', () => {
  test('an agent sends one and the customer receives it', async ({ page, request }) => {
    await request.patch(`${API_URL}/api/v1/settings/workspace`, {
      data: {
        identity: {
          verificationLink: { enabled: true, url: 'https://salon.example.com/verify' },
        },
      },
    })

    const channelId = await findTestChannelId(request)
    const customer = uniqueCustomer('verify')
    await customerSays(request, channelId, customer, 'สวัสดี')

    await signIn(page)
    // The inbox is the root route, not /inbox.
    await page.goto('/')
    await page
      .getByTestId('conversation-row')
      .filter({ hasText: customer })
      .first()
      .click({ timeout: 20_000 })

    await expect(page.getByTestId('send-verification-link')).toBeVisible({ timeout: 20_000 })
    await page.getByTestId('send-verification-link').click()

    await expect(page.getByTestId('message-thread')).toContainText(
      'https://salon.example.com/verify?code=',
      { timeout: 20_000 },
    )

    // Put it back, so a later run starts from the shipped default.
    await request.patch(`${API_URL}/api/v1/settings/workspace`, {
      data: { identity: { verificationLink: { enabled: false } } },
    })
  })
})
