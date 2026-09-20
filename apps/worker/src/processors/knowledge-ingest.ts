import { chunkText, type EffectPorts, type Logger } from '@ci/core'
import { newId, schema } from '@ci/db'
import {
  indexSource,
  type KnowledgeIngestJob,
  loadAiConfig,
  loadWorkspaceSettings,
  parseDocument,
  type Runtime,
  usableSlot,
} from '@ci/infra'
import { and, eq } from 'drizzle-orm'

/**
 * Turn an uploaded file into retrievable knowledge.
 *
 * An uploaded document becomes one entry holding its extracted text, and chunking decides
 * retrieval granularity. Files are not edited as prose the way a Q&A entry is, so splitting
 * a manual into dozens of editable rows would add clutter without adding control.
 *
 * Failure is recorded on the source with its reason, because the most likely first upload
 * is a Thai PDF that extracts as nonsense, and "this file needs OCR" is a far more useful
 * thing to show an operator than an AI that answers badly.
 */
export async function processKnowledgeIngest(
  runtime: Runtime,
  _ports: EffectPorts,
  logger: Logger,
  job: KnowledgeIngestJob,
): Promise<void> {
  const { db, env, blob } = runtime

  const rows = await db
    .select()
    .from(schema.knowledgeSources)
    .where(
      and(
        eq(schema.knowledgeSources.id, job.sourceId),
        eq(schema.knowledgeSources.workspaceId, job.workspaceId),
      ),
    )
    .limit(1)

  const source = rows[0]
  if (!source) {
    logger.warn('knowledge source vanished before ingestion', { sourceId: job.sourceId })
    return
  }

  const settings = await loadWorkspaceSettings(db, job.workspaceId)
  const aiConfig = await loadAiConfig(db, job.workspaceId, env.APP_SECRET_KEY, settings.modelPrices)
  const embedSlot = usableSlot(aiConfig, 'embed')

  try {
    await db
      .update(schema.knowledgeSources)
      .set({ status: 'processing', error: null, updatedAt: new Date() })
      .where(eq(schema.knowledgeSources.id, source.id))

    // A file source needs parsing first; a Q&A or article source already has its entries.
    if (source.kind === 'file') {
      if (!source.storageKey) throw new Error('The source has no stored file')

      const object = await blob.get(source.storageKey)
      const parsed = await parseDocument(object.data, source.mime ?? object.mime, source.title)

      // Replace whatever a previous ingestion produced, so re-uploading cannot leave stale
      // text the AI would still quote.
      await db
        .delete(schema.knowledgeEntries)
        .where(eq(schema.knowledgeEntries.sourceId, source.id))

      const entryId = newId()
      await db.insert(schema.knowledgeEntries).values({
        id: entryId,
        workspaceId: job.workspaceId,
        sourceId: source.id,
        variantGroup: entryId,
        language: settings.defaultLanguage,
        question: null,
        body: parsed.text,
      })

      await db
        .update(schema.knowledgeSources)
        .set({
          meta: {
            ...source.meta,
            pages: parsed.pages,
            characters: parsed.text.length,
            estimatedChunks: chunkText(parsed.text).length,
            parserWarnings: parsed.warnings.slice(0, 5),
          },
          updatedAt: new Date(),
        })
        .where(eq(schema.knowledgeSources.id, source.id))

      logger.info('document parsed', {
        sourceId: source.id,
        characters: parsed.text.length,
        pages: parsed.pages,
      })
    }

    const result = await indexSource(db, source.id, embedSlot)
    logger.info('knowledge indexed', {
      sourceId: source.id,
      entries: result.entries,
      chunks: result.chunks,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await db
      .update(schema.knowledgeSources)
      .set({ status: 'failed', error: message, updatedAt: new Date() })
      .where(eq(schema.knowledgeSources.id, source.id))
    logger.error('knowledge ingestion failed', { sourceId: source.id, error: message })
    // Not rethrown: a bad document is an operator problem shown in the knowledge screen,
    // not a transient fault worth retrying three times.
  }
}
