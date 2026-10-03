import { afterEach, describe, expect, test } from 'bun:test'
import { MCP_LIMITS } from '@ci/shared'
import { createRestrictedFetch } from '../src/egress'
import { callMcpTool, fetchMcpTools } from '../src/mcp'
import { startMcpServer, type TestMcpServer } from './helpers/mcp-server'

/** The MCP client against a real server from the SDK (ADR 0011). */

const servers: TestMcpServer[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop()
})
// Restricted egress, as production uses, opened to loopback for the test server.
const fetch = createRestrictedFetch({ allowPrivate: true })

describe('the MCP client', () => {
  test('lists tools with what the server says about them', async () => {
    const server = startMcpServer()
    servers.push(server)
    const tools = await fetchMcpTools({ url: server.url, headers: {}, timeoutMs: 5000 }, fetch)
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
    expect(byName.lookup_order?.readOnly).toBe(true)
    expect(byName['cancel-order']?.readOnly).toBe(false)
    expect(byName.broken?.readOnly).toBeNull()
    expect(byName.lookup_order?.inputSchema).toMatchObject({
      type: 'object',
      properties: { order_id: { type: 'string' } },
    })
  })

  test('cuts what a server could crowd the prompt with', async () => {
    const server = startMcpServer({ manyTools: 120 })
    servers.push(server)
    const tools = await fetchMcpTools({ url: server.url, headers: {}, timeoutMs: 5000 }, fetch)
    expect(tools.length).toBe(MCP_LIMITS.tools)
    for (const tool of tools) {
      expect(tool.description.length).toBeLessThanOrEqual(MCP_LIMITS.descriptionChars)
    }
  })

  test('calls a tool, sending the token and the idempotency key', async () => {
    const server = startMcpServer({ requireHeader: { name: 'x-api-key', value: 'sesame' } })
    servers.push(server)
    const result = await callMcpTool(
      { url: server.url, headers: { 'x-api-key': 'sesame' }, timeoutMs: 5000 },
      fetch,
      'lookup_order',
      { order_id: 'SO-1', account: 'ACC-9' },
      { idempotencyKey: 'turn-1-key' },
    )
    expect(result).toEqual({ isError: false, text: 'order SO-1 for ACC-9: shipped' })
    expect(server.calls.at(-1)?.meta).toMatchObject({ idempotencyKey: 'turn-1-key' })
  })

  test('a wrong token fails, and a tool error comes back as one', async () => {
    const server = startMcpServer({ requireHeader: { name: 'x-api-key', value: 'sesame' } })
    servers.push(server)
    await expect(
      callMcpTool(
        { url: server.url, headers: { 'x-api-key': 'wrong' }, timeoutMs: 5000 },
        fetch,
        'lookup_order',
        { order_id: 'SO-1' },
      ),
    ).rejects.toThrow()
    const broken = await callMcpTool(
      { url: server.url, headers: { 'x-api-key': 'sesame' }, timeoutMs: 5000 },
      fetch,
      'broken',
      {},
    )
    expect(broken).toEqual({ isError: true, text: 'the shop is closed' })
  })

  test('a private address is refused by production egress', async () => {
    const server = startMcpServer()
    servers.push(server)
    await expect(
      fetchMcpTools(
        { url: server.url, headers: {}, timeoutMs: 5000 },
        createRestrictedFetch({ allowPrivate: false }),
      ),
    ).rejects.toThrow()
    expect(server.headers).toHaveLength(0)
  })
})
