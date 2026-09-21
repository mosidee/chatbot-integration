import type { APIRequestContext, Page } from '@playwright/test'

/**
 * Helpers shared by the browser tests.
 *
 * Setup that is not what a test is checking goes through the API rather than the UI: it is
 * faster, and a failure then points at the flow under test rather than at a form somewhere
 * else.
 */

export const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com'
export const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'changeme12345'
export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000'
export const MOCK_URL = process.env.E2E_MOCK_URL ?? 'http://localhost:4010'

/**
 * Controls are found by test id, not by label text. The console ships in Thai and English
 * and defaults to Thai, so matching visible words would make these tests depend on which
 * language happens to be active.
 */
export async function signIn(page: Page): Promise<void> {
  await page.goto('/login')
  await page.getByTestId('login-email').fill(ADMIN_EMAIL)
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD)
  await page.getByTestId('login-submit').click()
  await page.waitForURL('**/')
}

/** An authenticated API context, for arranging state a test depends on but does not check. */
export async function apiSignIn(request: APIRequestContext): Promise<void> {
  const response = await request.post(`${API_URL}/api/auth/sign-in/email`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  })
  if (!response.ok()) throw new Error(`API sign-in failed: ${response.status()}`)
}

/** Point the chat slot at the local mock so no test spends money or needs the network. */
export async function configureMockProvider(request: APIRequestContext): Promise<void> {
  const providers = await request.get(`${API_URL}/api/v1/settings/providers`)
  const existing = (await providers.json()) as { providers: { id: string; name: string }[] }
  let providerId = existing.providers.find((p) => p.name === 'e2e-mock')?.id

  if (!providerId) {
    const created = await request.post(`${API_URL}/api/v1/settings/providers`, {
      data: { name: 'e2e-mock', baseUrl: `${MOCK_URL}/v1`, apiKey: 'not-a-real-key' },
    })
    providerId = ((await created.json()) as { id: string }).id
  }

  for (const task of ['agent_chat', 'suggestion_for_human']) {
    await request.put(`${API_URL}/api/v1/settings/task-slots/${task}`, {
      data: { primaryProviderId: providerId, primaryModel: 'mock-model' },
    })
  }
}

export async function findTestChannelId(request: APIRequestContext): Promise<string> {
  const response = await request.get(`${API_URL}/api/v1/simulator/channels`)
  const body = (await response.json()) as { channels: { id: string }[] }
  const id = body.channels[0]?.id
  if (!id) throw new Error('No test channel is configured; run the seed first.')
  return id
}

/** Send a message as a customer, the way a real webhook would. */
export async function customerSays(
  request: APIRequestContext,
  channelId: string,
  externalId: string,
  text: string,
): Promise<void> {
  const response = await request.post(`${API_URL}/api/v1/simulator/${channelId}/inbound`, {
    data: {
      externalId,
      displayName: externalId,
      message: { kind: 'text', text },
    },
  })
  if (!response.ok()) throw new Error(`Simulator send failed: ${response.status()}`)
}

export const uniqueCustomer = (label: string): string => `e2e-${label}-${uniqueToken()}`

/**
 * A token unique to one run, and deliberately not a plain run of digits.
 *
 * `Date.now()` is thirteen digits, which is the length of a Thai national ID, and about one
 * in ten such numbers satisfies its checksum. Redaction then masks it before it is stored,
 * the text a test looks for never appears, and the suite fails roughly one run in ten while
 * the product is behaving exactly as designed.
 */
export const uniqueToken = (): string =>
  `r${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`

/**
 * A Thai mobile number belonging to this test alone.
 *
 * Customers persist between runs and merge matching is by value, so a shared number would
 * make every customer any test ever created look like the same person, and the panel would
 * show a pile of proposals instead of the one under test.
 *
 * Ten digits on purpose: redaction only considers runs of thirteen or more, so a phone
 * reaches the database intact, which is the whole point of extracting it.
 */
export const uniquePhone = (): string =>
  `08${Math.floor(Math.random() * 100_000_000)
    .toString()
    .padStart(8, '0')}`

/** Return the embedding slot to its default: no provider, and the dimensions field sent. */
export async function resetEmbedSlot(request: APIRequestContext): Promise<void> {
  const response = await request.put(`${API_URL}/api/v1/settings/task-slots/embed`, {
    data: {
      primaryProviderId: null,
      primaryModel: null,
      fallbackProviderId: null,
      fallbackModel: null,
      params: { sendDimensions: true },
    },
  })
  if (!response.ok()) throw new Error(`Resetting the embed slot failed: ${response.status()}`)
}

/**
 * Send an image as a customer, the way a platform webhook would.
 *
 * The bytes are a real one-pixel PNG uploaded through the API, so the attachment points at
 * an object that actually exists and the console renders it rather than a broken image.
 */
export async function customerSendsImage(
  request: APIRequestContext,
  channelId: string,
  externalId: string,
): Promise<void> {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  const uploaded = await request.post(`${API_URL}/api/v1/uploads`, {
    multipart: { file: { name: 'shot.png', mimeType: 'image/png', buffer: png } },
  })
  if (!uploaded.ok()) throw new Error(`Upload failed: ${uploaded.status()}`)
  const { storageKey } = (await uploaded.json()) as { storageKey: string }

  const response = await request.post(`${API_URL}/api/v1/simulator/${channelId}/inbound`, {
    data: {
      externalId,
      displayName: externalId,
      message: {
        kind: 'image',
        text: null,
        attachments: [
          {
            storageKey,
            sourceUrl: null,
            mime: 'image/png',
            sizeBytes: png.length,
            fileName: 'shot.png',
            width: null,
            height: null,
            durationMs: null,
          },
        ],
      },
    },
  })
  if (!response.ok()) throw new Error(`Simulator image send failed: ${response.status()}`)
}

/** The seeded web channel, which the widget is embedded against. */
export async function findWebChannelId(request: APIRequestContext): Promise<string> {
  const response = await request.get(`${API_URL}/api/v1/settings/channels`)
  if (!response.ok()) throw new Error(`Listing channels failed: ${response.status()}`)
  const body = (await response.json()) as { channels: { id: string; type: string }[] }
  const channel = body.channels.find((c) => c.type === 'web')
  if (!channel) throw new Error('No web channel is configured; run the seed first.')
  return channel.id
}
