import { describe, expect, test } from 'bun:test'
import type { NormalizedMessage } from '@ci/shared'
import {
  DEFAULT_REDACTION,
  isLuhnValid,
  isThaiNationalId,
  redactMessage,
  redactText,
} from '../src/redaction/redact'

// 1234567890121 satisfies the Thai national ID checksum.
const THAI_ID = '1234567890121'
// Classic Luhn-valid test card numbers.
const VISA = '4242424242424242'
const VISA_SPACED = '4242 4242 4242 4242'
const VISA_DASHED = '4242-4242-4242-4242'

describe('checksum helpers', () => {
  test('recognises Luhn-valid card numbers', () => {
    expect(isLuhnValid(VISA)).toBe(true)
    expect(isLuhnValid('4111111111111111')).toBe(true)
  })

  test('rejects a card-length number that fails Luhn', () => {
    expect(isLuhnValid('1111222233334445')).toBe(false)
  })

  test('rejects numbers outside card length', () => {
    expect(isLuhnValid('42424242424')).toBe(false)
    expect(isLuhnValid('42424242424242424242')).toBe(false)
  })

  test('recognises a valid Thai national ID', () => {
    expect(isThaiNationalId(THAI_ID)).toBe(true)
  })

  test('rejects a Thai ID with a bad check digit', () => {
    expect(isThaiNationalId('1234567890123')).toBe(false)
  })

  test('rejects wrong-length Thai IDs', () => {
    expect(isThaiNationalId('123456789012')).toBe(false)
  })
})

describe('redactText', () => {
  test('masks a card number and keeps the last four digits', () => {
    const result = redactText(`my card is ${VISA} ok`)
    expect(result.text).toBe('my card is [card ••••4242] ok')
    expect(result.findings).toEqual([{ type: 'card_number', count: 1 }])
  })

  test('masks card numbers written with spaces or dashes', () => {
    expect(redactText(VISA_SPACED).text).toBe('[card ••••4242]')
    expect(redactText(VISA_DASHED).text).toBe('[card ••••4242]')
  })

  test('masks a Thai national ID', () => {
    const result = redactText(`เลขบัตร ${THAI_ID} ครับ`)
    expect(result.text).toBe('เลขบัตร [thai id ••••0121] ครับ')
    expect(result.findings).toEqual([{ type: 'thai_national_id', count: 1 }])
  })

  test('leaves Thai phone numbers alone', () => {
    const text = 'โทร 0812345678 นะคะ'
    expect(redactText(text).text).toBe(text)
    expect(redactText(text).findings).toEqual([])
  })

  test('leaves order references alone even at card length', () => {
    const text = 'order 1111222233334445 please check'
    expect(redactText(text).text).toBe(text)
    expect(redactText(text).findings).toEqual([])
  })

  test('counts multiple occurrences', () => {
    const result = redactText(`${VISA} and ${VISA_SPACED}`)
    expect(result.findings).toEqual([{ type: 'card_number', count: 2 }])
  })

  test('reports both types when both are present', () => {
    const result = redactText(`${THAI_ID} / ${VISA}`)
    expect(result.findings).toContainEqual({ type: 'thai_national_id', count: 1 })
    expect(result.findings).toContainEqual({ type: 'card_number', count: 1 })
  })

  test('honours disabled options', () => {
    const off = { cardNumbers: false, thaiNationalId: false }
    expect(redactText(VISA, off).text).toBe(VISA)
    expect(redactText(THAI_ID, off).text).toBe(THAI_ID)
  })

  test('never leaks the original digits', () => {
    const result = redactText(`card ${VISA} id ${THAI_ID}`, DEFAULT_REDACTION)
    expect(result.text).not.toContain(VISA)
    expect(result.text).not.toContain(THAI_ID)
  })

  test('leaves ordinary text untouched', () => {
    const text = 'ราคาเท่าไหร่คะ how much is the pro plan?'
    expect(redactText(text).text).toBe(text)
  })
})

describe('redactMessage', () => {
  test('redacts a text message', () => {
    const { message, findings } = redactMessage({ kind: 'text', text: `pay with ${VISA}` })
    expect(message).toEqual({ kind: 'text', text: 'pay with [card ••••4242]' })
    expect(findings).toEqual([{ type: 'card_number', count: 1 }])
  })

  test('redacts media captions and file names', () => {
    const { message } = redactMessage({
      kind: 'image',
      text: `slip for ${VISA}`,
      attachments: [
        {
          storageKey: null,
          sourceUrl: null,
          mime: 'image/png',
          sizeBytes: null,
          fileName: `${THAI_ID}.png`,
          width: null,
          height: null,
          durationMs: null,
        },
      ],
    })
    if (message.kind !== 'image') throw new Error('kind changed')
    expect(message.text).toBe('slip for [card ••••4242]')
    expect(message.attachments[0]?.fileName).toBe('[thai id ••••0121].png')
  })

  test('passes stickers and events through unchanged', () => {
    const sticker: NormalizedMessage = {
      kind: 'sticker',
      packageId: '1',
      stickerId: '2',
      keywords: ['hello'],
    }
    expect(redactMessage(sticker).message).toEqual(sticker)
    const event: NormalizedMessage = { kind: 'event', event: 'follow', data: {} }
    expect(redactMessage(event).message).toEqual(event)
  })

  test('redacts a quick-replies prompt', () => {
    const { message } = redactMessage({
      kind: 'quick_replies',
      text: `confirm ${VISA}`,
      items: [{ label: 'Yes', payload: 'yes' }],
    })
    if (message.kind !== 'quick_replies') throw new Error('kind changed')
    expect(message.text).toBe('confirm [card ••••4242]')
  })
})
