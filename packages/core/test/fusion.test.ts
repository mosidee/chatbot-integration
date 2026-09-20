import { describe, expect, test } from 'bun:test'
import { DEFAULT_FUSION, fuse, type ScoredId } from '../src/rag/fusion'

const dense = (...pairs: [string, number][]): ScoredId[] =>
  pairs.map(([id, score]) => ({ id, score }))

describe('fuse', () => {
  test('returns the dense list when keyword contributes nothing', () => {
    const result = fuse(dense(['a', 0.9], ['b', 0.7]), [])
    expect(result.map((r) => r.id)).toEqual(['a', 'b'])
    expect(result[0]?.keywordRank).toBeNull()
  })

  test('returns the keyword list when dense is unavailable', () => {
    const result = fuse([], dense(['x', 0.8], ['y', 0.4]))
    expect(result.map((r) => r.id)).toEqual(['x', 'y'])
    expect(result[0]?.denseRank).toBeNull()
  })

  test('ranks an item found by both halves above one found by either alone', () => {
    const result = fuse(dense(['both', 0.6], ['denseOnly', 0.9]), dense(['both', 0.5]))
    expect(result[0]?.id).toBe('both')
  })

  test('excludes weak keyword hits before fusing, not after', () => {
    // The keyword half found only noise. It must not take rank 1 from a good dense hit.
    const result = fuse(dense(['good', 0.8]), dense(['noise', 0.05]))
    expect(result.map((r) => r.id)).toEqual(['good'])
  })

  test('excludes weak dense hits below the floor', () => {
    const result = fuse(dense(['weak', 0.1]), dense(['solid', 0.6]))
    expect(result.map((r) => r.id)).toEqual(['solid'])
  })

  test('returns nothing when both halves are below their floors', () => {
    expect(fuse(dense(['a', 0.05]), dense(['b', 0.02]))).toEqual([])
  })

  test("records each half's rank and score for debugging", () => {
    const result = fuse(dense(['a', 0.9]), dense(['a', 0.7]))
    expect(result[0]).toMatchObject({
      id: 'a',
      denseRank: 1,
      keywordRank: 1,
      denseScore: 0.9,
      keywordScore: 0.7,
    })
  })

  test('orders ties deterministically so results do not shuffle', () => {
    const first = fuse(dense(['b', 0.5], ['a', 0.5]), [])
    const second = fuse(dense(['a', 0.5], ['b', 0.5]), [])
    expect(first.map((r) => r.id)).toEqual(second.map((r) => r.id))
  })

  test('weighting changes which half dominates', () => {
    const denseHeavy = fuse(dense(['d', 0.9]), dense(['k', 0.9]), {
      denseWeight: 10,
      keywordWeight: 0.1,
    })
    expect(denseHeavy[0]?.id).toBe('d')

    const keywordHeavy = fuse(dense(['d', 0.9]), dense(['k', 0.9]), {
      denseWeight: 0.1,
      keywordWeight: 10,
    })
    expect(keywordHeavy[0]?.id).toBe('k')
  })

  test('a larger k flattens the influence of rank', () => {
    const sharp = fuse(dense(['a', 0.9], ['b', 0.8]), [], { k: 1 })
    const flat = fuse(dense(['a', 0.9], ['b', 0.8]), [], { k: 1000 })
    const sharpGap = (sharp[0]?.fusedScore ?? 0) - (sharp[1]?.fusedScore ?? 0)
    const flatGap = (flat[0]?.fusedScore ?? 0) - (flat[1]?.fusedScore ?? 0)
    expect(flatGap).toBeLessThan(sharpGap)
  })

  test('the defaults keep a product-code match and drop unrelated noise', () => {
    // Measured trigram scores: an exact code match is 1.0, an unrelated Thai phrase 0.06.
    const result = fuse([], dense(['code', 1.0], ['unrelated', 0.06]), DEFAULT_FUSION)
    expect(result.map((r) => r.id)).toEqual(['code'])
  })
})
