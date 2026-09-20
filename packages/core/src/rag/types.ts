import type { ChannelType, Language } from '@ci/shared'
import type { RetrievedChunk } from '../ai/types'

export type RetrieveOptions = {
  workspaceId: string
  query: string
  /** Prefer entries in this language; others are still eligible. */
  language?: Language | null
  /** Restrict to entries allowed on this channel. */
  channelType?: ChannelType | null
  /** How many chunks to return after fusion. */
  limit?: number
  /** How many candidates each half fetches before fusion. */
  candidates?: number
  /** Drop fused results below this score. */
  minFusedScore?: number
}

export type ScoredChunk = RetrievedChunk & {
  denseScore: number | null
  keywordScore: number | null
}

/**
 * The three lists are returned separately on purpose.
 *
 * When retrieval regresses, the question is always "did the dense half miss it, or did the
 * keyword half drown it?" A single fused list cannot answer that, so tests and the
 * knowledge screen's test-search box both read the halves.
 */
export type RetrieveResult = {
  chunks: ScoredChunk[]
  dense: ScoredChunk[]
  keyword: ScoredChunk[]
  usedRerank: boolean
  /** Null when no embedding provider is configured, which makes it keyword-only. */
  embeddingModel: string | null
}

/**
 * Retrieval as a port.
 *
 * The Postgres implementation lives in packages/infra. An operator who already runs Dify or
 * RAGFlow can point a workspace at it instead, and nothing upstream changes.
 */
export type Retriever = {
  retrieve(options: RetrieveOptions): Promise<RetrieveResult>
}

export const EMPTY_RETRIEVAL: RetrieveResult = {
  chunks: [],
  dense: [],
  keyword: [],
  usedRerank: false,
  embeddingModel: null,
}
