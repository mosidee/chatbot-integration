import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { ProviderProfile, SlotConfig } from '../src/ai/types'
import { clearEmbeddingCache, embedTexts } from '../src/rag/embed'

/**
 * What actually goes on the wire to an embedding provider.
 *
 * The `dimensions` field is the whole reason one fixed-size column can serve several
 * models, and the reason a gateway that rejects the field breaks indexing outright. Both
 * are asserted here against the real request body rather than a mock of our own wrapper.
 */

const DIMENSIONS = 8

function profile(): ProviderProfile {
  return {
    id: 'p1',
    name: 'stub',
    baseUrl: 'http://provider.invalid/v1',
    apiKey: 'k',
    headers: {},
    supportsTools: true,
    supportsVision: false,
    fetch: (input, init) => globalThis.fetch(input, init),
  }
}

function slot(params: SlotConfig['params'] = {}): SlotConfig {
  return {
    task: 'embed',
    primary: { provider: profile(), model: 'embed-model' },
    fallback: null,
    params,
  }
}

const realFetch = globalThis.fetch
let bodies: Record<string, unknown>[] = []

/** Answers like an OpenAI-compatible embeddings endpoint, recording what it was sent. */
function stubEmbeddings(size: number): void {
  bodies = []
  const stub = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const sent = JSON.parse(String(init?.body ?? '{}')) as { input?: string | string[] }
    bodies.push(sent as Record<string, unknown>)
    const count = Array.isArray(sent.input) ? sent.input.length : 1
    return Response.json({
      object: 'list',
      data: Array.from({ length: count }, (_, index) => ({
        object: 'embedding',
        index,
        embedding: Array.from({ length: size }, () => 0.1),
      })),
      model: 'embed-model',
      usage: { prompt_tokens: 1, total_tokens: 1 },
    })
  }
  ;(stub as unknown as { preconnect: () => void }).preconnect = () => {}
  globalThis.fetch = stub as unknown as typeof fetch
}

beforeEach(() => clearEmbeddingCache())
afterEach(() => {
  globalThis.fetch = realFetch
  clearEmbeddingCache()
})

describe('embedTexts', () => {
  test('asks for a specific vector size by default', async () => {
    stubEmbeddings(DIMENSIONS)
    const result = await embedTexts(slot(), ['สวัสดีค่ะ'], DIMENSIONS)

    expect(result.embeddings).toHaveLength(1)
    expect(bodies[0]?.dimensions).toBe(DIMENSIONS)
  })

  test('omits the field entirely when the slot switches it off', async () => {
    stubEmbeddings(DIMENSIONS)
    await embedTexts(slot({ sendDimensions: false }), ['สวัสดีค่ะ'], DIMENSIONS)

    // Absent, not sent as null or undefined: a gateway that rejects the field must not see
    // it at all.
    expect(bodies[0]).not.toHaveProperty('dimensions')
  })

  test('still sends the field when the slot switches it on explicitly', async () => {
    stubEmbeddings(DIMENSIONS)
    await embedTexts(slot({ sendDimensions: true }), ['hi'], DIMENSIONS)

    expect(bodies[0]?.dimensions).toBe(DIMENSIONS)
  })

  test('omits the field on a batch too', async () => {
    stubEmbeddings(DIMENSIONS)
    const result = await embedTexts(slot({ sendDimensions: false }), ['หนึ่ง', 'สอง'], DIMENSIONS)

    expect(result.embeddings).toHaveLength(2)
    expect(bodies[0]).not.toHaveProperty('dimensions')
  })

  test('rejects a vector of the wrong size, and says the field is switched off', async () => {
    stubEmbeddings(DIMENSIONS * 2)
    const failure = embedTexts(slot({ sendDimensions: false }), ['hi'], DIMENSIONS)

    await expect(failure).rejects.toThrow(/switched off/)
  })

  test('rejects a vector of the wrong size when the field was sent', async () => {
    stubEmbeddings(DIMENSIONS * 2)
    const failure = embedTexts(slot(), ['hi'], DIMENSIONS)

    await expect(failure).rejects.toThrow(/expects 8/)
  })

  test('embedding nothing calls no provider at all', async () => {
    stubEmbeddings(DIMENSIONS)
    const result = await embedTexts(slot(), [], DIMENSIONS)

    expect(result.embeddings).toEqual([])
    expect(bodies).toHaveLength(0)
  })
})
