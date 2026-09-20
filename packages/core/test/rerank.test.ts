import { afterEach, describe, expect, test } from 'bun:test'
import type { ProviderProfile, SlotConfig } from '../src/ai/types'
import { rerankCandidates } from '../src/rag/rerank'

type Stub = { url: string; requests: unknown[]; stop: () => void }
const stubs: Stub[] = []

afterEach(() => {
  for (const s of stubs.splice(0)) s.stop()
})

function serve(handler: () => Response): Stub {
  const requests: unknown[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push(await request.json().catch(() => ({})))
      return handler()
    },
  })
  const stub = { url: `http://localhost:${server.port}`, requests, stop: () => server.stop(true) }
  stubs.push(stub)
  return stub
}

function provider(baseUrl: string, id = 'r1'): ProviderProfile {
  return {
    id,
    name: id,
    baseUrl,
    apiKey: 'k',
    headers: {},
    supportsTools: false,
    supportsVision: false,
  }
}

function slot(baseUrl: string, fallbackUrl?: string): SlotConfig {
  return {
    task: 'rerank',
    primary: { provider: provider(baseUrl), model: 'rerank-model' },
    fallback: fallbackUrl ? { provider: provider(fallbackUrl, 'r2'), model: 'rerank-model' } : null,
    params: {},
  }
}

const CANDIDATES = [
  { id: 'a', text: 'Refunds take seven days.' },
  { id: 'b', text: 'The starter plan costs 990 THB.' },
  { id: 'c', text: 'Opening hours are 9 to 6.' },
]

describe('rerankCandidates', () => {
  test('reorders candidates by the scores the reranker returns', async () => {
    const stub = serve(() =>
      Response.json({
        results: [
          { index: 1, relevance_score: 0.95 },
          { index: 0, relevance_score: 0.2 },
        ],
      }),
    )

    const result = await rerankCandidates(slot(stub.url), 'how much does it cost', CANDIDATES)
    expect(result?.items.map((i) => i.id)).toEqual(['b', 'a'])
    expect(result?.items[0]?.score).toBeCloseTo(0.95, 5)
    expect(result?.model).toBe('rerank-model')
  })

  test('sends the query and documents in the standard shape', async () => {
    const stub = serve(() => Response.json({ results: [] }))
    await rerankCandidates(slot(stub.url), 'a question', CANDIDATES, { topN: 2 })

    const body = stub.requests[0] as { query: string; documents: string[]; top_n: number }
    expect(body.query).toBe('a question')
    expect(body.documents).toHaveLength(3)
    expect(body.top_n).toBe(2)
  })

  test('accepts the `data` and `score` field names some providers use', async () => {
    const stub = serve(() => Response.json({ data: [{ index: 2, score: 0.4 }] }))
    const result = await rerankCandidates(slot(stub.url), 'q', CANDIDATES)
    expect(result?.items.map((i) => i.id)).toEqual(['c'])
  })

  test('falls back to the secondary reranker', async () => {
    const down = serve(() => new Response('nope', { status: 503 }))
    const up = serve(() => Response.json({ results: [{ index: 0, relevance_score: 0.9 }] }))

    const result = await rerankCandidates(slot(down.url, up.url), 'q', CANDIDATES)
    expect(result?.usedFallback).toBe(true)
    expect(result?.items.map((i) => i.id)).toEqual(['a'])
  })

  test('returns null when nothing is configured, leaving the order untouched', async () => {
    expect(await rerankCandidates(null, 'q', CANDIDATES)).toBeNull()
  })

  test('returns null rather than throwing when the reranker fails', async () => {
    const down = serve(() => new Response('nope', { status: 500 }))
    expect(await rerankCandidates(slot(down.url), 'q', CANDIDATES)).toBeNull()
  })

  test('returns null when the reranker is unreachable', async () => {
    const unreachable = slot('http://localhost:1')
    expect(await rerankCandidates(unreachable, 'q', CANDIDATES, { timeoutMs: 400 })).toBeNull()
  })

  test('ignores an index the reranker invented', async () => {
    const stub = serve(() =>
      Response.json({
        results: [
          { index: 99, relevance_score: 1 },
          { index: 0, relevance_score: 0.5 },
        ],
      }),
    )
    const result = await rerankCandidates(slot(stub.url), 'q', CANDIDATES)
    expect(result?.items.map((i) => i.id)).toEqual(['a'])
  })

  test('does nothing for an empty candidate list', async () => {
    const stub = serve(() => Response.json({ results: [] }))
    expect(await rerankCandidates(slot(stub.url), 'q', [])).toBeNull()
    expect(stub.requests).toHaveLength(0)
  })
})
