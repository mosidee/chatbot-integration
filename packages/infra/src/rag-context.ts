import type { FetchLike, RetrievedChunk, SlotConfig } from '@ci/core'
import type { Database } from '@ci/db'
import type { ChannelType, Language } from '@ci/shared'
import { createPostgresRetriever, searchPastConversations } from './retrieval'
import { createExternalRetriever, type ExternalRetrievalConfig } from './retrieval-external'

export type StoredExternalRetrieval = {
  kind: 'dify' | 'ragflow' | 'generic'
  baseUrl: string
  apiKeyEncrypted: string | null
  datasetId: string | null
  topK?: number
  scoreThreshold?: number
}

/**
 * Turn the stored config into a usable one, decrypting the key at the moment of use so a
 * plaintext credential never sits in a row, a log line or a response.
 */
export async function resolveExternalRetrieval(
  stored: StoredExternalRetrieval | null | undefined,
  secretKey: string,
  fetch: FetchLike,
): Promise<ExternalRetrievalConfig | null> {
  if (!stored) return null
  const { decryptSecret } = await import('@ci/db')
  return {
    kind: stored.kind,
    baseUrl: stored.baseUrl,
    apiKey: stored.apiKeyEncrypted ? await decryptSecret(stored.apiKeyEncrypted, secretKey) : null,
    datasetId: stored.datasetId,
    fetch,
    ...(stored.topK !== undefined ? { topK: stored.topK } : {}),
    ...(stored.scoreThreshold !== undefined ? { scoreThreshold: stored.scoreThreshold } : {}),
  }
}

/**
 * The retrieval a single AI turn is allowed to do.
 *
 * Built per turn and bound to one workspace, one customer and one conversation, so the
 * tools handed to the model cannot widen their own scope. The model chooses what to search
 * for; it does not choose whose data to search.
 */

export type TurnRetrieval = {
  /** Knowledge fetched up front for the customer's newest message. */
  prefetch: (query: string) => Promise<RetrievedChunk[]>
  searchKnowledge: (query: string) => Promise<RetrievedChunk[]>
  searchPastConversations: (
    query: string,
  ) => Promise<{ conversationId: string; text: string; at: Date }[]>
  enabled: { knowledge: boolean; pastConversations: boolean }
}

export function createTurnRetrieval(
  db: Database,
  input: {
    workspaceId: string
    customerId: string
    conversationId: string
    language: Language | null
    channelType: ChannelType | null
    embedSlot: SlotConfig | null
    rerankSlot?: SlotConfig | null
    hasKnowledge: boolean
    /** When set, knowledge comes from that platform instead of our Postgres. */
    externalRetrieval?: ExternalRetrievalConfig | null
    /**
     * The oldest message the model is already shown. Recall skips this conversation only
     * from here on, so an earlier episode of a permanent conversation can be recalled.
     */
    activeWindowStart?: Date | null
  },
): TurnRetrieval {
  const retriever = input.externalRetrieval
    ? createExternalRetriever(input.externalRetrieval)
    : createPostgresRetriever(db, {
        embedSlot: input.embedSlot,
        rerankSlot: input.rerankSlot ?? null,
      })

  const search = async (query: string, limit: number): Promise<RetrievedChunk[]> => {
    const result = await retriever.retrieve({
      workspaceId: input.workspaceId,
      query,
      language: input.language,
      channelType: input.channelType,
      limit,
    })
    return result.chunks
  }

  return {
    prefetch: (query) => search(query, 5),
    searchKnowledge: (query) => search(query, 5),
    searchPastConversations: async (query) => {
      const hits = await searchPastConversations(
        db,
        {
          workspaceId: input.workspaceId,
          // Bound here, not passed by the model.
          customerId: input.customerId,
          query,
          excludeConversationId: input.conversationId,
          excludeSince: input.activeWindowStart ?? null,
          limit: 5,
        },
        input.embedSlot,
      )
      return hits.map((h) => ({ conversationId: h.conversationId, text: h.text, at: h.createdAt }))
    },
    enabled: {
      // An external platform has its own corpus, so the local chunk count says nothing.
      knowledge: input.externalRetrieval ? true : input.hasKnowledge,
      // Recall needs embeddings; without a provider there is nothing to compare.
      pastConversations: input.embedSlot !== null,
    },
  }
}

/** True when the workspace has any indexed knowledge at all. */
export async function workspaceHasKnowledge(db: Database, workspaceId: string): Promise<boolean> {
  const { sql } = await import('drizzle-orm')
  const result = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM knowledge_chunks WHERE workspace_id = ${workspaceId} LIMIT 1
    ) AS exists
  `)
  return Boolean([...result][0]?.exists)
}
