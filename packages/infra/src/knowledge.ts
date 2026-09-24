import { type BlobStore, chunkQa, chunkText, embedTexts, type SlotConfig } from '@ci/core'
import { type Database, EMBEDDING_DIMENSIONS, newId, schema } from '@ci/db'
import type { Language } from '@ci/shared'
import { and, eq } from 'drizzle-orm'
import { drainBlobDeletions, queueBlobDeletions } from './blob-deletions'

/**
 * Turning knowledge into something retrievable.
 *
 * Indexing is idempotent per entry: chunks are deleted and rewritten, so editing an answer
 * cannot leave stale text behind that the AI would still quote.
 */

export type IndexResult = {
  chunks: number
  model: string | null
  skipped: boolean
}

/** Chunk, embed and store one entry. Replaces whatever was indexed for it before. */
export async function indexEntry(
  db: Database,
  entryId: string,
  embedSlot: SlotConfig | null,
  dimensions = EMBEDDING_DIMENSIONS,
): Promise<IndexResult> {
  const rows = await db
    .select()
    .from(schema.knowledgeEntries)
    .where(eq(schema.knowledgeEntries.id, entryId))
    .limit(1)

  const entry = rows[0]
  if (!entry) return { chunks: 0, model: null, skipped: true }

  const clearChunks = () =>
    db.delete(schema.knowledgeChunks).where(eq(schema.knowledgeChunks.entryId, entryId))

  if (!entry.enabled) {
    await clearChunks()
    return { chunks: 0, model: null, skipped: true }
  }

  const pieces = chunkQa(entry.question, entry.body)
  if (pieces.length === 0) {
    await clearChunks()
    return { chunks: 0, model: null, skipped: true }
  }

  // Embed before replacing anything. Deleting first would mean a provider failure mid-edit
  // left the entry with no chunks at all, silently dropping it out of retrieval until
  // somebody noticed and re-indexed.
  //
  // Without an embedding provider the chunks are still stored, so keyword retrieval works;
  // the embedding column stays null and a later re-index fills it in.
  const { embeddings, model, space } = await embedPieces(embedSlot, pieces, dimensions)

  // Replace atomically, so retrieval never sees an entry mid-rewrite.
  const stored = await db.transaction(async (tx) => {
    /**
     * Is the entry still what was embedded? Two edits a second apart are two index jobs,
     * and the older one, slower to embed, used to commit last and put the old answer back
     * in retrieval over the new one. The newer edit queued a job of its own, so an index of
     * text that has since changed steps aside. The lock orders this against that job's swap.
     */
    const [current] = await tx
      .select({
        question: schema.knowledgeEntries.question,
        body: schema.knowledgeEntries.body,
        language: schema.knowledgeEntries.language,
        enabled: schema.knowledgeEntries.enabled,
      })
      .from(schema.knowledgeEntries)
      .where(eq(schema.knowledgeEntries.id, entryId))
      .for('update')
    if (
      !current?.enabled ||
      current.question !== entry.question ||
      current.body !== entry.body ||
      current.language !== entry.language
    ) {
      return false
    }

    await tx.delete(schema.knowledgeChunks).where(eq(schema.knowledgeChunks.entryId, entryId))
    await tx.insert(schema.knowledgeChunks).values(
      pieces.map((text, index) => ({
        id: newId(),
        workspaceId: entry.workspaceId,
        sourceId: entry.sourceId,
        entryId: entry.id,
        language: entry.language,
        ord: index,
        text,
        embedding: embeddings[index] ?? null,
        embeddingModel: model,
        embeddingSpace: space,
      })),
    )
    return true
  })

  if (!stored) return { chunks: 0, model: null, skipped: true }
  return { chunks: pieces.length, model, skipped: false }
}

/**
 * Embed pieces of text, or report that there is nothing to embed with.
 *
 * Without an embedding provider the chunks are still stored, so keyword retrieval works;
 * the embedding column stays null and a later re-index fills it in.
 */
async function embedPieces(
  embedSlot: SlotConfig | null,
  pieces: string[],
  dimensions: number,
): Promise<{ embeddings: number[][]; model: string | null; space: string | null }> {
  if (!embedSlot || pieces.length === 0) return { embeddings: [], model: null, space: null }
  const embedded = await embedTexts(embedSlot, pieces, dimensions)
  return { embeddings: embedded.embeddings, model: embedded.model, space: embedded.space }
}

/**
 * Replace a file source's content with freshly parsed text, keeping the old index until the
 * new one is ready.
 *
 * Re-ingesting used to delete the old entries first, and the cascade took their chunks with
 * them before the new text had been embedded: an embedding outage mid-reindex left the
 * document answering nothing. Everything slow happens first; the swap is one transaction.
 */
export async function replaceFileSource(
  db: Database,
  input: { workspaceId: string; sourceId: string; language: Language; body: string },
  embedSlot: SlotConfig | null,
  dimensions = EMBEDDING_DIMENSIONS,
): Promise<{ chunks: number }> {
  const pieces = chunkQa(null, input.body)
  const { embeddings, model, space } = await embedPieces(embedSlot, pieces, dimensions)

  await db.transaction(async (tx) => {
    /**
     * One swap at a time per source. Two reindexes of the same file — a double click, a
     * retry overlapping the original — each deleted the entries they could see and inserted
     * their own, and neither could see the other's uncommitted row: the document ended up
     * indexed twice. Locked, the second waits and its delete then sees the first one's entry.
     */
    await tx
      .select({ id: schema.knowledgeSources.id })
      .from(schema.knowledgeSources)
      .where(
        and(
          eq(schema.knowledgeSources.id, input.sourceId),
          eq(schema.knowledgeSources.workspaceId, input.workspaceId),
        ),
      )
      .for('update')
    await tx
      .delete(schema.knowledgeEntries)
      .where(
        and(
          eq(schema.knowledgeEntries.sourceId, input.sourceId),
          eq(schema.knowledgeEntries.workspaceId, input.workspaceId),
        ),
      )
    const entryId = newId()
    await tx.insert(schema.knowledgeEntries).values({
      id: entryId,
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      variantGroup: entryId,
      language: input.language,
      question: null,
      body: input.body,
    })
    if (pieces.length > 0) {
      await tx.insert(schema.knowledgeChunks).values(
        pieces.map((text, index) => ({
          id: newId(),
          workspaceId: input.workspaceId,
          sourceId: input.sourceId,
          entryId,
          language: input.language,
          ord: index,
          text,
          embedding: embeddings[index] ?? null,
          embeddingModel: model,
          embeddingSpace: space,
        })),
      )
    }
    await tx
      .update(schema.knowledgeSources)
      .set({ status: 'ready', error: null, updatedAt: new Date() })
      .where(eq(schema.knowledgeSources.id, input.sourceId))
  })

  return { chunks: pieces.length }
}

/** Index every entry of a source and record the outcome on the source row. */
export async function indexSource(
  db: Database,
  sourceId: string,
  embedSlot: SlotConfig | null,
  dimensions = EMBEDDING_DIMENSIONS,
): Promise<{ chunks: number; entries: number }> {
  await db
    .update(schema.knowledgeSources)
    .set({ status: 'processing', error: null, updatedAt: new Date() })
    .where(eq(schema.knowledgeSources.id, sourceId))

  try {
    const entries = await db
      .select({ id: schema.knowledgeEntries.id })
      .from(schema.knowledgeEntries)
      .where(eq(schema.knowledgeEntries.sourceId, sourceId))

    let chunks = 0
    for (const entry of entries) {
      const result = await indexEntry(db, entry.id, embedSlot, dimensions)
      chunks += result.chunks
    }

    await db
      .update(schema.knowledgeSources)
      .set({ status: 'ready', error: null, updatedAt: new Date() })
      .where(eq(schema.knowledgeSources.id, sourceId))

    return { chunks, entries: entries.length }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // The knowledge screen shows this, so a Thai PDF that extracts as nonsense reads as a
    // parsing problem rather than a broken AI.
    await db
      .update(schema.knowledgeSources)
      .set({ status: 'failed', error: message, updatedAt: new Date() })
      .where(eq(schema.knowledgeSources.id, sourceId))
    throw error
  }
}

export type CreateEntryInput = {
  workspaceId: string
  sourceId: string
  language: Language
  question: string | null
  body: string
  tags?: string[]
  channelTypes?: string[]
  variantGroup?: string
}

export async function createEntry(db: Database, input: CreateEntryInput): Promise<string> {
  const id = newId()
  await db.insert(schema.knowledgeEntries).values({
    id,
    workspaceId: input.workspaceId,
    sourceId: input.sourceId,
    variantGroup: input.variantGroup ?? id,
    language: input.language,
    question: input.question,
    body: input.body,
    tags: input.tags ?? [],
    channelTypes: input.channelTypes ?? [],
  })
  return id
}

export async function createSource(
  db: Database,
  input: {
    workspaceId: string
    kind: 'qa' | 'article' | 'file' | 'url'
    title: string
    storageKey?: string | null
    mime?: string | null
    byteSize?: number | null
    meta?: Record<string, unknown>
    createdByUserId?: string | null
  },
): Promise<string> {
  const id = newId()
  await db.insert(schema.knowledgeSources).values({
    id,
    workspaceId: input.workspaceId,
    kind: input.kind,
    title: input.title,
    storageKey: input.storageKey ?? null,
    mime: input.mime ?? null,
    byteSize: input.byteSize ?? null,
    meta: input.meta ?? {},
    createdByUserId: input.createdByUserId ?? null,
    status: 'pending',
  })
  return id
}

/**
 * Delete a source, and the file it was uploaded as.
 *
 * The row and the file used to part ways here: the row went and the document stayed in
 * storage for ever. The file's removal is queued with the delete and attempted at once;
 * a failure is retried by the nightly drain.
 */
export async function deleteSource(
  db: Database,
  workspaceId: string,
  sourceId: string,
  blob?: BlobStore,
): Promise<void> {
  const storageKey = await db.transaction(async (tx) => {
    const removed = await tx
      .delete(schema.knowledgeSources)
      .where(
        and(
          eq(schema.knowledgeSources.id, sourceId),
          eq(schema.knowledgeSources.workspaceId, workspaceId),
        ),
      )
      .returning({ storageKey: schema.knowledgeSources.storageKey })
    const key = removed[0]?.storageKey ?? null
    if (key) await queueBlobDeletions(tx, workspaceId, [key], 'knowledge_source')
    return key
  })
  if (storageKey && blob) {
    await drainBlobDeletions(db, blob, { workspaceId, keys: [storageKey] })
  }
}

/**
 * Store a conversation excerpt for semantic recall.
 *
 * The customer id is written onto the row rather than joined at read time, because the
 * retrieval query must be able to scope by customer without a join it could forget.
 */
export async function indexConversationText(
  db: Database,
  input: {
    workspaceId: string
    customerId: string
    conversationId: string
    messageId?: string | null
    text: string
  },
  embedSlot: SlotConfig | null,
  dimensions = EMBEDDING_DIMENSIONS,
): Promise<number> {
  const pieces = chunkText(input.text)
  if (pieces.length === 0 || !embedSlot) return 0

  const embedded = await embedTexts(embedSlot, pieces, dimensions)

  await db.insert(schema.conversationEmbeddings).values(
    pieces.map((text, index) => ({
      id: newId(),
      workspaceId: input.workspaceId,
      customerId: input.customerId,
      conversationId: input.conversationId,
      messageId: input.messageId ?? null,
      text,
      embedding: embedded.embeddings[index] ?? null,
      embeddingModel: embedded.model,
      embeddingSpace: embedded.space,
    })),
  )

  return pieces.length
}
