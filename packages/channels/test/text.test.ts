import { describe, expect, test } from 'bun:test'
import { splitText } from '../src/text'

describe('splitText', () => {
  test('returns a short message unchanged', () => {
    expect(splitText('hello', 100)).toEqual(['hello'])
  })

  test('returns nothing for empty or whitespace input', () => {
    expect(splitText('', 100)).toEqual([])
    expect(splitText('   \n  ', 100)).toEqual([])
  })

  test('splits on a paragraph boundary when there is one', () => {
    const text = `${'a'.repeat(60)}\n\n${'b'.repeat(60)}`
    const parts = splitText(text, 100)
    expect(parts).toHaveLength(2)
    expect(parts[0]).toBe('a'.repeat(60))
    expect(parts[1]).toBe('b'.repeat(60))
  })

  test('splits on a sentence boundary', () => {
    const text = `${'a'.repeat(60)}. ${'b'.repeat(50)}`
    const parts = splitText(text, 100)
    expect(parts[0]?.endsWith('.')).toBe(true)
  })

  test('splits on a word boundary', () => {
    const text = `${'word '.repeat(30)}`.trim()
    for (const part of splitText(text, 50)) expect(part.length).toBeLessThanOrEqual(50)
  })

  test('hard-splits Thai text, which has no word spaces', () => {
    const thai = 'ก'.repeat(250)
    const parts = splitText(thai, 100)
    expect(parts).toHaveLength(3)
    expect(parts.join('')).toBe(thai)
  })

  test('never exceeds the limit', () => {
    const text = `${'x'.repeat(37)} `.repeat(40)
    for (const part of splitText(text, 64)) expect(part.length).toBeLessThanOrEqual(64)
  })

  test('preserves all content across chunks', () => {
    const text = `${'alpha beta gamma '.repeat(40)}`.trim()
    const joined = splitText(text, 80).join(' ').replace(/\s+/g, ' ')
    expect(joined).toBe(text.replace(/\s+/g, ' '))
  })

  test('handles a single word longer than the limit', () => {
    const parts = splitText('z'.repeat(300), 100)
    expect(parts).toHaveLength(3)
    expect(parts.every((p) => p.length <= 100)).toBe(true)
  })
})
