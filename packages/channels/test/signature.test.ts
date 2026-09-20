import { describe, expect, test } from 'bun:test'
import {
  signBodyBase64,
  signBodyHex,
  verifyLineSignature,
  verifyMetaSignature,
} from '../src/signature'

/**
 * The property these tests exist for is byte-exactness. A signature check that only works
 * for plain ASCII passes every casual test and then fails in production the first time a
 * Thai customer writes something, which reads as a platform outage rather than our bug.
 */

const SECRET = 'channel-secret-value'

const BODIES = [
  ['ascii', '{"events":[{"type":"message"}]}'],
  ['thai', '{"text":"สวัสดีค่ะ ราคาเท่าไหร่ 990 บาท"}'],
  ['emoji', '{"text":"ขอบคุณค่ะ 🙏🏻✨"}'],
  ['whitespace', '{\n  "a" :  1,\t"b":  [ 2 , 3 ]\n}'],
  ['escapes', '{"text":"line1\\nline2 \\"quoted\\" \\\\ backslash"}'],
  ['empty object', '{}'],
] as const

describe('LINE signatures', () => {
  for (const [label, body] of BODIES) {
    test(`accepts a correct signature over ${label} bytes`, async () => {
      const signature = await signBodyBase64(body, SECRET)
      expect(await verifyLineSignature(body, SECRET, signature)).toBe(true)
    })
  }

  test('rejects a signature made with a different secret', async () => {
    const body = BODIES[1][1]
    const signature = await signBodyBase64(body, 'another-secret')
    expect(await verifyLineSignature(body, SECRET, signature)).toBe(false)
  })

  test('rejects when a single byte of the body changed', async () => {
    const body = '{"text":"สวัสดีค่ะ"}'
    const signature = await signBodyBase64(body, SECRET)
    expect(await verifyLineSignature('{"text":"สวัสดีคะ"}', SECRET, signature)).toBe(false)
  })

  test('rejects a re-serialised body, which is the classic production failure', async () => {
    // A pretty-printed body, as a logging proxy or a re-encoding middleware would produce.
    const original = '{\n  "events": [\n    { "type": "message" }\n  ]\n}'
    const signature = await signBodyBase64(original, SECRET)

    const reserialised = JSON.stringify(JSON.parse(original))
    expect(reserialised).not.toBe(original)
    // Same data, different bytes, so the signature no longer matches.
    expect(await verifyLineSignature(reserialised, SECRET, signature)).toBe(false)
    // And the untouched bytes still verify, which is what the pipeline must preserve.
    expect(await verifyLineSignature(original, SECRET, signature)).toBe(true)
  })

  test('rejects a missing or malformed header', async () => {
    const body = '{}'
    expect(await verifyLineSignature(body, SECRET, undefined)).toBe(false)
    expect(await verifyLineSignature(body, SECRET, '')).toBe(false)
    expect(await verifyLineSignature(body, SECRET, 'not base64 !!')).toBe(false)
  })

  test('rejects when no secret is configured', async () => {
    expect(await verifyLineSignature('{}', '', await signBodyBase64('{}', SECRET))).toBe(false)
  })

  test('tolerates surrounding whitespace in the header', async () => {
    const body = BODIES[1][1]
    const signature = await signBodyBase64(body, SECRET)
    expect(await verifyLineSignature(body, SECRET, `  ${signature}  `)).toBe(true)
  })
})

describe('Meta signatures', () => {
  for (const [label, body] of BODIES) {
    test(`accepts a correct signature over ${label} bytes`, async () => {
      const signature = `sha256=${await signBodyHex(body, SECRET)}`
      expect(await verifyMetaSignature(body, SECRET, signature)).toBe(true)
    })
  }

  test('requires the sha256= prefix', async () => {
    const body = '{}'
    const hex = await signBodyHex(body, SECRET)
    expect(await verifyMetaSignature(body, SECRET, hex)).toBe(false)
    expect(await verifyMetaSignature(body, SECRET, `sha1=${hex}`)).toBe(false)
  })

  test('rejects a signature made with a different secret', async () => {
    const body = BODIES[1][1]
    const signature = `sha256=${await signBodyHex(body, 'another-secret')}`
    expect(await verifyMetaSignature(body, SECRET, signature)).toBe(false)
  })

  test('rejects a body altered after signing', async () => {
    const signature = `sha256=${await signBodyHex('{"a":1}', SECRET)}`
    expect(await verifyMetaSignature('{"a":2}', SECRET, signature)).toBe(false)
  })

  test('rejects a malformed hex payload', async () => {
    expect(await verifyMetaSignature('{}', SECRET, 'sha256=zzzz')).toBe(false)
    expect(await verifyMetaSignature('{}', SECRET, 'sha256=abc')).toBe(false)
  })

  test('accepts an upper-case hex signature', async () => {
    const body = '{"a":1}'
    const hex = (await signBodyHex(body, SECRET)).toUpperCase()
    expect(await verifyMetaSignature(body, SECRET, `sha256=${hex}`)).toBe(true)
  })
})
