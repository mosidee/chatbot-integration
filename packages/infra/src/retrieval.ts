import {
  DEFAULT_FUSION,
  EMPTY_RETRIEVAL,
  embedTexts,
  type FusionOptions,
  fuse,
  type RetrieveOptions,
  type RetrieveResult,
  type Retriever,
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

      const [dense, keyword, embeddingModel] = await Promise.all([
        denseSearch(db, input.workspaceId, query, candidates, restrict, options, dimensions),
        keywordSearch(db, input.workspaceId, query, candidates, restrict),
        Promise.resolve(options.embedSlot?.primary?.model ?? null),
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
      const chunks = fused
        .filter((f) => f.fusedScore >= minFused)
        .slice(0, limit)
        .flatMap((f) => {
          const row = byId.get(f.id)
          if (!row) return []
          const chunk = toChunk(row, f.denseScore, f.keywordScore)
          // Report the fused score as the headline number; the halves stay visible.
          return [{ ...chunk, score: f.fusedScore }]
        })

      return {
        chunks,
        dense: dense.map((r) => toChunk(r, r.score, null)),
        keyword: keyword.map((r) => toChunk(r, null, r.score)),
        usedRerank: false,
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
): Promise<ChunkRow[]> {
  if (!options.embedSlot) return []

  let vector: number[] | undefined
  try {
    const embedded = await embedTexts(options.embedSlot, [query], dimensions)
    vector = embedded.embeddings[0]
  } catch {
    // A dead embedding provider degrades retrieval to keyword-only rather than failing the
    // customer's turn.
    return []
  }
  if (!vector) return []

  const literal = `[${vector.join(',')}]`

  const result = await db.execute<ChunkRow>(sql`
    SELECT c.id, c.source_id, c.entry_id, c.text, c.language, s.title,
           1 - (c.embedding <=> ${literal}::vector) AS score
    FROM knowledge_chunks c
    JOIN knowledge_sources s ON s.id = c.source_id
    LEFT JOIN knowledge_entries e ON e.id = c.entry_id
    WHERE c.workspace_id = ${workspaceId}
      AND c.embedding IS NOT NULL
      AND (e.id IS NULL OR (true ${restrict}))
    ORDER BY c.embedding <=> ${literal}::vector
    LIMIT ${candidates}
  `)

  return [...result].map((row) => ({ ...row, score: Number(row.score) }))
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
  },
  embedSlot: SlotConfig | null,
  dimensions = EMBEDDING_DIMENSIONS,
): Promise<PastConversationHit[]> {
  const query = input.query.trim()
  if (query.length === 0 || !embedSlot) return []

  let vector: number[] | undefined
  try {
    const embedded = await embedTexts(embedSlot, [query], dimensions)
    vector = embedded.embeddings[0]
  } catch {
    return []
  }
  if (!vector) return []

  const literal = `[${vector.join(',')}]`
  const exclude = input.excludeConversationId ?? null

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
      AND (${exclude}::text IS NULL OR conversation_id <> ${exclude}::text)
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
