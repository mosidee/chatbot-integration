import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { createCompatibleFetch } from './compat'
import { NoSlotConfiguredError, type SlotConfig, type SlotTarget } from './types'

/**
 * Builds model instances from provider profiles.
 *
 * Every provider is treated as OpenAI-compatible, which is what lets an operator point a
 * slot at OpenAI, OpenRouter, a self-hosted router or a local server without code changes.
 */

const cache = new Map<string, LanguageModel>()

function cacheKey(target: SlotTarget): string {
  return `${target.provider.id}:${target.provider.baseUrl}:${target.model}`
}

export function resolveModel(target: SlotTarget): LanguageModel {
  const key = cacheKey(target)
  const existing = cache.get(key)
  if (existing) return existing

  const provider = createOpenAICompatible({
    name: target.provider.name,
    baseURL: target.provider.baseUrl,
    apiKey: target.provider.apiKey ?? undefined,
    headers: target.provider.headers,
    // Repairs gateways that frame a non-streaming answer as an event stream.
    fetch: createCompatibleFetch(),
  })

  const model = provider.chatModel(target.model)
  cache.set(key, model)
  return model
}

/** Test helper: drop memoised model instances. */
export function clearModelCache(): void {
  cache.clear()
}

export type FallbackAttempt<T> = {
  result: T
  target: SlotTarget
  usedFallback: boolean
}

/**
 * Run `execute` against the slot's primary target, falling back to the secondary one if
 * the primary throws. A provider outage should degrade the answer, not silence the bot.
 */
export async function runWithFallback<T>(
  slot: SlotConfig,
  execute: (target: SlotTarget, model: LanguageModel) => Promise<T>,
): Promise<FallbackAttempt<T>> {
  const targets: { target: SlotTarget; usedFallback: boolean }[] = []
  if (slot.primary) targets.push({ target: slot.primary, usedFallback: false })
  if (slot.fallback) targets.push({ target: slot.fallback, usedFallback: true })

  if (targets.length === 0) throw new NoSlotConfiguredError(slot.task)

  let lastError: unknown
  for (const { target, usedFallback } of targets) {
    try {
      const result = await execute(target, resolveModel(target))
      return { result, target, usedFallback }
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`All providers failed for the "${slot.task}" slot`)
}
