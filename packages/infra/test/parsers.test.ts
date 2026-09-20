import { describe, expect, test } from 'bun:test'
import {
  findParser,
  looksReadable,
  parseDocument,
  UnreadableDocumentError,
  UnsupportedDocumentError,
} from '../src/parsers'

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

/** A minimal but valid PDF with one line of extractable text. */
const SAMPLE_PDF = encode(
  `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 74>>stream
BT /F1 24 Tf 72 700 Td (Salon SaaS pricing starts at 990 THB) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
`,
)

describe('parser selection', () => {
  test('matches by media type', () => {
    expect(findParser('application/pdf', 'x')?.name).toBe('pdf')
    expect(findParser('text/csv', 'x')?.name).toBe('csv')
    expect(findParser('text/markdown', 'x')?.name).toBe('text')
  })

  test('falls back to the file extension', () => {
    expect(findParser('', 'manual.pdf')?.name).toBe('pdf')
    expect(findParser('application/octet-stream', 'prices.xlsx')?.name).toBe('xlsx')
    expect(findParser('', 'notes.md')?.name).toBe('text')
  })

  test('returns nothing for a format with no parser', () => {
    expect(findParser('image/png', 'photo.png')).toBeNull()
  })
})

describe('looksReadable', () => {
  test('accepts ordinary Thai and English text', () => {
    expect(looksReadable('แพ็กเกจเริ่มต้นราคา 990 บาทต่อเดือน รวมการจองคิว').ok).toBe(true)
    expect(looksReadable('The starter plan costs 990 THB per month.').ok).toBe(true)
  })

  test('rejects a near-empty extraction, which is what a scan produces', () => {
    const result = looksReadable('  \n \f ')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('OCR')
  })

  test('rejects text that is mostly not letters or digits', () => {
    const result = looksReadable('!@#$%^&*()_+{}|:"<>?[];\',./~`!@#$%^&*()_+{}|:"<>?')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('mis-decoded')
  })

  test('rejects text full of replacement characters', () => {
    const result = looksReadable(`${'�'.repeat(10)}some readable words here to pad it out`)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('encoding')
  })
})

describe('parseDocument', () => {
  test('extracts text from a PDF', async () => {
    const parsed = await parseDocument(SAMPLE_PDF, 'application/pdf', 'pricing.pdf')
    expect(parsed.text).toContain('990 THB')
    expect(parsed.pages).toBe(1)
  })

  test('reads plain text and Markdown', async () => {
    const parsed = await parseDocument(
      encode('# หัวข้อ\n\nเนื้อหาเกี่ยวกับการจองคิวออนไลน์สำหรับร้านทำผม'),
      'text/markdown',
      'guide.md',
    )
    expect(parsed.text).toContain('การจองคิว')
  })

  test('flattens a CSV into tab-separated lines', async () => {
    const parsed = await parseDocument(
      encode('plan,price,currency\nstarter,990,THB\npro,1990,THB'),
      'text/csv',
      'plans.csv',
    )
    expect(parsed.text).toContain('starter\t990\tTHB')
    expect(parsed.text).toContain('pro\t1990\tTHB')
  })

  test('refuses a format it has no parser for', async () => {
    await expect(parseDocument(encode('x'), 'image/png', 'photo.png')).rejects.toThrow(
      UnsupportedDocumentError,
    )
  })

  test('refuses a file that extracts as nothing, naming the likely cause', async () => {
    await expect(parseDocument(encode('  '), 'text/plain', 'empty.txt')).rejects.toThrow(
      UnreadableDocumentError,
    )
    await expect(parseDocument(encode('  '), 'text/plain', 'empty.txt')).rejects.toThrow(/OCR/)
  })

  test('refuses a corrupt PDF with a readable explanation', async () => {
    await expect(
      parseDocument(encode('%PDF-1.4 this is not really a pdf'), 'application/pdf', 'broken.pdf'),
    ).rejects.toThrow(UnreadableDocumentError)
  })
})
