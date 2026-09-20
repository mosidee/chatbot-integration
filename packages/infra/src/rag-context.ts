import type { RetrievedChunk, SlotConfig } from '@ci/core'
import type { Database } from '@ci/db'
import type { ChannelType, Language } from '@ci/shared'
import { createPostgresRetriever, searchPastConversations } from './retrieval'

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
    hasKnowledge: boolean
  },
): TurnRetrieval {
  const retriever = createPostgresRetriever(db, { embedSlot: input.embedSlot })

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
          limit: 5,
        },
        input.embedSlot,
      )
      return hits.map((h) => ({ conversationId: h.conversationId, text: h.text, at: h.createdAt }))
    },
    enabled: {
      knowledge: input.hasKnowledge,
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
