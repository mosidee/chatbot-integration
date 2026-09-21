import { executeHttpTool, type HttpToolDefinition } from '@ci/core'
import { decryptSecret, encryptSecret, newId, schema } from '@ci/db'
import {
  httpToolConfigSchema,
  RESERVED_TOOL_NAMES,
  type ToolSummary,
  toolNameSchema,
} from '@ci/shared'
import { and, eq } from 'drizzle-orm'
import Elysia from 'elysia'
import { z } from 'zod'
import { authPlugin } from '../auth-plugin'
import type { ApiContext } from '../context'

/**
 * Tenant-defined tools.
 *
 * Admin-only throughout: defining one stores a credential and points our infrastructure at
 * a host of somebody else's choosing, which is not a thing an agent should be able to do
 * between conversations.
 *
 * The credential is write-only, like every other secret here: it is encrypted on the way in
 * and the API reports `hasCredential` rather than ever handing it back.
 */
export function toolRoutes(ctx: ApiContext) {
  const { db, env, runtime } = ctx

  const summarise = (row: typeof schema.tools.$inferSelect): ToolSummary => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    config: row.config,
    hasCredential: Boolean(row.credentialEncrypted),
  })

  /** A reserved name would be silently dropped by the merge, so it is refused up front. */
  const reserved = (name: string): boolean =>
    (RESERVED_TOOL_NAMES as readonly string[]).includes(name)

  return (
    new Elysia({ prefix: '/settings/tools' })
      .use(authPlugin(ctx))

      .get(
        '/',
        async ({ workspaceId }) => {
          const rows = await db
            .select()
            .from(schema.tools)
            .where(eq(schema.tools.workspaceId, workspaceId))
            .orderBy(schema.tools.name)
          return { tools: rows.map(summarise) }
        },
        { auth: 'admin' },
      )

      .post(
        '/',
        async ({ workspaceId, body, status }) => {
          if (reserved(body.name)) {
            return status(400, { error: `"${body.name}" is the name of a built-in tool` })
          }

          const existing = await db
            .select({ id: schema.tools.id })
            .from(schema.tools)
            .where(and(eq(schema.tools.workspaceId, workspaceId), eq(schema.tools.name, body.name)))
            .limit(1)
          if (existing.length > 0) {
            return status(409, { error: `a tool called "${body.name}" already exists` })
          }

          const id = newId()
          await db.insert(schema.tools).values({
            id,
            workspaceId,
            kind: 'http',
            name: body.name,
            description: body.description,
            config: body.config,
            enabled: body.enabled ?? true,
            credentialEncrypted: body.credential
              ? await encryptSecret(body.credential, env.APP_SECRET_KEY)
              : null,
          })
          return { id }
        },
        {
          auth: 'admin',
          body: z.object({
            name: toolNameSchema,
            description: z.string().min(1).max(500),
            config: httpToolConfigSchema,
            credential: z.string().min(1).optional(),
            enabled: z.boolean().optional(),
          }),
        },
      )

      .patch(
        '/:id',
        async ({ workspaceId, params, body, status }) => {
          if (body.name && reserved(body.name)) {
            return status(400, { error: `"${body.name}" is the name of a built-in tool` })
          }

          const patch: Partial<typeof schema.tools.$inferInsert> = { updatedAt: new Date() }
          if (body.name !== undefined) patch.name = body.name
          if (body.description !== undefined) patch.description = body.description
          if (body.config !== undefined) patch.config = body.config
          if (body.enabled !== undefined) patch.enabled = body.enabled
          if (body.credential !== undefined) {
            // Omitted keeps whatever is stored; an empty string clears it. Same contract as
            // a provider key, so the console can reuse the control.
            patch.credentialEncrypted = body.credential
              ? await encryptSecret(body.credential, env.APP_SECRET_KEY)
              : null
          }

          const updated = await db
            .update(schema.tools)
            .set(patch)
            .where(and(eq(schema.tools.id, params.id), eq(schema.tools.workspaceId, workspaceId)))
            .returning({ id: schema.tools.id })

          if (updated.length === 0) return status(404, { error: 'Tool not found' })
          return { ok: true }
        },
        {
          auth: 'admin',
          params: z.object({ id: z.string() }),
          body: z.object({
            name: toolNameSchema.optional(),
            description: z.string().min(1).max(500).optional(),
            config: httpToolConfigSchema.optional(),
            /** Omit to keep the stored credential; send an empty string to clear it. */
            credential: z.string().nullable().optional(),
            enabled: z.boolean().optional(),
          }),
        },
      )

      .delete(
        '/:id',
        async ({ workspaceId, params }) => {
          await db
            .delete(schema.tools)
            .where(and(eq(schema.tools.id, params.id), eq(schema.tools.workspaceId, workspaceId)))
          return { ok: true }
        },
        { auth: 'admin', params: z.object({ id: z.string() }) },
      )

      /**
       * Call the endpoint now, the way a turn would.
       *
       * Through the same `executeHttpTool` and the same restricted client a real turn uses,
       * so a tenant who sees this succeed can trust that the AI will get the same answer.
       * A wrong URL should be found here rather than in front of a customer.
       */
      .post(
        '/:id/test',
        async ({ workspaceId, params, body, status }) => {
          const rows = await db
            .select()
            .from(schema.tools)
            .where(and(eq(schema.tools.id, params.id), eq(schema.tools.workspaceId, workspaceId)))
            .limit(1)
          const row = rows[0]
          if (!row) return status(404, { error: 'Tool not found' })

          const definition: HttpToolDefinition = {
            id: row.id,
            name: row.name,
            description: row.description,
            config: row.config,
            credential: row.credentialEncrypted
              ? await decryptSecret(row.credentialEncrypted, env.APP_SECRET_KEY)
              : null,
          }

          const startedAt = Date.now()
          try {
            const outcome = await executeHttpTool(
              definition,
              body.args ?? {},
              {
                workspaceId,
                conversationId: 'test-conversation',
                customerId: 'test-customer',
                // Supplied by the person testing, because a tool that binds a subject cannot
                // be exercised at all without one and they are the only one who can name a
                // safe value to try.
                subject: body.subject ?? null,
                attributes: {},
              },
              { fetch: runtime.toolFetch },
            )
            return {
              ok: true as const,
              status: outcome.status,
              durationMs: Date.now() - startedAt,
              body: outcome.body,
            }
          } catch (error) {
            return {
              ok: false as const,
              durationMs: Date.now() - startedAt,
              error: error instanceof Error ? error.message : String(error),
            }
          }
        },
        {
          auth: 'admin',
          params: z.object({ id: z.string() }),
          body: z.object({
            args: z.record(z.string(), z.unknown()).optional(),
            subject: z.string().min(1).optional(),
          }),
        },
      )
  )
}
