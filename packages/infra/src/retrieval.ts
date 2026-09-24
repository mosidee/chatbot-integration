import {
  DEFAULT_FUSION,
  EMPTY_RETRIEVAL,
  embedTexts,
  type FusionOptions,
  fuse,
  type RetrieveOptions,
  type RetrieveResult,
  type Retriever,
  rerankCandidates,
  type ScoredChunk,
  type SlotConfig,
} from '@ci/core'
import { type Database, EMBEDDING_DIMENSIONS, schema } from '@ci/db'
import { sql } from 'drizzle-orm'

/**
 * Hybrid retrieval over Postgres.
 *
 * Two halves run independently and are then fused:
 *
 *  - **Dense**: cosine distance over pgvector, for meaning. Finds an answer phrased nothing
 *    like the question.
 *  - **Keyword**: `word_similarity` over a GIN trigram index, for literal matches. This is
 *    what finds a product code, an order reference or a Thai term the embedding glosses
 *    over. `word_similarity` rather than plain `similarity`, because the latter compares
 *    whole strings and a short query against a long chunk always scores near zero. ADR 0003
 *    records the measurements.
 *
 * Both halves are capped by a floor before fusion, so a half that found only noise
 * contributes nothing rather than its least-bad member.
 */

export type PostgresRetrieverOptions = {
  /** Null when no embedding provider is configured; retrieval is then keyword-only. */
  embedSlot: SlotConfig | null
  /** Optional cross-encoder that reorders the fused candidates. */
  rerankSlot?: SlotConfig | null
  fusion?: Partial<FusionOptions>
  dimensions?: number
}

type ChunkRow = {
  id: string
  source_id: string
  entry_id: string | null
  text: string
  language: string | null
  title: string
  score: number
}

const DEFAULT_LIMIT = 6
const DEFAULT_CANDIDATES = 30

export function createPostgresRetriever(
  db: Database,
  options: PostgresRetrieverOptions,
): Retriever {
  const dimensions = options.dimensions ?? EMBEDDING_DIMENSIONS

  return {
    async retrieve(input: RetrieveOptions): Promise<RetrieveResult> {
      const query = input.query.trim()
      if (query.length === 0) return EMPTY_RETRIEVAL

      const limit = input.limit ?? DEFAULT_LIMIT
      const candidates = input.candidates ?? DEFAULT_CANDIDATES

      // Restrictions applied identically to both halves, so one cannot leak what the other
      // filters out.
      const restrict = sql`
        AND e.enabled = true
        AND (${input.channelType ?? null}::text IS NULL
             OR cardinality(e.channel_types) = 0
             OR ${input.channelType ?? null}::text = ANY(e.channel_types))
      `

      const [{ rows: dense, model: embeddingModel }, keyword] = await Promise.all([
        denseSearch(db, input.workspaceId, query, candidates, restrict, options, dimensions),
        keywordSearch(db, input.workspaceId, query, candidates, restrict),
      ])

      const fused = fuse(
        dense.map((r) => ({ id: r.id, score: r.score })),
        keyword.map((r) => ({ id: r.id, score: r.score })),
        { ...DEFAULT_FUSION, ...options.fusion },
      )

      const byId = new Map<string, ChunkRow>()
      for (const row of [...dense, ...keyword]) byId.set(row.id, row)

      const toChunk = (
        row: ChunkRow,
        denseScore: number | null,
        keywordScore: number | null,
      ): ScoredChunk => ({
        id: row.id,
        sourceId: row.source_id,
        sourceTitle: row.title,
        text: row.text,
        score: denseScore ?? keywordScore ?? 0,
        language: (row.language as ScoredChunk['language']) ?? null,
        denseScore,
        keywordScore,
      })

      const minFused = input.minFusedScore ?? 0
      const survivors = fused.filter((f) => f.fusedScore >= minFused)

      // Rerank a few more than are needed, so the cross-encoder can promote something the
      // cheap fusion ranked just below the cut.
      const forRerank = survivors.slice(0, Math.max(limit * 3, limit))
      const reranked = await rerankCandidates(
        options.rerankSlot ?? null,
        query,
        forRerank.flatMap((f) => {
          const row = byId.get(f.id)
          return row ? [{ id: f.id, text: row.text }] : []
        }),
        { topN: limit },
      )

      let ordered = survivors
      if (reranked) {
        const promoted = reranked.items.flatMap((item) => {
          const fusedEntry = forRerank.find((f) => f.id === item.id)
          return fusedEntry ? [{ ...fusedEntry, fusedScore: item.score }] : []
        })
        // Some rerankers return only what clears their own threshold. Anything they left
        // out keeps its fused position behind what they promoted, so reranking can reorder
        // results but never returns fewer than the query would have without it.
        const promotedIds = new Set(promoted.map((p) => p.id))
        ordered = [...promoted, ...survivors.filter((s) => !promotedIds.has(s.id))]
      }

      const chunks = ordered.slice(0, limit).flatMap((f) => {
        const row = byId.get(f.id)
        if (!row) return []
        const chunk = toChunk(row, f.denseScore, f.keywordScore)
        // Report the ranking score as the headline number; the halves stay visible.
        return [{ ...chunk, score: f.fusedScore }]
      })

      return {
        chunks,
        dense: dense.map((r) => toChunk(r, r.score, null)),
        keyword: keyword.map((r) => toChunk(r, null, r.score)),
        usedRerank: reranked !== null,
        embeddingModel,
      }
    },
  }
}

async function denseSearch(
  db: Database,
  workspaceId: string,
  query: string,
  candidates: number,
  restrict: ReturnType<typeof sql>,
  options: PostgresRetrieverOptions,
  dimensions: number,
): Promise<{ rows: ChunkRow[]; model: string | null }> {
  if (!options.embedSlot) return { rows: [], model: null }

  let vector: number[] | undefined
  let space: string
  let model: string
  try {
    const embedded = await embedTexts(options.embedSlot, [query], dimensions)
    vector = embedded.embeddings[0]
    space = embedded.space
    model = embedded.model
  } catch {
    // A dead embedding provider degrades retrieval to keyword-only rather than failing the
    // customer's turn.
    return { rows: [], model: null }
  }
  if (!vector) return { rows: [], model }

  const literal = `[${vector.join(',')}]`

  const result = await db.execute<ChunkRow>(sql`
    SELECT c.id, c.source_id, c.entry_id, c.text, c.language, s.title,
           1 - (c.embedding <=> ${literal}::vector) AS score
    FROM knowledge_chunks c
    JOIN knowledge_sources s ON s.id = c.source_id
    LEFT JOIN knowledge_entries e ON e.id = c.entry_id
    WHERE c.workspace_id = ${workspaceId}
      AND c.embedding IS NOT NULL
      -- Only vectors from the query's own space are comparable with it. A fallback model
      -- answering the query, or a slot switched to another model before a reindex, finds
      -- nothing here and retrieval leans on keywords, rather than ranking by noise.
      AND c.embedding_space = ${space}
      AND (e.id IS NULL OR (true ${restrict}))
    ORDER BY c.embedding <=> ${literal}::vector
    LIMIT ${candidates}
  `)

  return { rows: [...result].map((row) => ({ ...row, score: Number(row.score) })), model }
}

async function keywordSearch(
  db: Database,
  workspaceId: string,
  query: string,
  candidates: number,
  restrict: ReturnType<typeof sql>,
): Promise<ChunkRow[]> {
  const result = await db.execute<ChunkRow>(sql`
    SELECT c.id, c.source_id, c.entry_id, c.text, c.language, s.title,
           word_similarity(${query}, c.text) AS score
    FROM knowledge_chunks c
    JOIN knowledge_sources s ON s.id = c.source_id
    LEFT JOIN knowledge_entries e ON e.id = c.entry_id
    WHERE c.workspace_id = ${workspaceId}
      AND ${query} <% c.text
      AND (e.id IS NULL OR (true ${restrict}))
    ORDER BY score DESC
    LIMIT ${candidates}
  `)

  return [...result].map((row) => ({ ...row, score: Number(row.score) }))
}

export type PastConversationHit = {
  conversationId: string
  messageId: string | null
  text: string
  score: number
  createdAt: Date
}

/**
 * Semantic recall over **one customer's** past conversations.
 *
 * `customerId` is required and always in the WHERE clause. This function runs inside an
 * agent turn, and scoping only by workspace would let one customer's history surface in
 * another customer's conversation. That is the leak the product refuses to accept, so the
 * signature makes it impossible to call without a customer.
 */
export async function searchPastConversations(
  db: Database,
  input: {
    workspaceId: string
    customerId: string
    query: string
    limit?: number
    excludeConversationId?: string | null
    /** Excluded only from here on; earlier parts of that conversation stay recallable. */
    excludeSince?: Date | null
  },
  embedSlot: SlotConfig | null,
  dimensions = EMBEDDING_DIMENSIONS,
): Promise<PastConversationHit[]> {
  const query = input.query.trim()
  if (query.length === 0 || !embedSlot) return []

  let vector: number[] | undefined
  let space: string
  try {
    const embedded = await embedTexts(embedSlot, [query], dimensions)
    vector = embedded.embeddings[0]
    space = embedded.space
  } catch {
    return []
  }
  if (!vector) return []

  const literal = `[${vector.join(',')}]`
  const exclude = input.excludeConversationId ?? null
  const since = input.excludeSince ? input.excludeSince.toISOString() : null

  const result = await db.execute<{
    conversation_id: string
    message_id: string | null
    text: string
    score: number
    created_at: string
  }>(sql`
    SELECT conversation_id, message_id, text,
           1 - (embedding <=> ${literal}::vector) AS score,
           created_at
    FROM conversation_embeddings
    WHERE workspace_id = ${input.workspaceId}
      AND customer_id = ${input.customerId}
      AND embedding IS NOT NULL
      AND embedding_space = ${space}
      -- The conversation in progress is excluded only from where its visible window begins:
      -- a conversation is permanent, and what it said in earlier episodes is exactly what
      -- recall is for. Without a start, the whole conversation is excluded as before.
      AND (${exclude}::text IS NULL
           OR conversation_id <> ${exclude}::text
           OR (${since}::timestamptz IS NOT NULL AND created_at < ${since}::timestamptz))
    ORDER BY embedding <=> ${literal}::vector
    LIMIT ${input.limit ?? 5}
  `)

  return [...result].map((row) => ({
    conversationId: row.conversation_id,
    messageId: row.message_id,
    text: row.text,
    score: Number(row.score),
    createdAt: new Date(row.created_at),
  }))
}

export { schema }
