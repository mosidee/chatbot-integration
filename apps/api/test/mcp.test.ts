import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { loadEnv } from '@ci/config'
import { schema } from '@ci/db'
import type { McpServerSummary } from '@ci/shared'
import { eq } from 'drizzle-orm'
import { startMcpServer, type TestMcpServer } from '../../../packages/infra/test/helpers/mcp-server'
import { createApp } from '../src/app'
import { createApiContext } from '../src/context'
import { type ApiFixture, createApiFixture } from './helpers/session'

/** Connecting MCP servers from settings (ADR 0011): who may, and what the allowlist allows. */

// Loopback, for the test server; production refuses it (packages/infra/test/mcp.*).
const ctx = createApiContext({ ...loadEnv(), TOOL_EGRESS_ALLOW_PRIVATE: true })
const app = createApp(ctx)

let fixture: ApiFixture
let server: TestMcpServer

beforeAll(async () => {
  fixture = await createApiFixture(ctx, app)
  server = startMcpServer({ requireHeader: { name: 'x-api-key', value: 'sesame' } })
})

afterAll(async () => {
  server.stop()
  await fixture.cleanup()
  await ctx.runtime.close()
})

const json = (method: string, body?: unknown) => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

async function create(name: string): Promise<string> {
  const response = await fixture.as(
    fixture.admin,
    '/api/v1/settings/mcp',
    json('POST', {
      name,
      url: server.url,
      auth: 'header',
      headerName: 'x-api-key',
      credential: 'sesame',
    }),
  )
  expect(response.status).toBe(200)
  return ((await response.json()) as { id: string }).id
}

async function list(): Promise<McpServerSummary[]> {
  const response = await fixture.as(fixture.admin, '/api/v1/settings/mcp')
  return ((await response.json()) as { servers: McpServerSummary[] }).servers
}

describe('connecting a server', () => {
  test('only an admin may, and the token never comes back', async () => {
    const refused = await fixture.as(
      fixture.agent,
      '/api/v1/settings/mcp',
      json('POST', { name: 'nope', url: server.url, auth: 'none' }),
    )
    expect(refused.status).toBe(403)

    const id = await create('shop')
    const text = await (await fixture.as(fixture.admin, '/api/v1/settings/mcp')).text()
    expect(text).not.toContain('sesame')
    const summary = (await list()).find((row) => row.id === id)
    expect(summary).toMatchObject({ name: 'shop', hasCredential: true, headerName: 'x-api-key' })
  })

  test('fetching its tools stores what the server says about them', async () => {
    const id = (await list()).find((row) => row.name === 'shop')?.id ?? ''
    const fetched = await fixture.as(
      fixture.admin,
      `/api/v1/settings/mcp/${id}/fetch-tools`,
      json('POST'),
    )
    expect(await fetched.json()).toEqual({ ok: true, tools: 3 })
    const summary = (await list()).find((row) => row.id === id)
    expect(summary?.snapshot.map((tool) => [tool.name, tool.readOnly])).toEqual([
      ['lookup_order', true],
      ['cancel-order', false],
      ['broken', null],
    ])
  })
})

describe('the allowlist', () => {
  const allow = async (id: string, allowed: unknown) =>
    fixture.as(fixture.admin, `/api/v1/settings/mcp/${id}`, json('PATCH', { allowed }))

  test('refuses a tool it does not have, and a read the server says writes', async () => {
    const id = (await list()).find((row) => row.name === 'shop')?.id ?? ''
    expect((await allow(id, [{ name: 'nonexistent', effect: 'read' }])).status).toBe(400)
    expect((await allow(id, [{ name: 'cancel-order', effect: 'read' }])).status).toBe(400)
    expect(
      (
        await allow(id, [
          { name: 'cancel-order', effect: 'write' },
          { name: 'lookup_order', effect: 'read' },
        ])
      ).status,
    ).toBe(200)
  })

  test('a name that would collide with an HTTP tool is refused, in both directions', async () => {
    const id = (await list()).find((row) => row.name === 'shop')?.id ?? ''
    // `shop_lookup_order` is now exposed: an HTTP tool may not take it.
    const http = await fixture.as(
      fixture.admin,
      '/api/v1/settings/tools',
      json('POST', {
        name: 'shop_lookup_order',
        description: 'clash',
        config: { method: 'GET', url: 'https://api.example.com/x' },
      }),
    )
    expect(http.status).toBe(409)

    // And an HTTP tool first blocks the server exposing the same name.
    await fixture.as(
      fixture.admin,
      '/api/v1/settings/tools',
      json('POST', {
        name: 'shop_broken',
        description: 'first',
        config: { method: 'GET', url: 'https://api.example.com/x' },
      }),
    )
    expect((await allow(id, [{ name: 'broken', effect: 'read' }])).status).toBe(409)
    await ctx.db.delete(schema.tools).where(eq(schema.tools.workspaceId, fixture.workspaceId))
  })

  test('a test call runs an allowed tool through the real client', async () => {
    const id = (await list()).find((row) => row.name === 'shop')?.id ?? ''
    await allow(id, [{ name: 'lookup_order', effect: 'read' }])
    const response = await fixture.as(
      fixture.admin,
      `/api/v1/settings/mcp/${id}/test`,
      json('POST', { tool: 'lookup_order', args: { order_id: 'SO-3' } }),
    )
    expect(await response.json()).toMatchObject({
      ok: true,
      body: 'order SO-3 for nobody: shipped',
    })
  })

  test('another URL is another server: its approvals are dropped', async () => {
    const id = (await list()).find((row) => row.name === 'shop')?.id ?? ''
    await fixture.as(
      fixture.admin,
      `/api/v1/settings/mcp/${id}`,
      json('PATCH', { url: `${server.url}?v=2` }),
    )
    const summary = (await list()).find((row) => row.id === id)
    expect(summary?.allowed).toEqual([])
    expect(summary?.snapshot).toEqual([])
  })
})
