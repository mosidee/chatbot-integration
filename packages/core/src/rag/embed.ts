import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { embed, embedMany } from 'ai'
import { createCompatibleFetch } from '../ai/compat'
import { attemptSignal, DEFAULT_ATTEMPT_MS } from '../ai/deadline'
import type { FetchLike } from '../ai/http-tool'
import type { SlotConfig, SlotTarget } from '../ai/types'
import { NoSlotConfiguredError } from '../ai/types'

/**
 * Embeddings through the same provider abstraction as chat.
 *
 * The `dimensions` request is what lets one fixed-size column serve both bge-m3, which is
 * natively 1024, and OpenAI's text-embedding-3 models, which honour the parameter. A model
 * that ignores it and returns a different size is rejected loudly rather than silently
 * storing vectors the index cannot compare.
 *
 * Not every gateway accepts the field, though, so the slot can turn it off with
 * `sendDimensions: false` and rely on the model's native size. The size check applies
 * either way, which is what makes turning it off safe to try.
 */

export type EmbedResult = {
  embeddings: number[][]
  model: string
  /**
   * The space these vectors belong to. Stored beside them and matched at query time, so a
   * fallback model, or a slot switched to another model, never has its vectors compared
   * with ones they are not comparable to.
   */
  space: string
  usedFallback: boolean
}

/** Per transport, so a provider built for one client is never handed out for another. */
let cache = new WeakMap<
  FetchLike,
  Map<string, { revision: string; provider: ReturnType<typeof createOpenAICompatible> }>
>()

function providerFor(target: SlotTarget) {
  const key = `${target.provider.id}:${target.provider.baseUrl}`
  let providers = cache.get(target.provider.fetch)
  if (!providers) {
    providers = new Map()
    cache.set(target.provider.fetch, providers)
  }
  const revision = target.provider.revision ?? ''
  const cached = providers.get(key)
  let provider = cached && cached.revision === revision ? cached.provider : undefined
  if (!provider) {
    provider = createOpenAICompatible({
      name: target.provider.name,
      baseURL: target.provider.baseUrl,
      apiKey: target.provider.apiKey ?? undefined,
      headers: target.provider.headers,
      // Repairs gateways that frame a non-streaming answer as an event stream.
      fetch: createCompatibleFetch(target.provider.fetch),
    })
    providers.set(key, { revision, provider })
  }
  return provider
}

export function clearEmbeddingCache(): void {
  cache = new WeakMap()
}

function assertDimensions(
  vectors: number[][],
  expected: number,
  model: string,
  asked: boolean,
): void {
  for (const vector of vectors) {
    if (vector.length !== expected) {
      throw new Error(
        `Embedding model "${model}" returned ${vector.length} dimensions, but the store expects ${expected}. ` +
          (asked
            ? 'Choose a model that supports this size, or change EMBEDDING_DIMENSIONS and re-embed.'
            : 'The dimensions parameter is switched off for this slot, so the model answered at its ' +
              'native size. Switch it back on, choose a model native to this size, or change ' +
              'EMBEDDING_DIMENSIONS and re-embed.'),
      )
    }
  }
}

async function attempt(
  target: SlotTarget,
  values: string[],
  dimensions: number,
  maxRetries: number,
  sendDimensions: boolean,
): Promise<number[][]> {
  const model = providerFor(target).textEmbeddingModel(target.model)
  // Omitted entirely rather than sent as undefined, so the field never reaches the wire.
  const providerOptions = sendDimensions ? { openaiCompatible: { dimensions } } : undefined

  if (values.length === 1) {
    const only = values[0] ?? ''
    const result = await embed({
      model,
      value: only,
      providerOptions,
      maxRetries,
      abortSignal: attemptSignal(DEFAULT_ATTEMPT_MS.embed),
    })
    return [result.embedding]
  }

  const result = await embedMany({
    model,
    values,
    providerOptions,
    maxRetries,
    abortSignal: attemptSignal(DEFAULT_ATTEMPT_MS.embed),
  })
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
    const model = slot.primary?.model ?? ''
    return {
      embeddings: [],
      model,
      space: embeddingSpace(model, slot.params.sendDimensions !== false),
      usedFallback: false,
    }
  }

  const targets: { target: SlotTarget; usedFallback: boolean }[] = []
  if (slot.primary) targets.push({ target: slot.primary, usedFallback: false })
  if (slot.fallback) targets.push({ target: slot.fallback, usedFallback: true })
  if (targets.length === 0) throw new NoSlotConfiguredError(slot.task)

  const maxRetries = options.maxRetries ?? slot.params.maxRetries ?? 1
  const sendDimensions = slot.params.sendDimensions !== false
  let lastError: unknown

  for (const { target, usedFallback } of targets) {
    try {
      const embeddings = await attempt(target, values, dimensions, maxRetries, sendDimensions)
      assertDimensions(embeddings, dimensions, target.model, sendDimensions)
      return {
        embeddings,
        model: target.model,
        space: embeddingSpace(target.model, sendDimensions),
        usedFallback,
      }
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

/**
 * Name the space a model's vectors live in. The model, and whether it was asked for a size:
 * the same model answering natively and answering truncated to a size are different spaces.
 * Not the provider: one model served by two gateways is still one space.
 */
export function embeddingSpace(model: string, sendDimensions: boolean): string {
  return `${model}|${sendDimensions ? 'dims' : 'native'}`
}
