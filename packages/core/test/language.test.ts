import { describe, expect, test } from 'bun:test'
import { detectLanguage } from '../src/ai/language'

describe('detecting the language to write a holding message in', () => {
  test('Thai script is Thai', () => {
    expect(detectLanguage('สวัสดีครับ อยากทราบราคาแพ็กเกจ')).toBe('th')
  })

  test('a run of Latin letters is English', () => {
    expect(detectLanguage('how much does the starter plan cost')).toBe('en')
  })

  test('one Thai character among Latin is still Thai', () => {
    // A salon owner writing Thai quotes the product's English name constantly. The script
    // they are actually writing in is the one that decides.
    expect(detectLanguage('Growth ขึ้นไป ราคาเท่าไหร่')).toBe('th')
  })

  test('a short Latin token is not evidence of English', () => {
    // "ok" from a Thai speaker is not a request to switch languages.
    expect(detectLanguage('ok')).toBeNull()
  })

  test('nothing to read means no opinion', () => {
    expect(detectLanguage('')).toBeNull()
    expect(detectLanguage(null)).toBeNull()
    expect(detectLanguage(undefined)).toBeNull()
  })

  test('a photograph, an order number or an emoji carries no language', () => {
    expect(detectLanguage('0812345678')).toBeNull()
    expect(detectLanguage('👍')).toBeNull()
  })
})
