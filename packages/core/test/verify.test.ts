import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { clearModelCache } from '../src/ai/registry'
import type { ProviderProfile, SlotTarget } from '../src/ai/types'
import { verifyChatModel, verifyEmbeddingModel } from '../src/ai/verify'
import { clearEmbeddingCache } from '../src/rag/embed'

/**
 * Calling a model once to find out whether the gateway will serve it.
 *
 * The cases below are the three real refusals seen on one gateway: a model id with no
 * mapping to its upstream, an entitlement the account does not hold, and a credential of
 * the wrong kind. Each has to reach the operator in the provider's own words, because the
 * fix for each is different and none of them is in this codebase.
 */

const target: SlotTarget = {
  provider: {
    id: 'p1',
    name: 'stub',
    baseUrl: 'http://provider.invalid/v1',
    apiKey: 'k',
    headers: {},
    supportsTools: true,
    supportsVision: false,
  } satisfies ProviderProfile,
  model: 'some-model',
}

const realFetch = globalThis.fetch

function stub(handler: () => Response | Promise<Response>): void {
  const impl = async () => handler()
  ;(impl as unknown as { preconnect: () => void }).preconnect = () => {}
  globalThis.fetch = impl as unknown as typeof fetch
}

function chatReply(content: string, outputTokens = 1): Response {
  return Response.json({
    id: 'chatcmpl-1',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: outputTokens, total_tokens: 5 + outputTokens },
  })
}

beforeEach(() => {
  clearModelCache()
  clearEmbeddingCache()
})
afterEach(() => {
  globalThis.fetch = realFetch
  clearModelCache()
  clearEmbeddingCache()
})

describe('verifyChatModel', () => {
  test('reports a model that answers', async () => {
    stub(() => chatReply('ok', 2))
    const result = await verifyChatModel(target)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.detail).toContain('2 output tokens')
  })

  test('counts an empty answer as working', async () => {
    // A reasoning model can spend its whole budget before emitting a word. The question
    // asked is whether the id is served, not whether the model was talkative.
    stub(() =>
      Response.json({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        choices: [
          { index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'length' },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 256, total_tokens: 261 },
      }),
    )

    expect((await verifyChatModel(target)).ok).toBe(true)
  })

  test('passes on an unmapped model id in the upstream words', async () => {
    stub(() =>
      Response.json(
        {
          error: {
            message:
              'The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-v4.1-flash.',
            type: 'invalid_request_error',
          },
        },
        { status: 400 },
      ),
    )

    const result = await verifyChatModel(target)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('deepseek-v4.1-flash')
  })

  test('passes on an entitlement refusal', async () => {
    stub(() =>
      Response.json(
        {
          error: {
            message:
              "team not allowed to access model. This team can only access models=['qwen3.8-27b-fp8'].",
            type: 'team_model_access_denied',
          },
        },
        { status: 403 },
      ),
    )

    const result = await verifyChatModel(target)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('qwen3.8-27b-fp8')
  })

  test('survives a refusal that carries no message', async () => {
    stub(() => new Response('', { status: 500 }))

    const result = await verifyChatModel(target)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0)
  })
})

describe('verifyEmbeddingModel', () => {
  const embeddingReply = (size: number) =>
    Response.json({
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: Array.from({ length: size }, () => 0.1) }],
      model: 'embed',
      usage: { prompt_tokens: 3, total_tokens: 3 },
    })

  test('reports the size the model returned', async () => {
    stub(() => embeddingReply(1024))
    const result = await verifyEmbeddingModel(target, 1024, true)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.detail).toContain('1024 dimensions')
  })

  test('fails when the size does not match the store', async () => {
    // Exactly the trap of switching the dimensions field off with a model whose native size
    // is larger: the call succeeds and the vectors are useless.
    stub(() => embeddingReply(3072))
    const result = await verifyEmbeddingModel(target, 1024, false)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('3072')
  })

  test('reports a provider that serves no embeddings', async () => {
    stub(() =>
      Response.json(
        { error: { message: "Provider 'deepseek' does not support embeddings." } },
        { status: 400 },
      ),
    )

    const result = await verifyEmbeddingModel(target, 1024, true)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('does not support embeddings')
  })
})
