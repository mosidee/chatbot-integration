import { encryptJson, encryptSecret, newId, schema } from '@ci/db'
import { aiTaskSchema, channelTypeSchema, conversationModeSchema, languageSchema } from '@ci/shared'
import { and, eq } from 'drizzle-orm'
import Elysia from 'elysia'
import { z } from 'zod'
import { authPlugin } from '../auth-plugin'
import type { ApiContext } from '../context'

/**
 * Workspace configuration: providers, task slots, channels, settings and people.
 *
 * Credentials are write-only. A saved key is encrypted immediately and never returned;
 * responses carry `hasKey` so the GUI can show that one is configured without ever
 * holding it.
 */
export function settingsRoutes(ctx: ApiContext) {
  const { db, env, runtime } = ctx

  return (
    new Elysia({ prefix: '/settings' })
      .use(authPlugin(ctx))

      // ---- workspace -------------------------------------------------------------
      .get(
        '/workspace',
        async ({ workspaceId, status }) => {
          const rows = await db
            .select()
            .from(schema.workspaces)
            .where(eq(schema.workspaces.id, workspaceId))
            .limit(1)
          const workspace = rows[0]
          if (!workspace) return status(404, { error: 'Workspace not found' })

          // A viewer can read settings, so the external retrieval credential is reported as
          // present rather than returned, exactly as provider keys are.
          const { externalRetrieval, ...rest } = workspace.settings
          return {
            settings: {
              ...rest,
              externalRetrieval: externalRetrieval
                ? {
                    kind: externalRetrieval.kind,
                    baseUrl: externalRetrieval.baseUrl,
                    datasetId: externalRetrieval.datasetId,
                    topK: externalRetrieval.topK,
                    scoreThreshold: externalRetrieval.scoreThreshold,
                    hasApiKey: Boolean(externalRetrieval.apiKeyEncrypted),
                  }
                : null,
            },
          }
        },
        { auth: 'viewer' },
      )

      .patch(
        '/workspace',
        async ({ workspaceId, body, status }) => {
          const rows = await db
            .select()
            .from(schema.workspaces)
            .where(eq(schema.workspaces.id, workspaceId))
            .limit(1)
          const workspace = rows[0]
          if (!workspace) return status(404, { error: 'Workspace not found' })

          const { externalRetrieval: incomingExternal, ...plainBody } = body
          const merged: typeof workspace.settings = { ...workspace.settings, ...plainBody }

          if (incomingExternal !== undefined) {
            merged.externalRetrieval = incomingExternal
              ? {
                  kind: incomingExternal.kind,
                  baseUrl: incomingExternal.baseUrl,
                  datasetId: incomingExternal.datasetId ?? null,
                  ...(incomingExternal.topK !== undefined ? { topK: incomingExternal.topK } : {}),
                  ...(incomingExternal.scoreThreshold !== undefined
                    ? { scoreThreshold: incomingExternal.scoreThreshold }
                    : {}),
                  // An omitted key keeps whatever was stored; an empty string clears it.
                  apiKeyEncrypted:
                    incomingExternal.apiKey === undefined
                      ? (workspace.settings.externalRetrieval?.apiKeyEncrypted ?? null)
                      : incomingExternal.apiKey
                        ? await encryptSecret(incomingExternal.apiKey, env.APP_SECRET_KEY)
                        : null,
                }
              : null
          }
          await db
            .update(schema.workspaces)
            .set({ settings: merged, updatedAt: new Date() })
            .where(eq(schema.workspaces.id, workspaceId))
          return { settings: merged }
        },
        {
          auth: 'admin',
          body: z.object({
            defaultLanguage: languageSchema.optional(),
            defaultMode: conversationModeSchema.optional(),
            persona: z.string().max(8000).optional(),
            retentionDays: z.number().int().min(1).max(3650).optional(),
            waitingHumanFallbackMinutes: z.number().int().min(1).max(1440).nullable().optional(),
            redaction: z
              .object({ cardNumbers: z.boolean(), thaiNationalId: z.boolean() })
              .optional(),
            acknowledgementText: z.record(languageSchema, z.string()).optional(),
            modelPrices: z
              .record(
                z.string(),
                z.object({ inputPerMillion: z.number(), outputPerMillion: z.number() }),
              )
              .optional(),
            businessHours: z
              .object({
                timezone: z.string(),
                days: z.record(
                  z.string(),
                  z.object({ open: z.string(), close: z.string() }).optional(),
                ),
              })
              .optional(),
            externalRetrieval: z
              .object({
                kind: z.enum(['dify', 'ragflow', 'generic']),
                baseUrl: z.string().url(),
                /** Omit to keep the stored key; send an empty string to clear it. */
                apiKey: z.string().optional(),
                datasetId: z.string().nullable().optional(),
                topK: z.number().int().min(1).max(50).optional(),
                scoreThreshold: z.number().min(0).max(1).optional(),
              })
              .nullable()
              .optional(),
          }),
        },
      )

      // ---- providers -------------------------------------------------------------
      .get(
        '/providers',
        async ({ workspaceId }) => {
          const rows = await db
            .select()
            .from(schema.providers)
            .where(eq(schema.providers.workspaceId, workspaceId))
          return {
            providers: rows.map((p) => ({
              id: p.id,
              name: p.name,
              baseUrl: p.baseUrl,
              hasKey: Boolean(p.apiKeyEncrypted),
              supportsTools: p.supportsTools,
              supportsVision: p.supportsVision,
              enabled: p.enabled,
            })),
          }
        },
        { auth: 'admin' },
      )

      .post(
        '/providers',
        async ({ workspaceId, body }) => {
          const id = newId()
          await db.insert(schema.providers).values({
            id,
            workspaceId,
            name: body.name,
            baseUrl: body.baseUrl,
            apiKeyEncrypted: body.apiKey
              ? await encryptSecret(body.apiKey, env.APP_SECRET_KEY)
              : null,
            headersEncrypted: body.headers
              ? await encryptJson(body.headers, env.APP_SECRET_KEY)
              : null,
            supportsTools: body.supportsTools ?? true,
            supportsVision: body.supportsVision ?? false,
          })
          return { id }
        },
        {
          auth: 'admin',
          body: z.object({
            name: z.string().min(1).max(80),
            baseUrl: z.string().url(),
            apiKey: z.string().min(1).optional(),
            headers: z.record(z.string(), z.string()).optional(),
            supportsTools: z.boolean().optional(),
            supportsVision: z.boolean().optional(),
          }),
        },
      )

      .patch(
        '/providers/:id',
        async ({ workspaceId, params, body }) => {
          const patch: Partial<typeof schema.providers.$inferInsert> = { updatedAt: new Date() }
          if (body.name !== undefined) patch.name = body.name
          if (body.baseUrl !== undefined) patch.baseUrl = body.baseUrl
          if (body.supportsTools !== undefined) patch.supportsTools = body.supportsTools
          if (body.supportsVision !== undefined) patch.supportsVision = body.supportsVision
          if (body.enabled !== undefined) patch.enabled = body.enabled
          if (body.apiKey !== undefined) {
            patch.apiKeyEncrypted = body.apiKey
              ? await encryptSecret(body.apiKey, env.APP_SECRET_KEY)
              : null
          }
          if (body.headers !== undefined) {
            patch.headersEncrypted = await encryptJson(body.headers, env.APP_SECRET_KEY)
          }

          await db
            .update(schema.providers)
            .set(patch)
            .where(
              and(
                eq(schema.providers.id, params.id),
                eq(schema.providers.workspaceId, workspaceId),
              ),
            )
          return { ok: true }
        },
        {
          auth: 'admin',
          params: z.object({ id: z.string() }),
          body: z.object({
            name: z.string().min(1).max(80).optional(),
            baseUrl: z.string().url().optional(),
            apiKey: z.string().nullable().optional(),
            headers: z.record(z.string(), z.string()).optional(),
            supportsTools: z.boolean().optional(),
            supportsVision: z.boolean().optional(),
            enabled: z.boolean().optional(),
          }),
        },
      )

      .delete(
        '/providers/:id',
        async ({ workspaceId, params }) => {
          await db
            .delete(schema.providers)
            .where(
              and(
                eq(schema.providers.id, params.id),
                eq(schema.providers.workspaceId, workspaceId),
              ),
            )
          return { ok: true }
        },
        { auth: 'admin', params: z.object({ id: z.string() }) },
      )

      /** Ask a provider what models it serves. Optional: many gateways do not implement it. */
      .post(
        '/providers/:id/models',
        async ({ workspaceId, params, status }) => {
          const rows = await db
            .select()
            .from(schema.providers)
            .where(
              and(
                eq(schema.providers.id, params.id),
                eq(schema.providers.workspaceId, workspaceId),
              ),
            )
            .limit(1)
          const provider = rows[0]
          if (!provider) return status(404, { error: 'Provider not found' })

          const { decryptSecret } = await import('@ci/db')
          const key = provider.apiKeyEncrypted
            ? await decryptSecret(provider.apiKeyEncrypted, env.APP_SECRET_KEY)
            : null

          try {
            const response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/models`, {
              headers: key ? { authorization: `Bearer ${key}` } : {},
              signal: AbortSignal.timeout(10_000),
            })
            if (!response.ok) return { models: [], error: `Provider returned ${response.status}` }
            const payload = (await response.json()) as { data?: { id?: string }[] }
            return {
              models: (payload.data ?? [])
                .map((m) => m.id)
                .filter((id): id is string => Boolean(id)),
            }
          } catch (error) {
            return { models: [], error: error instanceof Error ? error.message : String(error) }
          }
        },
        { auth: 'admin', params: z.object({ id: z.string() }) },
      )

      // ---- task slots ------------------------------------------------------------
      .get(
        '/task-slots',
        async ({ workspaceId }) => {
          const rows = await db
            .select()
            .from(schema.taskSlots)
            .where(eq(schema.taskSlots.workspaceId, workspaceId))
          return { slots: rows }
        },
        { auth: 'admin' },
      )

      .put(
        '/task-slots/:task',
        async ({ workspaceId, params, body }) => {
          await db
            .insert(schema.taskSlots)
            .values({
              id: newId(),
              workspaceId,
              task: params.task,
              primaryProviderId: body.primaryProviderId ?? null,
              primaryModel: body.primaryModel ?? null,
              fallbackProviderId: body.fallbackProviderId ?? null,
              fallbackModel: body.fallbackModel ?? null,
              params: body.params ?? {},
            })
            .onConflictDoUpdate({
              target: [schema.taskSlots.workspaceId, schema.taskSlots.task],
              set: {
                primaryProviderId: body.primaryProviderId ?? null,
                primaryModel: body.primaryModel ?? null,
                fallbackProviderId: body.fallbackProviderId ?? null,
                fallbackModel: body.fallbackModel ?? null,
                params: body.params ?? {},
                updatedAt: new Date(),
              },
            })
          return { ok: true }
        },
        {
          auth: 'admin',
          params: z.object({ task: aiTaskSchema }),
          body: z.object({
            primaryProviderId: z.string().nullable().optional(),
            primaryModel: z.string().nullable().optional(),
            fallbackProviderId: z.string().nullable().optional(),
            fallbackModel: z.string().nullable().optional(),
            params: z.record(z.string(), z.unknown()).optional(),
          }),
        },
      )

      // ---- channels --------------------------------------------------------------
      .get(
        '/channels',
        async ({ workspaceId }) => {
          const rows = await db
            .select()
            .from(schema.channels)
            .where(eq(schema.channels.workspaceId, workspaceId))
          return {
            channels: rows.map((c) => ({
              id: c.id,
              type: c.type,
              name: c.name,
              enabled: c.enabled,
              defaultMode: c.defaultMode,
              hasConfig: Boolean(c.configEncrypted),
              webhookUrl: `${env.WEBHOOK_BASE_URL.replace(/\/$/, '')}/api/v1/webhooks/${c.id}`,
            })),
          }
        },
        { auth: 'agent' },
      )

      .post(
        '/channels',
        async ({ workspaceId, body }) => {
          const id = newId()
          await db.insert(schema.channels).values({
            id,
            workspaceId,
            type: body.type,
            name: body.name,
            defaultMode: body.defaultMode ?? null,
            webhookSecret: newId(),
            configEncrypted: body.config
              ? await encryptJson(body.config, env.APP_SECRET_KEY)
              : null,
          })
          return { id }
        },
        {
          auth: 'admin',
          body: z.object({
            type: channelTypeSchema,
            name: z.string().min(1).max(80),
            defaultMode: conversationModeSchema.nullable().optional(),
            config: z.record(z.string(), z.unknown()).optional(),
          }),
        },
      )

      .patch(
        '/channels/:id',
        async ({ workspaceId, params, body }) => {
          const patch: Partial<typeof schema.channels.$inferInsert> = { updatedAt: new Date() }
          if (body.name !== undefined) patch.name = body.name
          if (body.enabled !== undefined) patch.enabled = body.enabled
          if (body.defaultMode !== undefined) patch.defaultMode = body.defaultMode
          if (body.config !== undefined) {
            patch.configEncrypted = await encryptJson(body.config, env.APP_SECRET_KEY)
          }
          await db
            .update(schema.channels)
            .set(patch)
            .where(
              and(eq(schema.channels.id, params.id), eq(schema.channels.workspaceId, workspaceId)),
            )
          return { ok: true }
        },
        {
          auth: 'admin',
          params: z.object({ id: z.string() }),
          body: z.object({
            name: z.string().min(1).max(80).optional(),
            enabled: z.boolean().optional(),
            defaultMode: conversationModeSchema.nullable().optional(),
            config: z.record(z.string(), z.unknown()).optional(),
          }),
        },
      )

      // ---- canned responses --------------------------------------------------------
      .get(
        '/canned-responses',
        async ({ workspaceId }) => {
          const responses = await db
            .select()
            .from(schema.cannedResponses)
            .where(eq(schema.cannedResponses.workspaceId, workspaceId))
          return { responses }
        },
        { auth: 'agent' },
      )

      .post(
        '/canned-responses',
        async ({ workspaceId, body, status }) => {
          const id = newId()
          try {
            await db.insert(schema.cannedResponses).values({
              id,
              workspaceId,
              // Stored without the slash so the composer can match what an agent types.
              shortcut: body.shortcut.replace(/^\//, ''),
              language: body.language ?? null,
              body: body.body,
            })
          } catch {
            return status(409, { error: 'That shortcut is already in use' })
          }
          return { id }
        },
        {
          auth: 'agent',
          body: z.object({
            shortcut: z.string().min(1).max(40),
            language: languageSchema.nullable().optional(),
            body: z.string().min(1).max(4000),
          }),
        },
      )

      .delete(
        '/canned-responses/:id',
        async ({ workspaceId, params }) => {
          await db
            .delete(schema.cannedResponses)
            .where(
              and(
                eq(schema.cannedResponses.id, params.id),
                eq(schema.cannedResponses.workspaceId, workspaceId),
              ),
            )
          return { ok: true }
        },
        { auth: 'agent', params: z.object({ id: z.string() }) },
      )

      // ---- people ----------------------------------------------------------------
      .get(
        '/members',
        async ({ workspaceId }) => {
          const rows = await db
            .select({
              userId: schema.member.userId,
              role: schema.member.role,
              name: schema.user.name,
              email: schema.user.email,
              image: schema.user.image,
            })
            .from(schema.member)
            .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
            .where(eq(schema.member.organizationId, workspaceId))
          return { members: rows }
        },
        { auth: 'viewer' },
      )

      .get(
        '/health',
        async () => {
          const [dbOk, redisOk] = await Promise.all([
            db
              .execute('select 1')
              .then(() => true)
              .catch(() => false),
            runtime.redis
              .ping()
              .then(() => true)
              .catch(() => false),
          ])
          return { db: dbOk, redis: redisOk }
        },
        { auth: 'admin' },
      )
  )
}
