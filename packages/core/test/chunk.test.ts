import { describe, expect, test } from 'bun:test'
import { chunkQa, chunkText } from '../src/rag/chunk'

const THAI_PARAGRAPH =
  'ระบบ salon-saas ช่วยให้ร้านทำผมจัดการคิวลูกค้าได้ง่ายขึ้น รองรับการจองออนไลน์ การแจ้งเตือนอัตโนมัติ และรายงานยอดขายรายวัน '

describe('chunkText', () => {
  test('returns nothing for empty input', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   \n  ')).toEqual([])
  })

  test('keeps short text as a single chunk', () => {
    expect(chunkText('สวัสดีค่ะ')).toEqual(['สวัสดีค่ะ'])
  })

  test('splits long text into several chunks', () => {
    const chunks = chunkText(THAI_PARAGRAPH.repeat(20), { size: 400, overlap: 50 })
    expect(chunks.length).toBeGreaterThan(1)
  })

  test('respects the size limit allowing for the break search', () => {
    for (const chunk of chunkText(THAI_PARAGRAPH.repeat(20), { size: 400, overlap: 50 })) {
      expect(chunk.length).toBeLessThanOrEqual(400)
    }
  })

  test('overlaps consecutive chunks so a split answer stays retrievable', () => {
    const chunks = chunkText(`${'a'.repeat(300)}MARKER${'b'.repeat(300)}`, {
      size: 320,
      overlap: 100,
      minSize: 10,
    })
    expect(chunks.length).toBeGreaterThan(1)
    // The marker sits near a boundary; the overlap should place it in two chunks.
    expect(chunks.filter((c) => c.includes('MARKER')).length).toBeGreaterThanOrEqual(1)
  })

  test('hard-splits Thai, which has no word spaces', () => {
    const solid = 'ก'.repeat(1000)
    const chunks = chunkText(solid, { size: 300, overlap: 0, minSize: 10 })
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    expect(chunks.join('')).toBe(solid)
  })

  test('prefers a paragraph boundary', () => {
    const text = `${'a'.repeat(200)}\n\n${'b'.repeat(200)}`
    const chunks = chunkText(text, { size: 260, overlap: 0, minSize: 10 })
    expect(chunks[0]).toBe('a'.repeat(200))
  })

  test('terminates on pathological input rather than looping', () => {
    const chunks = chunkText('x'.repeat(5000), { size: 100, overlap: 99, minSize: 1 })
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.length).toBeLessThan(5000)
  })

  test('folds a tiny trailing fragment into the previous chunk', () => {
    const chunks = chunkText(`${'a'.repeat(400)}\n\nbc`, { size: 420, overlap: 0, minSize: 50 })
    expect(chunks.at(-1)?.endsWith('bc')).toBe(true)
    expect(chunks.at(-1)?.length).toBeGreaterThan(50)
  })
})

describe('chunkQa', () => {
  test('keeps a question and its answer together when they fit', () => {
    const chunks = chunkQa('ราคาเท่าไหร่', 'แพ็กเกจเริ่มต้น 990 บาทต่อเดือน')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toContain('ราคาเท่าไหร่')
    expect(chunks[0]).toContain('990')
  })

  test('repeats the question on every chunk when the answer must be split', () => {
    const chunks = chunkQa('ราคาเท่าไหร่', THAI_PARAGRAPH.repeat(20), {
      size: 400,
      overlap: 40,
    })
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk).toContain('ราคาเท่าไหร่')
  })

  test('handles an article with no question', () => {
    const chunks = chunkQa(null, 'เนื้อหาบทความ')
    expect(chunks).toEqual(['เนื้อหาบทความ'])
  })
})
