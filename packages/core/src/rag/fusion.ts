/**
 * Reciprocal rank fusion of the dense and keyword result lists.
 *
 * The failure this guards against is silent: when the keyword list returns only weak
 * matches, plain RRF still promotes its best one to rank 1 and it outranks a genuinely
 * relevant dense hit. Each list therefore has a floor applied *before* fusion, so a bad
 * list contributes nothing rather than contributing its least-bad member.
 */

export type ScoredId = {
  id: string
  /** The raw score from that retriever: cosine similarity, or trigram word similarity. */
  score: number
}

export type FusionOptions = {
  /** RRF constant. Larger values flatten the influence of rank. */
  k: number
  /** Minimum cosine similarity for a dense hit to be fused at all. */
  denseFloor: number
  /** Minimum trigram word similarity for a keyword hit to be fused at all. */
  keywordFloor: number
  /** Relative influence of each list. */
  denseWeight: number
  keywordWeight: number
}

export const DEFAULT_FUSION: FusionOptions = {
  k: 60,
  // Cosine similarity below this is noise for multilingual models in practice.
  denseFloor: 0.25,
  // Measured against Thai and English samples; see ADR 0003.
  keywordFloor: 0.15,
  denseWeight: 1,
  keywordWeight: 0.8,
}

export type FusedId = {
  id: string
  fusedScore: number
  denseRank: number | null
  keywordRank: number | null
  denseScore: number | null
  keywordScore: number | null
}

export function fuse(
  dense: ScoredId[],
  keyword: ScoredId[],
  options: Partial<FusionOptions> = {},
): FusedId[] {
  const opts = { ...DEFAULT_FUSION, ...options }

  // Ties break by id inside each list too, not only after fusion. Otherwise the same two
  // results arriving in a different order from Postgres would get different ranks and the
  // fused output would shuffle between identical queries.
  const byScoreThenId = (a: ScoredId, b: ScoredId) =>
    b.score !== a.score ? b.score - a.score : a.id.localeCompare(b.id)

  const denseKept = [...dense].filter((d) => d.score >= opts.denseFloor).sort(byScoreThenId)
  const keywordKept = [...keyword].filter((k) => k.score >= opts.keywordFloor).sort(byScoreThenId)

  const merged = new Map<string, FusedId>()

  const add = (list: ScoredId[], weight: number, field: 'dense' | 'keyword') => {
    list.forEach((item, index) => {
      const rank = index + 1
      const contribution = weight / (opts.k + rank)
      const existing = merged.get(item.id)
      if (existing) {
        existing.fusedScore += contribution
        if (field === 'dense') {
          existing.denseRank = rank
          existing.denseScore = item.score
        } else {
          existing.keywordRank = rank
          existing.keywordScore = item.score
        }
        return
      }
      merged.set(item.id, {
        id: item.id,
        fusedScore: contribution,
        denseRank: field === 'dense' ? rank : null,
        keywordRank: field === 'keyword' ? rank : null,
        denseScore: field === 'dense' ? item.score : null,
        keywordScore: field === 'keyword' ? item.score : null,
      })
    })
  }

  add(denseKept, opts.denseWeight, 'dense')
  add(keywordKept, opts.keywordWeight, 'keyword')

  return [...merged.values()].sort((a, b) => {
    if (b.fusedScore !== a.fusedScore) return b.fusedScore - a.fusedScore
    // Deterministic order when scores tie, so results do not shuffle between calls.
    return a.id.localeCompare(b.id)
  })
}
