import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'

/**
 * A real MCP server for tests, built with the SDK's own server half on `Bun.serve`, so the
 * client is exercised against the protocol rather than a hand-written imitation of it.
 *
 * Stateless: every request gets a fresh server and transport, which is how a server behind
 * a load balancer behaves and what a client that connects per call must cope with.
 */

export type McpCall = { tool: string; args: Record<string, unknown>; meta: unknown }

export type TestMcpServer = {
  url: string
  calls: McpCall[]
  /** Request headers seen, newest last. */
  headers: Headers[]
  stop: () => void
}

/** The shop's tools: a read, a destructive write, one that always fails, and padding. */
export function buildTestMcp(calls: McpCall[], manyTools = 0): McpServer {
  const mcp = new McpServer({ name: 'test-shop', version: '1.0.0' })
  mcp.registerTool(
    'lookup_order',
    {
      description: 'Look up an order by its id.',
      inputSchema: { order_id: z.string(), account: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async (args, extra) => {
      calls.push({ tool: 'lookup_order', args, meta: extra._meta })
      return {
        content: [
          { type: 'text', text: `order ${args.order_id} for ${args.account ?? 'nobody'}: shipped` },
        ],
      }
    },
  )
  mcp.registerTool(
    'cancel-order',
    {
      description: 'Cancel an order.',
      inputSchema: { order_id: z.string() },
      annotations: { destructiveHint: true },
    },
    async (args, extra) => {
      calls.push({ tool: 'cancel-order', args, meta: extra._meta })
      return { content: [{ type: 'text', text: `cancelled ${args.order_id}` }] }
    },
  )
  mcp.registerTool('broken', { description: 'Always fails.', inputSchema: {} }, async () => ({
    isError: true,
    content: [{ type: 'text', text: 'the shop is closed' }],
  }))
  for (let index = 0; index < manyTools; index += 1) {
    mcp.registerTool(
      `extra_${index}`,
      { description: 'x'.repeat(5000), inputSchema: {} },
      async () => ({
        content: [],
      }),
    )
  }
  return mcp
}

/** Answer one MCP request with a fresh server and transport. */
export async function handleMcp(request: Request, calls: McpCall[], manyTools = 0) {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  await buildTestMcp(calls, manyTools).connect(transport)
  return transport.handleRequest(request)
}

export function startMcpServer(
  options: { requireHeader?: { name: string; value: string }; manyTools?: number } = {},
): TestMcpServer {
  const calls: McpCall[] = []
  const headers: Headers[] = []

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      headers.push(request.headers)
      if (
        options.requireHeader &&
        request.headers.get(options.requireHeader.name) !== options.requireHeader.value
      ) {
        return new Response('unauthorised', { status: 401 })
      }
      return handleMcp(request, calls, options.manyTools ?? 0)
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    calls,
    headers,
    stop: () => server.stop(true),
  }
}
