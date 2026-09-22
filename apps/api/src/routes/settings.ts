import { getAdapter } from '@ci/channels'
import { verifyChatModel, verifyEmbeddingModel } from '@ci/core'
import {
  decryptJson,
  decryptSecret,
  EMBEDDING_DIMENSIONS,
  encryptJson,
  encryptSecret,
  isPlatformAdmin,
  newId,
  schema,
} from '@ci/db'
import type { WorkspaceSettings } from '@ci/db/schema/app'
import { withSettingsDefaults } from '@ci/infra'
import { aiTaskSchema, channelTypeSchema, conversationModeSchema, languageSchema } from '@ci/shared'
import { and, eq } from 'drizzle-orm'
import Elysia from 'elysia'
import { z } from 'zod'
import { authPlugin } from '../auth-plugin'
import type { ApiContext } from '../context'
import { chooseMembership, loadMemberships } from '../context'

/**
 * Workspace configuration: providers, task slots, channels, settings and people.
 *
 * Credentials are write-only. A saved key is encrypted immediately and never returned;
 * responses carry `hasKey` so the GUI can show that one is configured without ever
 * holding it.
 */
/** What an operator has to paste for each platform, shown beside the form. */
const REQUIRED_FIELDS: Record<string, { key: string; label: string; secret: boolean }[]> = {
  line: [
    { key: 'channelSecret', label: 'Channel secret', secret: true },
    { key: 'channelAccessToken', label: 'Channel access token', secret: true },
  ],
  messenger: [
    { key: 'appSecret', label: 'App secret', secret: true },
    { key: 'pageId', label: 'Page ID', secret: false },
    { key: 'pageAccessToken', label: 'Page access token', secret: true },
  ],
  test: [],
  web: [{ key: 'visitorTokenSecret', label: 'Visitor token secret', secret: true }],
}

/**
 * Workspace settings as the browser is allowed to see them.
 *
 * Credentials are reported as present and never returned, here and in every response that
 * carries settings: a viewer can read this, and an admin has no reason to be handed back a
 * secret they just wrote. One function rather than two, because the two drifted apart once
 * already and the reply to a write is the easier of the pair to forget.
 */
function publicSettings(raw: WorkspaceSettings) {
  const { externalRetrieval, identity, ...rest } = withSettingsDefaults(raw)
  return {
    ...rest,
    identity: {
      widgetToken: identity.widgetToken,
      verificationLink: {
        enabled: identity.verificationLink.enabled,
        url: identity.verificationLink.url,
        ttlMinutes: identity.verificationLink.ttlMinutes,
        hasSecret: Boolean(identity.verificationLink.secretEncrypted),
      },
    },
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
  }
}

export function settingsRoutes(ctx: ApiContext) {
  const { db, env, runtime } = ctx

  /**
   * The widget's allowed origins, read back for the console to edit.
   *
   * Decryption can fail after a key rotation, and a settings page that will not load is a
   * worse outcome than one that shows an empty list, so this never throws.
   */
  const allowedOriginsOf = async (encrypted: string | null): Promise<string[]> => {
    if (!encrypted) return []
    try {
      const config = await decryptJson<{ allowedOrigins?: unknown }>(encrypted, env.APP_SECRET_KEY)
      return Array.isArray(config.allowedOrigins)
        ? config.allowedOrigins.filter((value): value is string => typeof value === 'string')
        : []
    } catch {
      return []
    }
  }

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

          return { settings: publicSettings(workspace.settings) }
        },
        { auth: 'viewer' },
      )

      /**
       * Who the caller is, and everywhere they belong.
       *
       * The console needs it to decide whether to offer controls only an admin may use.
       * Hiding one is a courtesy, not the guard: every such route checks the role itself.
       *
       * Guarded by the session alone, not by a workspace role, and that matters. Somebody
       * whose only workspace has been suspended still has to be told which one and why, and
       * a platform admin has to reach the platform page from a console that cannot load a
       * single tenant endpoint. Behind `auth: 'viewer'` this endpoint would refuse exactly
       * the people who most need an answer from it.
       */
      .get(
        '/me',
        async ({ user, activeOrganizationId }) => {
          const memberships = await loadMemberships(db, user.id)
          const current = chooseMembership(memberships, activeOrganizationId)

          return {
            userId: user.id,
            email: user.email,
            name: user.name,
            /** Null when they belong nowhere; the console shows a locked screen for it. */
            role: current?.role ?? null,
            workspace: current
              ? {
                  id: current.workspaceId,
                  name: current.name,
                  slug: current.slug,
                  status: current.status,
                }
              : null,
            /**
             * Every membership, suspended ones included. The switcher is how somebody
             * leaves a suspended workspace, so hiding it would trap them in one.
             */
            memberships: memberships.map((m) => ({
              id: m.workspaceId,
              name: m.name,
              slug: m.slug,
              role: m.role,
              status: m.status,
            })),
            platformAdmin: await isPlatformAdmin(db, user.id),
          }
        },
        { session: true },
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

          const {
            externalRetrieval: incomingExternal,
            identity: incomingIdentity,
            ...plainBody
          } = body
          const current = withSettingsDefaults(workspace.settings)
          const merged: typeof workspace.settings = { ...current, ...plainBody }

          if (incomingIdentity !== undefined) {
            const link = incomingIdentity.verificationLink
            merged.identity = {
              widgetToken: {
                enabled:
                  incomingIdentity.widgetToken?.enabled ?? current.identity.widgetToken.enabled,
              },
              verificationLink: {
                enabled: link?.enabled ?? current.identity.verificationLink.enabled,
                url: link?.url === undefined ? current.identity.verificationLink.url : link.url,
                ttlMinutes: link?.ttlMinutes ?? current.identity.verificationLink.ttlMinutes,
                // An omitted secret keeps what is stored; an empty string clears it.
                secretEncrypted:
                  link?.secret === undefined
                    ? current.identity.verificationLink.secretEncrypted
                    : link.secret
                      ? await encryptSecret(link.secret, env.APP_SECRET_KEY)
                      : null,
              },
            }
          }

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
          // Through the same projection the GET uses. Returning `merged` directly handed
          // the stored ciphertext of both credentials straight back to the browser.
          return { settings: publicSettings(merged) }
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
            acknowledgementText: z.record(languageSchema, z.string().max(1000)).optional(),
            stillWaitingText: z.record(languageSchema, z.string().max(1000)).optional(),
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
            identity: z
              .object({
                widgetToken: z.object({ enabled: z.boolean() }).optional(),
                verificationLink: z
                  .object({
                    enabled: z.boolean().optional(),
                    url: z.string().url().nullable().optional(),
                    /** Omit to keep the stored secret; send an empty string to clear it. */
                    secret: z.string().optional(),
                    ttlMinutes: z.number().int().min(1).max(1440).optional(),
                  })
                  .optional(),
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

      /**
       * Call one model once, so a catalogue entry that the gateway will not actually serve
       * is found here rather than by a customer asking a question and getting silence.
       */
      .post(
        '/providers/:id/verify-model',
        async ({ workspaceId, params, body, status }) => {
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

          const target = {
            provider: {
              id: provider.id,
              name: provider.name,
              baseUrl: provider.baseUrl,
              apiKey: provider.apiKeyEncrypted
                ? await decryptSecret(provider.apiKeyEncrypted, env.APP_SECRET_KEY)
                : null,
              headers: provider.headersEncrypted
                ? await decryptJson<Record<string, string>>(
                    provider.headersEncrypted,
                    env.APP_SECRET_KEY,
                  )
                : {},
              supportsTools: provider.supportsTools,
              supportsVision: provider.supportsVision,
            },
            model: body.model,
          }

          // An embedding slot holds an embedding model, which a chat request would refuse
          // for the wrong reason entirely.
          return body.task === 'embed'
            ? await verifyEmbeddingModel(target, EMBEDDING_DIMENSIONS, body.sendDimensions ?? true)
            : await verifyChatModel(target)
        },
        {
          auth: 'admin',
          params: z.object({ id: z.string() }),
          body: z.object({
            model: z.string().min(1),
            task: aiTaskSchema,
            sendDimensions: z.boolean().optional(),
          }),
        },
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
          // Params are merged, not replaced. The console saves a slot whenever a provider or
          // model changes and sends only those fields, so replacing would quietly drop every
          // tuning value the slot holds.
          const existing = await db
            .select({ params: schema.taskSlots.params })
            .from(schema.taskSlots)
            .where(
              and(
                eq(schema.taskSlots.workspaceId, workspaceId),
                eq(schema.taskSlots.task, params.task),
              ),
            )
            .limit(1)
          const merged = { ...(existing[0]?.params ?? {}), ...(body.params ?? {}) }

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
              params: merged,
            })
            .onConflictDoUpdate({
              target: [schema.taskSlots.workspaceId, schema.taskSlots.task],
              set: {
                primaryProviderId: body.primaryProviderId ?? null,
                primaryModel: body.primaryModel ?? null,
                fallbackProviderId: body.fallbackProviderId ?? null,
                fallbackModel: body.fallbackModel ?? null,
                params: merged,
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
            channels: await Promise.all(
              rows.map(async (c) => ({
                id: c.id,
                type: c.type,
                name: c.name,
                enabled: c.enabled,
                defaultMode: c.defaultMode,
                hasConfig: Boolean(c.configEncrypted),
                // Meta asks for this when subscribing a page; the operator pastes it back.
                verifyToken: c.type === 'messenger' ? c.webhookSecret : null,
                requiredFields: REQUIRED_FIELDS[c.type] ?? [],
                webhookUrl: `${env.WEBHOOK_BASE_URL.replace(/\/$/, '')}/api/v1/webhooks/${c.id}`,
                // Only the widget needs these, and neither is a secret: the origins are a
                // restriction rather than a credential, and the embed URL is public by
                // definition since it ends up in somebody's page source.
                ...(c.type === 'web'
                  ? {
                      allowedOrigins: await allowedOriginsOf(c.configEncrypted),
                      embedUrl: `${env.PUBLIC_API_URL.replace(/\/$/, '')}/widget/loader.js`,
                    }
                  : {}),
              })),
            ),
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

      /**
       * Ask the platform whether the stored credentials work.
       *
       * Pasting a token and learning it was wrong when a customer's first message goes
       * unanswered is a bad way to find out.
       */
      .post(
        '/channels/:id/check',
        async ({ workspaceId, params, status }) => {
          const rows = await db
            .select()
            .from(schema.channels)
            .where(
              and(eq(schema.channels.id, params.id), eq(schema.channels.workspaceId, workspaceId)),
            )
            .limit(1)

          const channel = rows[0]
          if (!channel) return status(404, { error: 'Channel not found' })

          const adapter = getAdapter(channel.type)
          if (!adapter.checkCredentials) {
            return { ok: true, detail: 'This channel needs no credentials.' }
          }
          if (!channel.configEncrypted) {
            return { ok: false, detail: 'No credentials have been saved yet.' }
          }

          try {
            const config = adapter.parseConfig(
              await decryptJson<unknown>(channel.configEncrypted, env.APP_SECRET_KEY),
            )
            return await adapter.checkCredentials(config)
          } catch (error) {
            return {
              ok: false,
              detail: `The saved settings are incomplete: ${
                error instanceof Error ? error.message : String(error)
              }`.slice(0, 300),
            }
          }
        },
        { auth: 'admin', params: z.object({ id: z.string() }) },
      )
      .patch(
        '/channels/:id',
        async ({ workspaceId, params, body }) => {
          const patch: Partial<typeof schema.channels.$inferInsert> = { updatedAt: new Date() }
          if (body.name !== undefined) patch.name = body.name
          if (body.enabled !== undefined) patch.enabled = body.enabled
          if (body.defaultMode !== undefined) patch.defaultMode = body.defaultMode
          if (body.config !== undefined) {
            /**
             * Merged, not replaced.
             *
             * The console sends only the fields somebody edited, because a secret it may
             * not read cannot be sent back. Replacing the whole config meant that setting
             * the widget's allowed origins silently erased its visitor token secret, and
             * the other way round. A blank value is treated as "leave it alone", which is
             * what the form's own "unchanged" placeholder promises.
             */
            const rows = await db
              .select({ configEncrypted: schema.channels.configEncrypted })
              .from(schema.channels)
              .where(
                and(
                  eq(schema.channels.id, params.id),
                  eq(schema.channels.workspaceId, workspaceId),
                ),
              )
              .limit(1)

            const existing = rows[0]?.configEncrypted
              ? await decryptJson<Record<string, unknown>>(
                  rows[0].configEncrypted,
                  env.APP_SECRET_KEY,
                )
              : {}

            const incoming = Object.fromEntries(
              Object.entries(body.config).filter(([, value]) => value !== ''),
            )

            patch.configEncrypted = await encryptJson(
              { ...existing, ...incoming },
              env.APP_SECRET_KEY,
            )
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
