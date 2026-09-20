import { chunkQa, chunkText, embedTexts, type SlotConfig } from '@ci/core'
import { type Database, EMBEDDING_DIMENSIONS, newId, schema } from '@ci/db'
import type { Language } from '@ci/shared'
import { and, eq, inArray } from 'drizzle-orm'

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
  let embeddings: number[][] = []
  let model: string | null = null
  if (embedSlot) {
    const embedded = await embedTexts(embedSlot, pieces, dimensions)
    embeddings = embedded.embeddings
    model = embedded.model
  }

  // Replace atomically, so retrieval never sees an entry mid-rewrite.
  await db.transaction(async (tx) => {
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
      })),
    )
  })

  return { chunks: pieces.length, model, skipped: false }
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

export async function deleteSource(
  db: Database,
  workspaceId: string,
  sourceId: string,
): Promise<void> {
  await db
    .delete(schema.knowledgeSources)
    .where(
      and(
        eq(schema.knowledgeSources.id, sourceId),
        eq(schema.knowledgeSources.workspaceId, workspaceId),
      ),
    )
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
    })),
  )

  return pieces.length
}

/** Remove indexed conversation text, used by the delete-customer job. */
export async function deleteConversationEmbeddings(
  db: Database,
  workspaceId: string,
  customerIds: string[],
): Promise<void> {
  if (customerIds.length === 0) return
  await db
    .delete(schema.conversationEmbeddings)
    .where(
      and(
        eq(schema.conversationEmbeddings.workspaceId, workspaceId),
        inArray(schema.conversationEmbeddings.customerId, customerIds),
      ),
    )
}
