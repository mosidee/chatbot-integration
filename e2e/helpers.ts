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
/** The origin a browser would be on, which Better Auth checks against its trusted list. */
export const WEB_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5173'

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
    // Better Auth refuses a sign-in with no Origin, which is what a request built by hand
    // sends. A browser always supplies one, so this is restoring what it would have said
    // rather than working around a check.
    headers: { origin: WEB_URL },
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  })
  if (!response.ok()) {
    // The body says which of the several reasons it was, and a bare status does not.
    throw new Error(`API sign-in failed: ${response.status()} ${await response.text()}`)
  }
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
 * Remove every tenant tool before a test defines its own.
 *
 * Tools persist between runs, and the AI is offered all of them. A tool left behind by an
 * earlier run points at a port that died with that run's test process, so the model picks
 * it, the call is refused, and the conversation hands off with `tool_error` while the tool
 * under test is never reached. The failure looks like a bug in egress and is not.
 */
export async function clearTools(request: APIRequestContext): Promise<void> {
  const response = await request.get(`${API_URL}/api/v1/settings/tools`)
  const body = (await response.json()) as { tools: { id: string }[] }
  for (const tool of body.tools) {
    await request.delete(`${API_URL}/api/v1/settings/tools/${tool.id}`)
  }
}

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

/**
 * Resolve every conversation left open by an earlier run.
 *
 * The suite has always created conversations and never cleaned them up, which was harmless
 * while the inbox was ordered newest first: yesterday's debris sank and a test's own
 * conversation was always on the first page. The inbox now orders by who owns the customer
 * and then by longest wait, so three days of unanswered test conversations sit at the top
 * for ever and push a newly arrived one past the fifty the list asks for.
 *
 * CI never noticed, because it runs against a database that migrates and seeds from empty.
 * This is what lets the same suite pass on a developer's machine that has been running it
 * for a week. It resolves rather than deletes: nothing is destroyed, and a resolved
 * conversation simply leaves the default view.
 */
export async function clearInbox(request: APIRequestContext): Promise<void> {
  /**
   * Local only, and refused loudly otherwise.
   *
   * This resolves every open conversation in the workspace, not merely the ones a test
   * made — there is nothing on a conversation that says which run created it. Against a
   * shared or staging environment that would quietly close a real queue, so it refuses the
   * same way `db:reset` refuses a database that is not local.
   */
  const host = (() => {
    try {
      return new URL(API_URL).hostname
    } catch {
      return ''
    }
  })()
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error(
      `Refusing to resolve open conversations against ${host}: clearInbox is for a local database only.`,
    )
  }

  for (let page = 0; page < 40; page += 1) {
    const response = await request.get(`${API_URL}/api/v1/conversations?status=open&limit=100`)
    if (!response.ok()) return
    const body = (await response.json()) as { conversations: { id: string }[] }
    if (body.conversations.length === 0) return

    for (const conversation of body.conversations) {
      await request.post(`${API_URL}/api/v1/conversations/${conversation.id}/status`, {
        data: { status: 'resolved' },
      })
    }
  }
}

/**
 * Arm a two-click confirmation, then confirm it the way a person does.
 *
 * `ConfirmButton` ignores a second click within 400 ms of arming, because that is a
 * double-click rather than a decision. A test clicking twice back to back is exactly such a
 * double-click, so it waits as somebody reading the armed label would.
 */
export async function confirmTwice(control: import('@playwright/test').Locator): Promise<void> {
  await control.click()
  await control.page().waitForTimeout(450)
  await control.click()
}

/**
 * Make the next matching request fail, once, as a server or network would.
 *
 * No test used `page.route` before, so every "what does the console do when this fails"
 * question was answered only by reading code. `status: 'network'` aborts the request.
 */
export async function failNext(
  page: Page,
  url: string | RegExp,
  options: { status?: number | 'network'; method?: string; times?: number } = {},
): Promise<void> {
  // More than once where the console retries on its own, as it does for a load that died.
  let left = options.times ?? 1
  await page.route(url, async (route) => {
    if (left === 0 || (options.method && route.request().method() !== options.method)) {
      return route.fallback()
    }
    left -= 1
    if (options.status === 'network') return route.abort('failed')
    return route.fulfill({
      status: options.status ?? 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'injected by the test' }),
    })
  })
}

/**
 * A member of the seeded workspace with the given role, signed in on `page`.
 *
 * Invited through the API and accepted in the browser, as a person would be. Returns a
 * cleanup that removes the membership again, so runs do not accumulate members.
 */
export async function signInAs(
  page: Page,
  request: APIRequestContext,
  role: 'viewer' | 'agent' | 'admin',
): Promise<{ email: string; cleanup: () => Promise<void> }> {
  const email = `e2e-${role}-${uniqueToken()}@example.com`
  const invited = await request.post(`${API_URL}/api/v1/admin/invitations`, {
    data: { email, role },
  })
  const { link } = (await invited.json()) as { link: string }
  await page.goto(link)
  await page.getByTestId('invite-name').fill(`E2E ${role}`)
  await page.getByTestId('invite-password').fill('a-good-password-1')
  await page.getByTestId('invite-submit').click()
  await page.waitForURL('**/', { timeout: 20_000 })

  return {
    email,
    cleanup: async () => {
      const members = await request.get(`${API_URL}/api/v1/admin/members`)
      const body = (await members.json()) as { members: { email: string; userId: string }[] }
      const userId = body.members.find((member) => member.email === email)?.userId
      if (userId) await request.delete(`${API_URL}/api/v1/admin/members/${userId}`)
    },
  }
}
