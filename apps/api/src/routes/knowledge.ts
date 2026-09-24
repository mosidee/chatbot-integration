import { type Executor, newId, schema } from '@ci/db'
import {
  createEntry,
  createExternalRetriever,
  createPostgresRetriever,
  createSource,
  deleteSource,
  loadAiConfig,
  loadWorkspaceSettings,
  resolveExternalRetrieval,
  safeKeySegment,
  usableSlot,
  workspaceProviderFetch,
} from '@ci/infra'
import { channelTypeSchema, languageSchema } from '@ci/shared'
import { and, desc, eq, sql } from 'drizzle-orm'
import Elysia from 'elysia'
import { z } from 'zod'
import { authPlugin } from '../auth-plugin'
import type { ApiContext } from '../context'

/**
 * Knowledge management.
 *
 * Q&A entries and articles are authored here; files are uploaded and parsed by the worker.
 * Every mutation re-queues indexing, because an answer the AI quotes must never lag behind
 * the answer an agent edited.
 */
export function knowledgeRoutes(ctx: ApiContext) {
  const { db, env, runtime } = ctx

  /**
   * No stable job id on purpose.
   *
   * Every edit owes a fresh pass over the source, so collapsing two re-ingests would leave
   * the index describing a version nobody can see any more. The row's own id is used, which
   * is still stable across relay attempts of that one request.
   */
  const enqueueIngest = (workspaceId: string, sourceId: string, executor: Executor = db) =>
    runtime.outbox.enqueue(executor, {
      queue: 'knowledge_ingest',
      name: 'ingest',
      workspaceId,
      payload: { workspaceId, sourceId },
    })

  return (
    new Elysia({ prefix: '/knowledge' })
      .use(authPlugin(ctx))

      // ---- sources ---------------------------------------------------------------
      .get(
        '/sources',
        async ({ workspaceId }) => {
          const sources = await db
            .select()
            .from(schema.knowledgeSources)
            .where(eq(schema.knowledgeSources.workspaceId, workspaceId))
            .orderBy(desc(schema.knowledgeSources.createdAt))

          const entries = await db
            .select()
            .from(schema.knowledgeEntries)
            .where(eq(schema.knowledgeEntries.workspaceId, workspaceId))

          // One grouped query rather than one per source.
          const chunkCounts = await db.execute<{ source_id: string; count: number }>(sql`
          SELECT source_id, count(*)::int AS count
          FROM knowledge_chunks
          WHERE workspace_id = ${workspaceId}
          GROUP BY source_id
        `)
          const counts = new Map([...chunkCounts].map((r) => [r.source_id, Number(r.count)]))

          return {
            sources: sources.map((s) => ({
              id: s.id,
              kind: s.kind,
              title: s.title,
              status: s.status,
              error: s.error,
              mime: s.mime,
              byteSize: s.byteSize,
              meta: s.meta,
              createdAt: s.createdAt,
              entryCount: entries.filter((e) => e.sourceId === s.id).length,
              chunkCount: counts.get(s.id) ?? 0,
            })),
          }
        },
        { auth: 'viewer' },
      )

      /** Create a Q&A entry or an article. Both become a source with one entry. */
      .post(
        '/sources',
        async ({ workspaceId, body, user }) => {
          const sourceId = await createSource(db, {
            workspaceId,
            kind: body.question ? 'qa' : 'article',
            title: body.title,
            createdByUserId: user.id,
          })

          await createEntry(db, {
            workspaceId,
            sourceId,
            language: body.language,
            question: body.question ?? null,
            body: body.body,
            tags: body.tags,
            channelTypes: body.channelTypes,
          })

          await enqueueIngest(workspaceId, sourceId)
          return { sourceId }
        },
        {
          auth: 'agent',
          body: z.object({
            title: z.string().min(1).max(200),
            language: languageSchema,
            question: z.string().min(1).max(500).nullable().optional(),
            body: z.string().min(1).max(100_000),
            tags: z.array(z.string().max(40)).max(10).optional(),
            channelTypes: z.array(channelTypeSchema).optional(),
          }),
        },
      )

      /** Upload a document. Parsing happens in the worker, so this returns immediately. */
      .post(
        '/sources/file',
        async ({ workspaceId, request, user, status }) => {
          const form = await request.formData()
          const file = form.get('file')
          if (!(file instanceof File)) return status(422, { error: 'Expected a file field' })
          if (file.size > 25 * 1024 * 1024) return status(413, { error: 'File exceeds 25MB' })

          // The name is the sender's: reduced so it cannot add a path segment to the key.
          const storageKey = `${workspaceId}/knowledge/${newId()}-${safeKeySegment(file.name)}`
          const bytes = new Uint8Array(await file.arrayBuffer())
          await runtime.blob.put(storageKey, bytes, file.type || 'application/octet-stream')

          const sourceId = await createSource(db, {
            workspaceId,
            kind: 'file',
            title: file.name,
            storageKey,
            mime: file.type || 'application/octet-stream',
            byteSize: file.size,
            createdByUserId: user.id,
          })

          await enqueueIngest(workspaceId, sourceId)
          return { sourceId }
        },
        { auth: 'agent' },
      )

      .post(
        '/sources/:id/reindex',
        async ({ workspaceId, params }) => {
          await enqueueIngest(workspaceId, params.id)
          return { ok: true }
        },
        { auth: 'agent', params: z.object({ id: z.string() }) },
      )

      .delete(
        '/sources/:id',
        async ({ workspaceId, params }) => {
          // The uploaded file goes too; see `deleteSource`.
          await deleteSource(db, workspaceId, params.id, runtime.blob)
          return { ok: true }
        },
        { auth: 'agent', params: z.object({ id: z.string() }) },
      )

      // ---- entries ---------------------------------------------------------------
      .get(
        '/sources/:id/entries',
        async ({ workspaceId, params }) => {
          const entries = await db
            .select()
            .from(schema.knowledgeEntries)
            .where(
              and(
                eq(schema.knowledgeEntries.sourceId, params.id),
                eq(schema.knowledgeEntries.workspaceId, workspaceId),
              ),
            )
          return { entries }
        },
        { auth: 'viewer', params: z.object({ id: z.string() }) },
      )

      .patch(
        '/entries/:id',
        async ({ workspaceId, params, body, status }) => {
          const patch: Partial<typeof schema.knowledgeEntries.$inferInsert> = {
            updatedAt: new Date(),
          }
          if (body.question !== undefined) patch.question = body.question
          if (body.body !== undefined) patch.body = body.body
          if (body.tags !== undefined) patch.tags = body.tags
          if (body.channelTypes !== undefined) patch.channelTypes = body.channelTypes
          if (body.enabled !== undefined) patch.enabled = body.enabled
          if (body.language !== undefined) patch.language = body.language

          /**
           * Refused when the entry changed since the caller's editor loaded it, so two people
           * editing one answer cannot silently discard each other's text. `updatedAt` is the
           * revision, compared at millisecond precision under a row lock.
           */
          const outcome = await db.transaction(async (tx) => {
            const [current] = await tx
              .select({ updatedAt: schema.knowledgeEntries.updatedAt })
              .from(schema.knowledgeEntries)
              .where(
                and(
                  eq(schema.knowledgeEntries.id, params.id),
                  eq(schema.knowledgeEntries.workspaceId, workspaceId),
                ),
              )
              .for('update')
            if (!current) return { kind: 'missing' as const }
            if (
              body.revision !== undefined &&
              Date.parse(body.revision) !== current.updatedAt.getTime()
            ) {
              return { kind: 'conflict' as const }
            }
            const [updated] = await tx
              .update(schema.knowledgeEntries)
              .set(patch)
              .where(
                and(
                  eq(schema.knowledgeEntries.id, params.id),
                  eq(schema.knowledgeEntries.workspaceId, workspaceId),
                ),
              )
              .returning({ sourceId: schema.knowledgeEntries.sourceId })
            // Re-index in the same commit: a stale chunk is an answer the AI would still give.
            if (updated?.sourceId) await enqueueIngest(workspaceId, updated.sourceId, tx)
            return { kind: 'saved' as const }
          })

          if (outcome.kind === 'missing') return status(404, { error: 'Entry not found' })
          if (outcome.kind === 'conflict') {
            return status(409, {
              error: 'This entry was changed by somebody else since it was opened.',
              code: 'entry_conflict',
            })
          }

          return { ok: true, revision: patch.updatedAt?.toISOString() ?? null }
        },
        {
          auth: 'agent',
          params: z.object({ id: z.string() }),
          body: z.object({
            /** The entry's `updatedAt` when the editor loaded it; a mismatch is a 409. */
            revision: z.string().datetime().optional(),
            question: z.string().max(500).nullable().optional(),
            body: z.string().min(1).max(100_000).optional(),
            tags: z.array(z.string().max(40)).max(10).optional(),
            channelTypes: z.array(channelTypeSchema).optional(),
            enabled: z.boolean().optional(),
            language: languageSchema.optional(),
          }),
        },
      )

      /**
       * Promote a reply into knowledge.
       *
       * The body comes from the client, not straight from the message. Redaction masks card
       * and ID numbers but deliberately preserves names, phone numbers and order references,
       * so an agent reviews and edits the text before it becomes a permanent answer.
       */
      .post(
        '/from-message',
        async ({ workspaceId, body, user, status }) => {
          const messageRows = await db
            .select()
            .from(schema.messages)
            .where(
              and(
                eq(schema.messages.id, body.messageId),
                eq(schema.messages.workspaceId, workspaceId),
              ),
            )
            .limit(1)
          if (!messageRows[0]) return status(404, { error: 'Message not found' })

          const sourceId = await createSource(db, {
            workspaceId,
            kind: 'qa',
            title: body.title,
            meta: { promotedFromMessageId: body.messageId },
            createdByUserId: user.id,
          })
          await createEntry(db, {
            workspaceId,
            sourceId,
            language: body.language,
            question: body.question,
            body: body.body,
          })
          await enqueueIngest(workspaceId, sourceId)
          return { sourceId }
        },
        {
          auth: 'agent',
          body: z.object({
            messageId: z.string(),
            title: z.string().min(1).max(200),
            question: z.string().min(1).max(500),
            body: z.string().min(1).max(20_000),
            language: languageSchema,
          }),
        },
      )

      /**
       * The test-search box.
       *
       * Returns the fused list and both halves, because the useful question when retrieval
       * disappoints is which half found what.
       */
      .post(
        '/search',
        async ({ workspaceId, body }) => {
          const settings = await loadWorkspaceSettings(db, workspaceId)
          const providerFetch = await workspaceProviderFetch(runtime, workspaceId)
          const aiConfig = await loadAiConfig(
            db,
            workspaceId,
            env.APP_SECRET_KEY,
            settings.modelPrices,
            providerFetch,
          )
          // The same source a real turn would use, so the box tests what customers get.
          const external = await resolveExternalRetrieval(
            settings.externalRetrieval,
            env.APP_SECRET_KEY,
            providerFetch,
          )
          const retriever = external
            ? createExternalRetriever(external)
            : createPostgresRetriever(db, {
                embedSlot: usableSlot(aiConfig, 'embed'),
                rerankSlot: usableSlot(aiConfig, 'rerank'),
              })

          const result = await retriever.retrieve({
            workspaceId,
            query: body.query,
            language: body.language ?? null,
            channelType: body.channelType ?? null,
            limit: body.limit ?? 8,
          })

          const shape = (chunk: (typeof result.chunks)[number]) => ({
            id: chunk.id,
            sourceId: chunk.sourceId,
            sourceTitle: chunk.sourceTitle,
            text: chunk.text,
            score: chunk.score,
            denseScore: chunk.denseScore,
            keywordScore: chunk.keywordScore,
          })

          return {
            embeddingModel: result.embeddingModel,
            chunks: result.chunks.map(shape),
            dense: result.dense.slice(0, 8).map(shape),
            keyword: result.keyword.slice(0, 8).map(shape),
          }
        },
        {
          auth: 'agent',
          body: z.object({
            query: z.string().min(1).max(500),
            language: languageSchema.nullable().optional(),
            channelType: channelTypeSchema.nullable().optional(),
            limit: z.number().int().min(1).max(20).optional(),
          }),
        },
      )
  )
}
