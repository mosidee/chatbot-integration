import { encryptSecret, newId, schema } from '@ci/db'
import {
  approvedTools,
  callMcpTool,
  fetchMcpTools,
  mcpExposedNames,
  serverHeaders,
} from '@ci/infra'
import {
  exposedMcpToolName,
  type McpServerSummary,
  mcpAllowedToolSchema,
  mcpServerNameSchema,
  RESERVED_TOOL_NAMES,
} from '@ci/shared'
import { and, eq } from 'drizzle-orm'
import Elysia from 'elysia'
import { z } from 'zod'
import { authPlugin } from '../auth-plugin'
import type { ApiContext } from '../context'

/**
 * A workspace's MCP servers (ADR 0011).
 *
 * Admin only, like HTTP tools: connecting one points our infrastructure at a host of the
 * tenant's choosing and hands the AI whatever that host offers. Every request to a server —
 * fetching its tools, testing one — goes through the restricted egress client a turn uses.
 */
export function mcpRoutes(ctx: ApiContext) {
  const { db, env, runtime } = ctx

  const summarise = (row: typeof schema.mcpServers.$inferSelect): McpServerSummary => ({
    id: row.id,
    name: row.name,
    url: row.url,
    enabled: row.enabled,
    auth: row.auth,
    headerName: row.headerName,
    hasCredential: Boolean(row.credentialEncrypted),
    status: row.status,
    lastError: row.lastError,
    timeoutMs: row.timeoutMs,
    fetchedAt: row.fetchedAt?.toISOString() ?? null,
    snapshot: row.snapshot,
    allowed: row.allowed,
  })

  const load = async (workspaceId: string, id: string) => {
    const [row] = await db
      .select()
      .from(schema.mcpServers)
      .where(and(eq(schema.mcpServers.id, id), eq(schema.mcpServers.workspaceId, workspaceId)))
      .limit(1)
    return row ?? null
  }

  const urlSchema = z
    .string()
    .url()
    .max(2000)
    .refine((value) => /^https?:\/\//.test(value), 'must be an http(s) URL')

  return (
    new Elysia({ prefix: '/settings/mcp' })
      .use(authPlugin(ctx))

      .get(
        '/',
        async ({ workspaceId }) => {
          const rows = await db
            .select()
            .from(schema.mcpServers)
            .where(eq(schema.mcpServers.workspaceId, workspaceId))
            .orderBy(schema.mcpServers.name)
          return { servers: rows.map(summarise) }
        },
        { auth: 'admin' },
      )

      .post(
        '/',
        async ({ workspaceId, body, status }) => {
          if (body.auth === 'header' && !(body.headerName && body.credential)) {
            return status(400, { error: 'a header name and a token are both needed' })
          }
          const [taken] = await db
            .select({ id: schema.mcpServers.id })
            .from(schema.mcpServers)
            .where(
              and(
                eq(schema.mcpServers.workspaceId, workspaceId),
                eq(schema.mcpServers.name, body.name),
              ),
            )
            .limit(1)
          if (taken) return status(409, { error: `a server called "${body.name}" already exists` })

          const id = newId()
          await db.insert(schema.mcpServers).values({
            id,
            workspaceId,
            name: body.name,
            url: body.url,
            auth: body.auth,
            headerName: body.auth === 'header' ? (body.headerName ?? null) : null,
            credentialEncrypted:
              body.auth === 'header' && body.credential
                ? await encryptSecret(body.credential, env.APP_SECRET_KEY)
                : null,
            timeoutMs: body.timeoutMs ?? 8000,
          })
          return { id }
        },
        {
          auth: 'admin',
          body: z.object({
            name: mcpServerNameSchema,
            url: urlSchema,
            auth: z.enum(['none', 'header']),
            headerName: z
              .string()
              .regex(/^[A-Za-z0-9-]{1,80}$/)
              .optional(),
            credential: z.string().min(1).max(4000).optional(),
            timeoutMs: z.number().int().min(1000).max(15000).optional(),
          }),
        },
      )

      /**
       * Change a server. `allowed` is the allowlist: every entry must name a tool in the
       * stored snapshot, a tool the server itself says changes things may only be a write,
       * and no exposed name may collide with a built-in tool, an HTTP tool or another
       * server's.
       */
      .patch(
        '/:id',
        async ({ workspaceId, params, body, status }) => {
          const row = await load(workspaceId, params.id)
          if (!row) return status(404, { error: 'Server not found' })

          const patch: Partial<typeof schema.mcpServers.$inferInsert> = { updatedAt: new Date() }
          if (body.url !== undefined && body.url !== row.url) {
            patch.url = body.url
            // Another server is another list: nothing approved for the old one carries over.
            patch.snapshot = []
            patch.allowed = []
            patch.fetchedAt = null
          }
          if (body.enabled !== undefined) patch.enabled = body.enabled
          if (body.timeoutMs !== undefined) patch.timeoutMs = body.timeoutMs
          if (body.headerName !== undefined && row.auth === 'header') {
            patch.headerName = body.headerName
          }
          if (body.credential !== undefined && row.auth === 'header') {
            patch.credentialEncrypted = body.credential
              ? await encryptSecret(body.credential, env.APP_SECRET_KEY)
              : null
          }

          if (body.allowed !== undefined && patch.snapshot === undefined) {
            const seen = new Set<string>()
            const elsewhere = await mcpExposedNames(db, workspaceId, row.id)
            const httpNames = new Set(
              (
                await db
                  .select({ name: schema.tools.name })
                  .from(schema.tools)
                  .where(eq(schema.tools.workspaceId, workspaceId))
              ).map((tool) => tool.name),
            )
            for (const entry of body.allowed) {
              const tool = row.snapshot.find((candidate) => candidate.name === entry.name)
              if (!tool) return status(400, { error: `"${entry.name}" is not one of its tools` })
              if (tool.tooLarge) {
                return status(400, {
                  error: `"${entry.name}" describes itself too largely to offer`,
                })
              }
              if (entry.effect === 'read' && tool.readOnly === false) {
                return status(400, {
                  error: `"${entry.name}" says it changes things, so it can only be a write`,
                })
              }
              const exposed = exposedMcpToolName(row.name, entry.name)
              if (
                seen.has(exposed) ||
                elsewhere.has(exposed) ||
                httpNames.has(exposed) ||
                (RESERVED_TOOL_NAMES as readonly string[]).includes(exposed)
              ) {
                return status(409, { error: `another tool is already called "${exposed}"` })
              }
              seen.add(exposed)
            }
            patch.allowed = body.allowed
          }

          await db
            .update(schema.mcpServers)
            .set(patch)
            .where(
              and(
                eq(schema.mcpServers.id, params.id),
                eq(schema.mcpServers.workspaceId, workspaceId),
              ),
            )
          return { ok: true }
        },
        {
          auth: 'admin',
          params: z.object({ id: z.string() }),
          body: z.object({
            url: urlSchema.optional(),
            enabled: z.boolean().optional(),
            timeoutMs: z.number().int().min(1000).max(15000).optional(),
            headerName: z
              .string()
              .regex(/^[A-Za-z0-9-]{1,80}$/)
              .optional(),
            /** Omit to keep the stored token; an empty string clears it. */
            credential: z.string().max(4000).optional(),
            allowed: z.array(mcpAllowedToolSchema).max(100).optional(),
          }),
        },
      )

      .delete(
        '/:id',
        async ({ workspaceId, params }) => {
          await db
            .delete(schema.mcpServers)
            .where(
              and(
                eq(schema.mcpServers.id, params.id),
                eq(schema.mcpServers.workspaceId, workspaceId),
              ),
            )
          return { ok: true }
        },
        { auth: 'admin', params: z.object({ id: z.string() }) },
      )

      /**
       * Ask the server what it offers and store that as the snapshot to approve from. Tools
       * approved before that the server no longer lists are dropped from the allowlist.
       */
      .post(
        '/:id/fetch-tools',
        async ({ workspaceId, params, status }) => {
          const row = await load(workspaceId, params.id)
          if (!row) return status(404, { error: 'Server not found' })
          try {
            const snapshot = await fetchMcpTools(
              {
                url: row.url,
                headers: await serverHeaders(row, env.APP_SECRET_KEY),
                timeoutMs: row.timeoutMs,
              },
              runtime.toolFetch,
            )
            const allowed = row.allowed.filter((entry) =>
              snapshot.some((tool) => tool.name === entry.name && !tool.tooLarge),
            )
            await db
              .update(schema.mcpServers)
              .set({
                snapshot,
                allowed,
                fetchedAt: new Date(),
                lastError: null,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(schema.mcpServers.id, params.id),
                  eq(schema.mcpServers.workspaceId, workspaceId),
                ),
              )
            return { ok: true as const, tools: snapshot.length }
          } catch (error) {
            const message = (error instanceof Error ? error.message : String(error)).slice(0, 500)
            await db
              .update(schema.mcpServers)
              .set({ lastError: message, updatedAt: new Date() })
              .where(
                and(
                  eq(schema.mcpServers.id, params.id),
                  eq(schema.mcpServers.workspaceId, workspaceId),
                ),
              )
            return { ok: false as const, error: message }
          }
        },
        { auth: 'admin', params: z.object({ id: z.string() }) },
      )

      /**
       * Call one approved tool now, the way a turn would, with obvious placeholders for what
       * a conversation would bind. A write runs for real: the console says so before the
       * button is pressed.
       */
      .post(
        '/:id/test',
        async ({ workspaceId, params, body, status }) => {
          const row = await load(workspaceId, params.id)
          if (!row) return status(404, { error: 'Server not found' })
          const tool = approvedTools(row).find((candidate) => candidate.remoteName === body.tool)
          if (!tool) return status(400, { error: 'Allow the tool before testing it' })
          const placeholders: Record<string, string | null> = {
            workspace_id: workspaceId,
            conversation_id: 'test-conversation',
            customer_id: 'test-customer',
            subject: body.subject ?? null,
          }
          const bound: Record<string, unknown> = {}
          for (const binding of tool.bindings) {
            const value = placeholders[binding.source]
            if (value === null || value === undefined) {
              return status(400, { error: 'This tool needs a verified identity to test' })
            }
            bound[binding.name] = value
          }
          const startedAt = Date.now()
          try {
            const result = await callMcpTool(
              {
                url: row.url,
                headers: await serverHeaders(row, env.APP_SECRET_KEY),
                timeoutMs: row.timeoutMs,
              },
              runtime.toolFetch,
              tool.remoteName,
              { ...(body.args ?? {}), ...bound },
            )
            return {
              ok: !result.isError,
              durationMs: Date.now() - startedAt,
              body: result.text.slice(0, 8 * 1024),
            }
          } catch (error) {
            return {
              ok: false,
              durationMs: Date.now() - startedAt,
              error: error instanceof Error ? error.message : String(error),
            }
          }
        },
        {
          auth: 'admin',
          params: z.object({ id: z.string() }),
          body: z.object({
            tool: z.string().min(1).max(128),
            args: z.record(z.string(), z.unknown()).optional(),
            subject: z.string().min(1).optional(),
          }),
        },
      )
  )
}
