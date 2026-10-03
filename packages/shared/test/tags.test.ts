import { describe, expect, test } from 'bun:test'
import { MAX_TAG_LENGTH, normaliseTag, normaliseTags, tagSchema } from '../src/tags'

describe('normaliseTag', () => {
  test('one spelling per tag', () => {
    expect(normaliseTag('  Billing ')).toBe('billing')
    expect(normaliseTag('Late   Payment')).toBe('late payment')
    expect(normaliseTag('a,b')).toBe('a b')
    expect(normaliseTag('ราคา  แพ็กเกจ')).toBe('ราคา แพ็กเกจ')
  })

  test('nothing left is no tag', () => {
    expect(normaliseTag('   ')).toBeNull()
    expect(normaliseTag(',,')).toBeNull()
  })

  test('cut to the length limit without a trailing space', () => {
    const tag = normaliseTag(`${'a'.repeat(MAX_TAG_LENGTH - 1)} b`)
    expect(tag).toBe('a'.repeat(MAX_TAG_LENGTH - 1))
  })

  test('normalising twice changes nothing', () => {
    for (const raw of ['  X  y ', 'ABC', 'ทดสอบ', `${'Q'.repeat(60)}`]) {
      const once = normaliseTag(raw)
      expect(once && normaliseTag(once)).toBe(once)
    }
  })
})

test('normaliseTags de-duplicates after normalising and keeps order', () => {
  expect(normaliseTags(['VIP', 'billing', 'vip ', '', 'Billing'])).toEqual(['vip', 'billing'])
})

test('tagSchema refuses an empty tag', () => {
  expect(tagSchema.safeParse(' , ').success).toBe(false)
  expect(tagSchema.parse(' Refund ')).toBe('refund')
})
