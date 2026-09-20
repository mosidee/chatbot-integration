import { afterEach, describe, expect, test } from 'bun:test'
import { createExternalRetriever } from '../src/retrieval-external'

/**
 * The external retrieval adapters, against servers shaped like the real platforms.
 */

type Stub = { url: string; requests: unknown[]; stop: () => void }
const stubs: Stub[] = []

afterEach(() => {
  for (const s of stubs.splice(0)) s.stop()
})

function serve(handler: (body: unknown) => Response): Stub {
  const requests: unknown[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json().catch(() => ({}))
      requests.push(body)
      return handler(body)
    },
  })
  const stub = { url: `http://localhost:${server.port}`, requests, stop: () => server.stop(true) }
  stubs.push(stub)
  return stub
}

describe('Dify adapter', () => {
  test('maps records into scored chunks', async () => {
    const stub = serve(() =>
      Response.json({
        records: [
          {
            segment: { id: 'seg-1', content: 'ราคา 990 บาท', document: { name: 'Pricing' } },
            score: 0.82,
          },
        ],
      }),
    )

    const retriever = createExternalRetriever({
      kind: 'dify',
      baseUrl: stub.url,
      apiKey: 'k',
      datasetId: 'ds-1',
    })
    const result = await retriever.retrieve({ workspaceId: 'ws', query: 'ราคา' })

    expect(result.chunks).toHaveLength(1)
    expect(result.chunks[0]?.text).toBe('ราคา 990 บาท')
    expect(result.chunks[0]?.sourceTitle).toBe('Pricing')
    expect(result.chunks[0]?.score).toBeCloseTo(0.82, 5)
    expect(result.embeddingModel).toBe('external:dify')
  })

  test('sends the query and a retrieval model block', async () => {
    const stub = serve(() => Response.json({ records: [] }))
    const retriever = createExternalRetriever({
      kind: 'dify',
      baseUrl: stub.url,
      apiKey: 'k',
      datasetId: 'ds-1',
    })
    await retriever.retrieve({ workspaceId: 'ws', query: 'how much' })

    const body = stub.requests[0] as { query: string; retrieval_model: { top_k: number } }
    expect(body.query).toBe('how much')
    expect(body.retrieval_model.top_k).toBeGreaterThan(0)
  })
})

describe('RAGFlow adapter', () => {
  test('maps chunks and prefers the weighted content', async () => {
    const stub = serve(() =>
      Response.json({
        data: {
          chunks: [
            {
              id: 'c1',
              content: 'plain',
              content_with_weight: 'weighted answer',
              document_keyword: 'Manual',
              similarity: 0.7,
            },
          ],
        },
      }),
    )

    const retriever = createExternalRetriever({
      kind: 'ragflow',
      baseUrl: stub.url,
      apiKey: null,
      datasetId: 'kb-1',
    })
    const result = await retriever.retrieve({ workspaceId: 'ws', query: 'anything' })

    expect(result.chunks[0]?.text).toBe('weighted answer')
    expect(result.chunks[0]?.sourceTitle).toBe('Manual')
  })
})

describe('generic adapter', () => {
  test('maps a simple scored list', async () => {
    const stub = serve(() =>
      Response.json({
        results: [{ id: 'x', title: 'Docs', text: 'Some answer', score: 0.5 }],
      }),
    )
    const retriever = createExternalRetriever({
      kind: 'generic',
      baseUrl: stub.url,
      apiKey: null,
      datasetId: null,
    })
    const result = await retriever.retrieve({ workspaceId: 'ws', query: 'q' })
    expect(result.chunks[0]).toMatchObject({ text: 'Some answer', sourceTitle: 'Docs' })
  })

  test('skips entries with no text rather than emitting empty chunks', async () => {
    const stub = serve(() => Response.json({ results: [{ id: 'x', score: 1 }] }))
    const retriever = createExternalRetriever({
      kind: 'generic',
      baseUrl: stub.url,
      apiKey: null,
      datasetId: null,
    })
    expect((await retriever.retrieve({ workspaceId: 'ws', query: 'q' })).chunks).toHaveLength(0)
  })
})

describe('failure handling', () => {
  test('an error response yields no knowledge rather than throwing', async () => {
    const stub = serve(() => new Response('nope', { status: 500 }))
    const retriever = createExternalRetriever({
      kind: 'generic',
      baseUrl: stub.url,
      apiKey: null,
      datasetId: null,
    })
    const result = await retriever.retrieve({ workspaceId: 'ws', query: 'q' })
    expect(result.chunks).toHaveLength(0)
    expect(result.embeddingModel).toBeNull()
  })

  test('an unreachable platform yields no knowledge rather than throwing', async () => {
    const retriever = createExternalRetriever({
      kind: 'generic',
      // Nothing listens here.
      baseUrl: 'http://localhost:1',
      apiKey: null,
      datasetId: null,
      timeoutMs: 500,
    })
    const result = await retriever.retrieve({ workspaceId: 'ws', query: 'q' })
    expect(result.chunks).toHaveLength(0)
  })

  test('an empty query never reaches the platform', async () => {
    const stub = serve(() => Response.json({ results: [] }))
    const retriever = createExternalRetriever({
      kind: 'generic',
      baseUrl: stub.url,
      apiKey: null,
      datasetId: null,
    })
    await retriever.retrieve({ workspaceId: 'ws', query: '   ' })
    expect(stub.requests).toHaveLength(0)
  })
})
