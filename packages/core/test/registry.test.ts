import { describe, expect, test } from 'bun:test'
import { resolveModel, runWithFallback } from '../src/ai/registry'
import { NoSlotConfiguredError, type ProviderProfile, type SlotConfig } from '../src/ai/types'

function provider(id: string): ProviderProfile {
  return {
    id,
    name: id,
    baseUrl: `http://localhost/${id}`,
    apiKey: 'k',
    headers: {},
    supportsTools: true,
    supportsVision: false,
    fetch: (input, init) => globalThis.fetch(input, init),
  }
}

function slot(overrides: Partial<SlotConfig> = {}): SlotConfig {
  return {
    task: 'agent_chat',
    primary: { provider: provider('primary'), model: 'm1' },
    fallback: { provider: provider('secondary'), model: 'm2' },
    params: {},
    ...overrides,
  }
}

describe('runWithFallback', () => {
  test('uses the primary target when it succeeds', async () => {
    const attempt = await runWithFallback(slot(), async (target) => target.provider.id)
    expect(attempt.result).toBe('primary')
    expect(attempt.usedFallback).toBe(false)
  })

  test('falls back when the primary throws', async () => {
    const attempt = await runWithFallback(slot(), async (target) => {
      if (target.provider.id === 'primary') throw new Error('503 upstream down')
      return target.provider.id
    })
    expect(attempt.result).toBe('secondary')
    expect(attempt.usedFallback).toBe(true)
  })

  test('propagates the last error when every target fails', async () => {
    await expect(
      runWithFallback(slot(), async (target) => {
        throw new Error(`${target.provider.id} failed`)
      }),
    ).rejects.toThrow('secondary failed')
  })

  test('throws when no target is configured', async () => {
    await expect(
      runWithFallback(slot({ primary: null, fallback: null }), async () => 'x'),
    ).rejects.toThrow(NoSlotConfiguredError)
  })

  test('works with only a fallback configured', async () => {
    const attempt = await runWithFallback(slot({ primary: null }), async (t) => t.provider.id)
    expect(attempt.result).toBe('secondary')
    expect(attempt.usedFallback).toBe(true)
  })
})

/** Recommendation #17: a rotated key must not keep using the client built from the old one. */
describe('resolveModel', () => {
  test('rebuilds the client when the provider changes, and not otherwise', () => {
    const base = provider('rotating')
    const first = resolveModel({ provider: { ...base, revision: '1' }, model: 'm' })
    const same = resolveModel({ provider: { ...base, revision: '1' }, model: 'm' })
    const rotated = resolveModel({
      provider: { ...base, apiKey: 'new-key', revision: '2' },
      model: 'm',
    })
    expect(same).toBe(first)
    expect(rotated).not.toBe(first)
  })
})
