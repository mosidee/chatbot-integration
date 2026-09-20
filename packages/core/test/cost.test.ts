import { describe, expect, test } from 'bun:test'
import { estimateCost } from '../src/ai/cost'

const prices = {
  'openai:gpt-x': { inputPerMillion: 2.5, outputPerMillion: 10 },
  'bare-model': { inputPerMillion: 1, outputPerMillion: 2 },
}

describe('estimateCost', () => {
  test('prices a call keyed by provider and model', () => {
    expect(estimateCost(prices, 'openai', 'gpt-x', 1_000_000, 100_000)).toBe(3.5)
  })

  test('falls back to a model-only key', () => {
    expect(estimateCost(prices, 'anything', 'bare-model', 1_000_000, 1_000_000)).toBe(3)
  })

  test('returns null for an unpriced model rather than guessing', () => {
    expect(estimateCost(prices, 'openai', 'unknown', 1000, 1000)).toBeNull()
  })

  test('returns null when no model was used', () => {
    expect(estimateCost(prices, 'openai', null, 1000, 1000)).toBeNull()
  })

  test('treats missing token counts as zero', () => {
    expect(estimateCost(prices, 'openai', 'gpt-x', null, null)).toBe(0)
  })
})
