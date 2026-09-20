import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { embed, embedMany } from 'ai'
import { createCompatibleFetch } from '../ai/compat'
import type { SlotConfig, SlotTarget } from '../ai/types'
import { NoSlotConfiguredError } from '../ai/types'

/**
 * Embeddings through the same provider abstraction as chat.
 *
 * The `dimensions` request is what lets one fixed-size column serve both bge-m3, which is
 * natively 1024, and OpenAI's text-embedding-3 models, which honour the parameter. A model
 * that ignores it and returns a different size is rejected loudly rather than silently
 * storing vectors the index cannot compare.
 */

export type EmbedResult = {
  embeddings: number[][]
  model: string
  usedFallback: boolean
}

const cache = new Map<string, ReturnType<typeof createOpenAICompatible>>()

function providerFor(target: SlotTarget) {
  const key = `${target.provider.id}:${target.provider.baseUrl}`
  let provider = cache.get(key)
  if (!provider) {
    provider = createOpenAICompatible({
      name: target.provider.name,
      baseURL: target.provider.baseUrl,
      apiKey: target.provider.apiKey ?? undefined,
      headers: target.provider.headers,
      // Repairs gateways that frame a non-streaming answer as an event stream.
      fetch: createCompatibleFetch(),
    })
    cache.set(key, provider)
  }
  return provider
}

export function clearEmbeddingCache(): void {
  cache.clear()
}

function assertDimensions(vectors: number[][], expected: number, model: string): void {
  for (const vector of vectors) {
    if (vector.length !== expected) {
      throw new Error(
        `Embedding model "${model}" returned ${vector.length} dimensions, but the store expects ${expected}. ` +
          'Choose a model that supports this size, or change EMBEDDING_DIMENSIONS and re-embed.',
      )
    }
  }
}

async function attempt(
  target: SlotTarget,
  values: string[],
  dimensions: number,
  maxRetries: number,
): Promise<number[][]> {
  const model = providerFor(target).textEmbeddingModel(target.model)
  const providerOptions = { openaiCompatible: { dimensions } }

  if (values.length === 1) {
    const only = values[0] ?? ''
    const result = await embed({ model, value: only, providerOptions, maxRetries })
    return [result.embedding]
  }

  const result = await embedMany({ model, values, providerOptions, maxRetries })
  return result.embeddings
}

/** Embed one or more texts, falling back to the slot's secondary provider on failure. */
export async function embedTexts(
  slot: SlotConfig,
  values: string[],
  dimensions: number,
  options: { maxRetries?: number } = {},
): Promise<EmbedResult> {
  if (values.length === 0) {
    return { embeddings: [], model: slot.primary?.model ?? '', usedFallback: false }
  }

  const targets: { target: SlotTarget; usedFallback: boolean }[] = []
  if (slot.primary) targets.push({ target: slot.primary, usedFallback: false })
  if (slot.fallback) targets.push({ target: slot.fallback, usedFallback: true })
  if (targets.length === 0) throw new NoSlotConfiguredError(slot.task)

  const maxRetries = options.maxRetries ?? slot.params.maxRetries ?? 1
  let lastError: unknown

  for (const { target, usedFallback } of targets) {
    try {
      const embeddings = await attempt(target, values, dimensions, maxRetries)
      assertDimensions(embeddings, dimensions, target.model)
      return { embeddings, model: target.model, usedFallback }
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`All providers failed for the "${slot.task}" slot`)
}

/** Cosine similarity, for ranking vectors already in memory. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    normA += x * x
    normB += y * y
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  return denominator === 0 ? 0 : dot / denominator
}
