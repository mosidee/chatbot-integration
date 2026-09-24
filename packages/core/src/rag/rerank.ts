import type { SlotConfig, SlotTarget } from '../ai/types'

/**
 * Cross-encoder reranking.
 *
 * Retrieval is optimised for recall: fetch thirty candidates cheaply and accept some noise.
 * A reranker then scores each candidate against the query properly, which is slow per item
 * but applied to only a handful. It is the cheapest large improvement available to a RAG
 * system, and it is optional because it needs a model the OpenAI API does not define.
 *
 * The request shape is the one Cohere, Jina, Text Embeddings Inference and Infinity all
 * expose: POST /rerank with a query and documents, returning indices and relevance scores.
 * Providers that do not implement it simply leave the slot unconfigured.
 */

export type RerankCandidate = {
  id: string
  text: string
}

export type RerankedItem = {
  id: string
  score: number
}

export type RerankResult = {
  items: RerankedItem[]
  model: string
  usedFallback: boolean
}

type RerankResponse = {
  results?: { index: number; relevance_score?: number; score?: number }[]
  data?: { index: number; relevance_score?: number; score?: number }[]
}

async function callRerank(
  target: SlotTarget,
  query: string,
  candidates: RerankCandidate[],
  topN: number,
  signal: AbortSignal,
): Promise<RerankedItem[]> {
  const url = `${target.provider.baseUrl.replace(/\/$/, '')}/rerank`
  const response = await target.provider.fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      ...(target.provider.apiKey ? { authorization: `Bearer ${target.provider.apiKey}` } : {}),
      ...target.provider.headers,
    },
    body: JSON.stringify({
      model: target.model,
      query,
      documents: candidates.map((c) => c.text),
      top_n: topN,
    }),
  })

  if (!response.ok) {
    throw new Error(`Reranker returned ${response.status}`)
  }

  const payload = (await response.json()) as RerankResponse
  const rows = payload.results ?? payload.data ?? []

  return rows.flatMap((row) => {
    const candidate = candidates[row.index]
    if (!candidate) return []
    return [{ id: candidate.id, score: row.relevance_score ?? row.score ?? 0 }]
  })
}

/**
 * Rerank candidates, or return null when it is not configured or not reachable.
 *
 * Null rather than throwing: a reranker is an improvement on an answer that already exists,
 * so its failure must degrade the ordering, never the reply.
 */
export async function rerankCandidates(
  slot: SlotConfig | null,
  query: string,
  candidates: RerankCandidate[],
  options: { topN?: number; timeoutMs?: number } = {},
): Promise<RerankResult | null> {
  if (!slot || candidates.length === 0) return null

  const targets: { target: SlotTarget; usedFallback: boolean }[] = []
  if (slot.primary) targets.push({ target: slot.primary, usedFallback: false })
  if (slot.fallback) targets.push({ target: slot.fallback, usedFallback: true })
  if (targets.length === 0) return null

  const topN = options.topN ?? candidates.length

  for (const { target, usedFallback } of targets) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000)
    try {
      const items = await callRerank(target, query, candidates, topN, controller.signal)
      if (items.length > 0) return { items, model: target.model, usedFallback }
    } catch {
      // Try the fallback, then give up quietly.
    } finally {
      clearTimeout(timer)
    }
  }

  return null
}
