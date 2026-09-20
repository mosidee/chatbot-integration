import { afterAll, describe, expect, test } from 'bun:test'
import { loadEnv } from '@ci/config'
import { createApp } from '../src/app'
import { createApiContext } from '../src/context'

/**
 * The routing contract.
 *
 * Two bugs hid in this seam. The single-page app was served from a `/*` route, which
 * shadowed the auth handler so every GET to it returned 404 while POST worked. Removing that
 * route exposed a second one: the auth handler had been mounted at the root, so it received
 * every unmatched request and answered with its own 404, and the console stopped being
 * served at all.
 *
 * Neither showed up in the unit tests or the browser tests, because the browser tests run
 * against the development server where Vite serves the assets. These assertions pin the
 * arrangement down.
 */

const env = { ...loadEnv(), NODE_ENV: 'production' as const }
const ctx = createApiContext(env)
const app = createApp(ctx)

const get = (path: string, init?: RequestInit) =>
  app.handle(new Request(`http://localhost${path}`, init))

/** These assertions need the built console; say so rather than failing cryptically. */
const consoleBuilt = await Bun.file(`${process.cwd()}/apps/web/dist/index.html`).exists()
if (!consoleBuilt) {
  throw new Error(
    'apps/web/dist is missing. Run `bun run build:web` first: these tests assert that the API serves the built console.',
  )
}

afterAll(async () => {
  await ctx.runtime.close()
})

describe('the console', () => {
  test('is served at the root', async () => {
    const response = await get('/')
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<div id="root">')
  })

  test('is served for a client-side route the server knows nothing about', async () => {
    for (const path of ['/login', '/settings', '/knowledge', '/simulator']) {
      const response = await get(path)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('<div id="root">')
    }
  })
})

describe('the auth handler', () => {
  test('answers GET, which the session check and OAuth callbacks depend on', async () => {
    const response = await get('/api/auth/get-session')
    // 200 with a null body when nobody is signed in. A 404 here means the route is shadowed.
    expect(response.status).toBe(200)
  })

  test('answers POST', async () => {
    const response = await get('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong' }),
    })
    // Rejected credentials, not a missing route.
    expect(response.status).not.toBe(404)
  })
})

describe('the API', () => {
  test('refuses data without a session rather than serving the console', async () => {
    for (const path of [
      '/api/v1/conversations',
      '/api/v1/settings/workspace',
      '/api/v1/knowledge/sources',
    ]) {
      const response = await get(path)
      expect(response.status).toBe(401)
    }
  })

  test('returns JSON for an unknown API path, never the console', async () => {
    const response = await get('/api/v1/does-not-exist')
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('<div id="root">')
  })

  test('reports health without a session', async () => {
    const response = await get('/healthz')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ok' })
  })
})
