import { afterEach, describe, expect, test } from 'bun:test'
import { loadEnv } from '@ci/config'
import { newId, schema } from '@ci/db'
import { eq } from 'drizzle-orm'
import { createRestrictedFetch } from '../src/egress'
import { callMcpTool, createMcpCaller, loadMcpServers } from '../src/mcp'
import {
  disconnectMcpSignIn,
  finishMcpSignIn,
  McpNeedsReconnectError,
  oauthHeaders,
  signSignInState,
  startMcpSignIn,
  verifySignInState,
} from '../src/mcp-oauth'
import { createKnowledgeFixture, type KnowledgeFixture } from './helpers/knowledge-fixture'
import { startOAuthMcpServer, type TestOAuthMcpServer } from './helpers/oauth-mcp-server'

/** Signing in to an MCP server with OAuth, and keeping the sign-in alive (ADR 0011). */

const env = loadEnv()
const secretKey = env.APP_SECRET_KEY
const fetch = createRestrictedFetch({ allowPrivate: true })
const fixtures: KnowledgeFixture[] = []
const servers: TestOAuthMcpServer[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop()
  for (const f of fixtures.splice(0)) await f.cleanup()
})

/** A workspace with a server connected and signed in, as an admin would leave it. */
async function signedIn(options: { expiresIn?: number } = {}) {
  const f = await createKnowledgeFixture()
  fixtures.push(f)
  const hosted = startOAuthMcpServer()
  servers.push(hosted)
  if (options.expiresIn) hosted.setExpiresIn(options.expiresIn)
  const serverId = newId()
  await f.db.insert(schema.mcpServers).values({
    id: serverId,
    workspaceId: f.workspaceId,
    name: 'hosted',
    url: hosted.url,
    auth: 'oauth',
    snapshot: [
      {
        name: 'lookup_order',
        description: 'Look up an order.',
        inputSchema: { type: 'object', properties: { order_id: { type: 'string' } } },
        readOnly: true,
      },
    ],
    allowed: [{ name: 'lookup_order', effect: 'read', bindings: [] }],
  })
  const row = async () =>
    (await f.db.select().from(schema.mcpServers).where(eq(schema.mcpServers.id, serverId)))[0]

  const started = await startMcpSignIn(f.db, {
    workspaceId: f.workspaceId,
    serverId,
    serverUrl: hosted.url,
    encrypted: null,
    secretKey,
    publicWebUrl: 'http://localhost:5173',
    stateParam: 'signed-state',
    fetch,
  })
  if (started.status !== 'redirect') throw new Error('expected a redirect')
  expect(started.url.searchParams.get('state')).toBe('signed-state')
  expect(started.url.searchParams.get('redirect_uri')).toBe(
    'http://localhost:5173/api/mcp/oauth/callback',
  )
  // The admin approves; the server sends them back with a code.
  const approved = await globalThis.fetch(started.url, { redirect: 'manual' })
  const code = new URL(approved.headers.get('location') ?? '').searchParams.get('code') ?? ''
  await finishMcpSignIn(f.db, {
    workspaceId: f.workspaceId,
    serverId,
    serverUrl: hosted.url,
    encrypted: (await row())?.credentialEncrypted ?? null,
    secretKey,
    publicWebUrl: 'http://localhost:5173',
    code,
    fetch,
  })
  const headersNow = (force?: { rejected: string }) =>
    oauthHeaders(f.db, {
      workspaceId: f.workspaceId,
      serverId,
      secretKey,
      fetch,
      ...(force ? { force: true, rejectedToken: force.rejected } : {}),
    })
  return { f, hosted, serverId, row, headersNow }
}

describe('signing in', () => {
  test('discovers, registers, swaps the code with PKCE, and the token reaches the server', async () => {
    const { hosted, headersNow, row } = await signedIn()
    const headers = await headersNow()
    expect(headers).toEqual({ Authorization: 'Bearer at-1' })
    // Stored encrypted: the token is not readable in the row.
    expect((await row())?.credentialEncrypted).not.toContain('at-1')
    const result = await callMcpTool(
      { url: hosted.url, headers: headers ?? {}, timeoutMs: 5000 },
      fetch,
      'lookup_order',
      { order_id: 'SO-1' },
    )
    expect(result.text).toBe('order SO-1 for nobody: shipped')
  })
})

describe('keeping it alive', () => {
  test('a token about to expire is refreshed once, however many turns ask at once', async () => {
    const { hosted, headersNow } = await signedIn({ expiresIn: 30 })
    hosted.setExpiresIn(3600)
    const [a, b, c] = await Promise.all([headersNow(), headersNow(), headersNow()])
    expect(hosted.refreshes()).toBe(1)
    expect(a).toEqual({ Authorization: 'Bearer at-2' })
    expect(b).toEqual(a)
    expect(c).toEqual(a)
  })

  test('a refused refresh token marks the server for an admin, and its tools leave turns', async () => {
    const { f, hosted, headersNow, row } = await signedIn({ expiresIn: 30 })
    hosted.setRefreshMode('invalid_grant')
    await expect(headersNow()).rejects.toBeInstanceOf(McpNeedsReconnectError)
    expect((await row())?.status).toBe('needs_reconnect')
    expect(await loadMcpServers(f.db, f.workspaceId, secretKey, fetch)).toEqual([])
  })

  test('a server that is down during a refresh is an outage, not a lost sign-in', async () => {
    const { hosted, headersNow, row } = await signedIn({ expiresIn: 30 })
    hosted.setRefreshMode('unavailable')
    await expect(headersNow()).rejects.not.toBeInstanceOf(McpNeedsReconnectError)
    expect((await row())?.status).toBe('ok')
    // And the card can say why its tools are missing this turn.
    expect((await row())?.lastError).toContain('refreshing the sign-in failed')
  })

  test('a client registration the server revoked is lost for good too', async () => {
    const { hosted, headersNow, row } = await signedIn({ expiresIn: 30 })
    hosted.setRefreshMode('invalid_client')
    await expect(headersNow()).rejects.toBeInstanceOf(McpNeedsReconnectError)
    expect((await row())?.status).toBe('needs_reconnect')
  })

  test('a token the server stopped accepting is refreshed and the call tried once more', async () => {
    const { f, hosted } = await signedIn()
    const servers = await loadMcpServers(f.db, f.workspaceId, secretKey, fetch)
    hosted.revokeAccessTokens()
    const caller = createMcpCaller(servers, fetch, {
      reauthorize: (serverId, rejected) =>
        oauthHeaders(f.db, {
          workspaceId: f.workspaceId,
          serverId,
          secretKey,
          fetch,
          force: true,
          rejectedToken: rejected,
        }),
    })
    const result = await caller.call(servers[0]?.id ?? '', 'lookup_order', { order_id: 'SO-2' })
    expect(result.text).toBe('order SO-2 for nobody: shipped')
    expect(hosted.refreshes()).toBe(1)
  })
})

test('the sign-in state is ours, unexpired and unaltered', () => {
  const value = signSignInState({ workspaceId: 'w', serverId: 's', userId: 'u' }, secretKey)
  expect(verifySignInState(value, secretKey)).toMatchObject({ workspaceId: 'w', userId: 'u' })
  const [body, mac] = value.split('.')
  const forged = Buffer.from(
    JSON.stringify({ workspaceId: 'other', serverId: 's', userId: 'u', exp: Date.now() + 1e6 }),
  ).toString('base64url')
  expect(verifySignInState(`${forged}.${mac}`, secretKey)).toBeNull()
  expect(verifySignInState(`${body}.${mac}`, 'another-secret-key-of-enough-length')).toBeNull()
})

describe('signing out and in again', () => {
  test('signing out revokes both tokens at the server and forgets them', async () => {
    const { f, hosted, serverId, row } = await signedIn()
    await disconnectMcpSignIn(f.db, { workspaceId: f.workspaceId, serverId, secretKey, fetch })
    expect(hosted.revoked).toEqual(['rt-1', 'at-1'])
    expect((await row())?.credentialEncrypted).toBeNull()
  })

  test('"sign in again" goes to the server, and the working token stays until it is replaced', async () => {
    const { f, hosted, serverId, row, headersNow } = await signedIn()
    const again = await startMcpSignIn(f.db, {
      workspaceId: f.workspaceId,
      serverId,
      serverUrl: hosted.url,
      encrypted: (await row())?.credentialEncrypted ?? null,
      secretKey,
      publicWebUrl: 'http://localhost:5173',
      stateParam: 'again',
      fetch,
    })
    expect(again.status).toBe('redirect')
    expect(hosted.refreshes()).toBe(0)
    expect(await headersNow()).toEqual({ Authorization: 'Bearer at-1' })
  })
})
