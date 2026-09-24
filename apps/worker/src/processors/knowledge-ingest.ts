import { chunkText, type EffectPorts, type Logger } from '@ci/core'
import { schema } from '@ci/db'
import {
  indexSource,
  type KnowledgeIngestJob,
  loadAiConfig,
  parseDocument,
  type Runtime,
  replaceFileSource,
  usableSlot,
  workspaceIsWorkable,
  workspaceProviderFetch,
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

  // The source is left `pending`, so restoring the workspace leaves it visibly unfinished
  // rather than silently empty.
  const workspace = await workspaceIsWorkable(db, job.workspaceId, logger, 'knowledge_ingest')
  if (!workspace) return
  const settings = workspace.settings
  const providerFetch = await workspaceProviderFetch(runtime, job.workspaceId)
  const aiConfig = await loadAiConfig(
    db,
    job.workspaceId,
    env.APP_SECRET_KEY,
    settings.modelPrices,
    providerFetch,
  )
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
      let parsed: Awaited<ReturnType<typeof parseDocument>>
      try {
        parsed = await parseDocument(object.data, source.mime ?? object.mime, source.title)
      } catch (error) {
        // The document itself is the problem: retrying cannot help, so it is shown instead.
        throw new DocumentProblem(error instanceof Error ? error.message : String(error))
      }

      // Embedded before anything is replaced; see `replaceFileSource`.
      const replaced = await replaceFileSource(
        db,
        {
          workspaceId: job.workspaceId,
          sourceId: source.id,
          language: settings.defaultLanguage,
          body: parsed.text,
        },
        embedSlot,
      )

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

      logger.info('document parsed and indexed', {
        sourceId: source.id,
        characters: parsed.text.length,
        pages: parsed.pages,
        chunks: replaced.chunks,
      })
      return
    }

    const result = await indexSource(db, job.workspaceId, source.id, embedSlot)
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
    /**
     * A document that cannot be parsed is an operator problem, shown on the knowledge
     * screen and not worth three more attempts. Anything else — the store, the embedding
     * provider — is usually passing, so it is rethrown and retried; the previous index is
     * still answering meanwhile.
     */
    if (!(error instanceof DocumentProblem)) throw error
  }
}

class DocumentProblem extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DocumentProblem'
  }
}
