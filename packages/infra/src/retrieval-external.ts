import type { FetchLike, RetrieveOptions, RetrieveResult, Retriever, ScoredChunk } from '@ci/core'

/**
 * Retrieval from an existing knowledge platform.
 *
 * Some operators already run Dify or RAGFlow and have spent real effort curating a corpus
 * there. Because retrieval is a port, such a workspace can point at that system instead of
 * ours and everything upstream is unchanged: the agent still gets scored chunks, the trace
 * still records them, and the suggestion panel still cites them.
 *
 * Three shapes are supported. Dify and RAGFlow are named because they are the two engines
 * worth integrating with today; `generic` covers anything that can return a list of scored
 * texts, which is a small adapter for an operator to write on their own side.
 */

export type ExternalRetrievalConfig = {
  kind: 'dify' | 'ragflow' | 'generic'
  baseUrl: string
  apiKey: string | null
  /** Dataset, knowledge base or index identifier, as that platform names it. */
  datasetId: string | null
  topK?: number
  scoreThreshold?: number
  timeoutMs?: number
  /** The tenant typed `baseUrl`, so this is `Runtime.providerFetch`, never the plain fetch. */
  fetch: FetchLike
}

type NormalisedHit = {
  id: string
  title: string
  text: string
  score: number
}

function headers(config: ExternalRetrievalConfig): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
  }
}

async function queryDify(
  config: ExternalRetrievalConfig,
  query: string,
  topK: number,
  signal: AbortSignal,
): Promise<NormalisedHit[]> {
  const url = `${config.baseUrl.replace(/\/$/, '')}/datasets/${config.datasetId}/retrieve`
  const response = await config.fetch(url, {
    method: 'POST',
    signal,
    headers: headers(config),
    body: JSON.stringify({
      query,
      retrieval_model: {
        search_method: 'hybrid_search',
        reranking_enable: true,
        top_k: topK,
        score_threshold_enabled: config.scoreThreshold !== undefined,
        score_threshold: config.scoreThreshold ?? 0,
      },
    }),
  })
  if (!response.ok) throw new Error(`Dify returned ${response.status}`)

  const payload = (await response.json()) as {
    records?: {
      segment?: { id?: string; content?: string; document?: { name?: string } }
      score?: number
    }[]
  }

  return (payload.records ?? []).flatMap((record, index) => {
    const content = record.segment?.content
    if (!content) return []
    return [
      {
        id: record.segment?.id ?? `dify-${index}`,
        title: record.segment?.document?.name ?? 'Dify',
        text: content,
        score: record.score ?? 0,
      },
    ]
  })
}

async function queryRagflow(
  config: ExternalRetrievalConfig,
  query: string,
  topK: number,
  signal: AbortSignal,
): Promise<NormalisedHit[]> {
  const url = `${config.baseUrl.replace(/\/$/, '')}/api/v1/retrieval`
  const response = await config.fetch(url, {
    method: 'POST',
    signal,
    headers: headers(config),
    body: JSON.stringify({
      question: query,
      dataset_ids: config.datasetId ? [config.datasetId] : [],
      top_k: topK,
      similarity_threshold: config.scoreThreshold ?? 0.2,
    }),
  })
  if (!response.ok) throw new Error(`RAGFlow returned ${response.status}`)

  const payload = (await response.json()) as {
    data?: {
      chunks?: {
        id?: string
        content?: string
        content_with_weight?: string
        document_keyword?: string
        similarity?: number
      }[]
    }
  }

  return (payload.data?.chunks ?? []).flatMap((chunk, index) => {
    const content = chunk.content_with_weight ?? chunk.content
    if (!content) return []
    return [
      {
        id: chunk.id ?? `ragflow-${index}`,
        title: chunk.document_keyword ?? 'RAGFlow',
        text: content,
        score: chunk.similarity ?? 0,
      },
    ]
  })
}

async function queryGeneric(
  config: ExternalRetrievalConfig,
  query: string,
  topK: number,
  signal: AbortSignal,
): Promise<NormalisedHit[]> {
  const response = await config.fetch(config.baseUrl, {
    method: 'POST',
    signal,
    headers: headers(config),
    body: JSON.stringify({ query, top_k: topK }),
  })
  if (!response.ok) throw new Error(`Retrieval endpoint returned ${response.status}`)

  const payload = (await response.json()) as {
    results?: { id?: string; title?: string; text?: string; score?: number }[]
  }

  return (payload.results ?? []).flatMap((hit, index) => {
    if (!hit.text) return []
    return [
      {
        id: hit.id ?? `external-${index}`,
        title: hit.title ?? 'External',
        text: hit.text,
        score: hit.score ?? 0,
      },
    ]
  })
}

export function createExternalRetriever(config: ExternalRetrievalConfig): Retriever {
  return {
    async retrieve(input: RetrieveOptions): Promise<RetrieveResult> {
      const query = input.query.trim()
      if (query.length === 0) {
        return { chunks: [], dense: [], keyword: [], usedRerank: false, embeddingModel: null }
      }

      const topK = input.limit ?? config.topK ?? 6
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 8000)

      try {
        const hits =
          config.kind === 'dify'
            ? await queryDify(config, query, topK, controller.signal)
            : config.kind === 'ragflow'
              ? await queryRagflow(config, query, topK, controller.signal)
              : await queryGeneric(config, query, topK, controller.signal)

        const chunks: ScoredChunk[] = hits.map((hit) => ({
          id: hit.id,
          sourceId: hit.id,
          sourceTitle: hit.title,
          text: hit.text,
          score: hit.score,
          language: null,
          // The external engine does its own fusion, so the halves are not separable here.
          denseScore: hit.score,
          keywordScore: null,
        }))

        return {
          chunks,
          dense: chunks,
          keyword: [],
          usedRerank: false,
          embeddingModel: `external:${config.kind}`,
        }
      } catch {
        // An unreachable knowledge platform must not fail the customer's turn; the AI then
        // answers without knowledge, and its prompt tells it to hand off rather than guess.
        return { chunks: [], dense: [], keyword: [], usedRerank: false, embeddingModel: null }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
