import type { FetchLike, McpCaller, McpCallResult, McpToolDefinition } from '@ci/core'
import { type Database, decryptSecret, schema } from '@ci/db'
import {
  exposedMcpToolName,
  MCP_LIMITS,
  type McpAllowedTool,
  type McpToolSnapshot,
} from '@ci/shared'
// Deep imports on purpose: the package root pulls in its server half, and with it express.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { and, eq } from 'drizzle-orm'

/**
 * Talking to a workspace's MCP servers (ADR 0011).
 *
 * Every request goes through the fetch it is handed, which in production is the restricted
 * egress client: a server's URL is typed by a tenant admin, so it is the same SSRF surface
 * as an HTTP tool. A connection lasts one call. Tool calls are rare and short, and nothing
 * left open can outlive the turn that opened it.
 */

/** A server as a turn needs it: where, how to authenticate, and what may be offered. */
export type McpServerRuntime = {
  id: string
  name: string
  url: string
  timeoutMs: number
  /** Sent with every request. Decrypted at the moment of use, never logged. */
  headers: Record<string, string>
  tools: McpToolDefinition[]
}

const CLIENT_INFO = { name: 'chatbot-integration', version: '1.0.0' }

/** The approved tools of one server, from what was stored when an admin approved them. */
export function approvedTools(server: {
  id: string
  name: string
  snapshot: McpToolSnapshot[]
  allowed: McpAllowedTool[]
}): McpToolDefinition[] {
  const tools: McpToolDefinition[] = []
  for (const allowed of server.allowed) {
    const snapshot = server.snapshot.find((tool) => tool.name === allowed.name)
    if (!snapshot || snapshot.tooLarge) continue
    tools.push({
      serverId: server.id,
      exposedName: exposedMcpToolName(server.name, snapshot.name),
      remoteName: snapshot.name,
      description: snapshot.description,
      inputSchema: snapshot.inputSchema,
      effect: allowed.effect,
      bindings: allowed.bindings,
    })
  }
  return tools
}

/** The headers a stored server sends, its credential decrypted here. */
export async function serverHeaders(
  row: Pick<typeof schema.mcpServers.$inferSelect, 'auth' | 'headerName' | 'credentialEncrypted'>,
  secretKey: string,
): Promise<Record<string, string>> {
  if (row.auth === 'header' && row.headerName && row.credentialEncrypted) {
    return { [row.headerName]: await decryptSecret(row.credentialEncrypted, secretKey) }
  }
  return {}
}

/**
 * The servers a turn may use: enabled, signed in, with at least one approved tool. One whose
 * sign-in can no longer be refreshed is left out rather than handing every turn off.
 */
export async function loadMcpServers(
  db: Database,
  workspaceId: string,
  secretKey: string,
): Promise<McpServerRuntime[]> {
  const rows = await db
    .select()
    .from(schema.mcpServers)
    .where(and(eq(schema.mcpServers.workspaceId, workspaceId), eq(schema.mcpServers.enabled, true)))
  const servers: McpServerRuntime[] = []
  for (const row of rows) {
    if (row.status !== 'ok') continue
    const tools = approvedTools(row)
    if (tools.length === 0) continue
    servers.push({
      id: row.id,
      name: row.name,
      url: row.url,
      timeoutMs: row.timeoutMs,
      headers: await serverHeaders(row, secretKey),
      tools,
    })
  }
  return servers
}

/** Connect, run `work`, close: a connection never outlives its one use. */
export async function withMcpClient<T>(
  server: { url: string; headers: Record<string, string>; timeoutMs: number },
  fetch: FetchLike,
  work: (client: Client) => Promise<T>,
): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    fetch,
    requestInit: { headers: server.headers },
  })
  const client = new Client(CLIENT_INFO)
  try {
    await client.connect(transport, { timeout: server.timeoutMs })
    return await work(client)
  } finally {
    await client.close().catch(() => {})
  }
}

/** The text a model is shown of a result: text parts joined, anything else named. */
export function resultText(result: { content?: unknown; structuredContent?: unknown }): string {
  const parts: string[] = []
  for (const item of (result.content as { type: string; text?: string }[] | undefined) ?? []) {
    if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
    else parts.push(`[${item.type}]`)
  }
  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent))
  }
  return parts.join('\n')
}

/** One tool call, on its own connection. */
export async function callMcpTool(
  server: { url: string; headers: Record<string, string>; timeoutMs: number },
  fetch: FetchLike,
  tool: string,
  args: Record<string, unknown>,
  options: { idempotencyKey?: string } = {},
): Promise<McpCallResult> {
  return withMcpClient(server, fetch, async (client) => {
    const result = await client.callTool(
      {
        name: tool,
        arguments: args,
        // MCP has no idempotency header; a server that de-duplicates can read it here.
        ...(options.idempotencyKey ? { _meta: { idempotencyKey: options.idempotencyKey } } : {}),
      },
      undefined,
      { timeout: server.timeoutMs },
    )
    return {
      isError: Boolean(result.isError),
      text: resultText(result as { content?: unknown; structuredContent?: unknown }),
    }
  })
}

/** A caller over loaded servers, for the turn and for the writes after it. */
export function createMcpCaller(servers: McpServerRuntime[], fetch: FetchLike): McpCaller {
  return {
    async call(serverId, tool, args, options) {
      const server = servers.find((s) => s.id === serverId)
      if (!server) throw new Error('is no longer connected in this workspace')
      return callMcpTool(server, fetch, tool, args, options)
    },
  }
}

/**
 * The server's tool list, as a snapshot an admin can approve from.
 *
 * Follows pagination up to a limit, and cuts what a server could use to crowd the prompt:
 * a description is shortened, and a schema too large to send is kept but marked so it
 * cannot be allowed.
 */
export async function fetchMcpTools(
  server: { url: string; headers: Record<string, string>; timeoutMs: number },
  fetch: FetchLike,
): Promise<McpToolSnapshot[]> {
  return withMcpClient(server, fetch, async (client) => {
    const tools: McpToolSnapshot[] = []
    let cursor: string | undefined
    for (let page = 0; page < MCP_LIMITS.pages && tools.length < MCP_LIMITS.tools; page += 1) {
      const listed = await client.listTools(cursor ? { cursor } : undefined, {
        timeout: server.timeoutMs,
      })
      for (const tool of listed.tools) {
        if (tools.length >= MCP_LIMITS.tools) break
        const inputSchema = (tool.inputSchema ?? { type: 'object' }) as Record<string, unknown>
        const annotations = tool.annotations as
          | { readOnlyHint?: boolean; destructiveHint?: boolean }
          | undefined
        const readOnly =
          annotations?.readOnlyHint === true
            ? true
            : annotations?.readOnlyHint === false || annotations?.destructiveHint === true
              ? false
              : null
        const tooLarge = JSON.stringify(inputSchema).length > MCP_LIMITS.schemaBytes
        tools.push({
          name: String(tool.name).slice(0, 128),
          description: (tool.description ?? '').slice(0, MCP_LIMITS.descriptionChars),
          inputSchema: tooLarge ? { type: 'object' } : inputSchema,
          readOnly,
          ...(tooLarge ? { tooLarge: true } : {}),
        })
      }
      cursor = listed.nextCursor
      if (!cursor) break
    }
    return tools
  })
}

/**
 * Every tool name the workspace's MCP servers expose, except `excludeServerId`'s. Checked
 * when a server's allowlist is saved and when an HTTP tool is named: two tools of one name
 * reach `mergeToolSources`, which keeps the first and drops the other with only a log line.
 */
export async function mcpExposedNames(
  db: Database,
  workspaceId: string,
  excludeServerId?: string,
): Promise<Set<string>> {
  const rows = await db
    .select({
      id: schema.mcpServers.id,
      name: schema.mcpServers.name,
      snapshot: schema.mcpServers.snapshot,
      allowed: schema.mcpServers.allowed,
    })
    .from(schema.mcpServers)
    .where(eq(schema.mcpServers.workspaceId, workspaceId))
  const names = new Set<string>()
  for (const row of rows) {
    if (row.id === excludeServerId) continue
    for (const tool of approvedTools(row)) names.add(tool.exposedName)
  }
  return names
}
