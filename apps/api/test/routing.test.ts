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

/**
 * Production mode, because that is when the API serves the built console rather than
 * deferring to Vite. The egress flag is forced off with it: `createRuntime` refuses to
 * start when it is on in production, and a developer who set it in their own `.env` to run
 * the browser tests would otherwise see this file fail with a message about production that
 * has nothing to do with what it asserts.
 */
const env = {
  ...loadEnv(),
  NODE_ENV: 'production' as const,
  TOOL_EGRESS_ALLOW_PRIVATE: false,
}
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
    for (const path of [
      '/login',
      '/settings',
      '/knowledge',
      '/simulator',
      '/admin',
      '/platform',
      // The invitation page is opened by somebody with no session at all, so it has to be
      // served rather than bounced to a sign-in form they cannot use.
      '/invite/some-token',
    ]) {
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

/**
 * The endpoint a tenant's own verification page posts to.
 *
 * Public by necessity: the caller is their application, with no session here. What stands
 * in for authentication is a code only the person who received the link holds and a token
 * signed with a secret only the tenant holds, so the assertions worth making are that it
 * answers without a session and refuses everything it should.
 */
describe('the identity confirm endpoint', () => {
  const confirm = (body: unknown) =>
    get('/api/identity/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  test('is reachable without a session, and does not serve the console', async () => {
    const response = await confirm({ code: 'no-such-code', token: 'x.y.z' })
    expect(response.status).not.toBe(401)
    expect(await response.text()).not.toContain('<div id="root">')
  })

  test('refuses a code it has never issued', async () => {
    const response = await confirm({ code: 'no-such-code', token: 'x.y.z' })
    expect(response.status).toBe(404)
  })

  test('validates its body rather than throwing', async () => {
    const response = await confirm({ code: '' })
    expect(response.status).toBe(422)
  })
})

describe('the API', () => {
  test('refuses data without a session rather than serving the console', async () => {
    for (const path of [
      '/api/v1/conversations',
      '/api/v1/settings/workspace',
      '/api/v1/knowledge/sources',
      // Listing tools exposes which hosts this workspace reaches, so it is not public
      // either, even though the credentials themselves are never returned.
      '/api/v1/settings/tools',
      // Who is in a workspace, and which workspaces exist at all.
      '/api/v1/admin/members',
      '/api/v1/platform/tenants',
    ]) {
      const response = await get(path)
      expect(response.status).toBe(401)
    }
  })

  test('answers an unknown invitation token with 404 rather than 401', async () => {
    // This one is deliberately public: the caller has no account yet, which is the point of
    // the link. An unknown token must look the same as a spent or expired one.
    const response = await get('/api/invitations/not-a-real-token')
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('<div id="root">')
  })

  test('returns JSON for an unknown API path, never the console', async () => {
    const response = await get('/api/v1/does-not-exist')
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('<div id="root">')
  })

  /**
   * Defining a tool stores a credential and points the worker at a host of the caller's
   * choosing, so these are the routes where an authentication gap would matter most.
   */
  test('refuses to define a tool without a session', async () => {
    const response = await get('/api/v1/settings/tools', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'sneaky_tool',
        description: 'Should never be created.',
        config: {
          method: 'GET',
          url: 'https://example.com/',
          headers: {},
          auth: 'none',
          args: [],
          bindings: [],
          effect: 'read',
          timeoutMs: 8000,
        },
      }),
    })
    expect(response.status).toBe(401)
  })

  test('refuses to test a tool without a session', async () => {
    const response = await get('/api/v1/settings/tools/any-id/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(401)
  })

  test('reports health without a session', async () => {
    const response = await get('/healthz')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ok' })
  })
})
