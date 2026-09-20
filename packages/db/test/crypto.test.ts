import { describe, expect, test } from 'bun:test'
import {
  decryptJson,
  decryptSecret,
  encryptJson,
  encryptSecret,
  generateSecretKey,
} from '../src/crypto'

describe('secret encryption', () => {
  const key = generateSecretKey()

  test('round-trips a secret', async () => {
    const plaintext = 'sk-proj-abc123-XYZ'
    const packed = await encryptSecret(plaintext, key)
    expect(packed).not.toContain(plaintext)
    expect(await decryptSecret(packed, key)).toBe(plaintext)
  })

  test('round-trips Thai and emoji text', async () => {
    const plaintext = 'คีย์ลับ 🔐 secret'
    expect(await decryptSecret(await encryptSecret(plaintext, key), key)).toBe(plaintext)
  })

  test('produces a different ciphertext each time (random IV)', async () => {
    const a = await encryptSecret('same', key)
    const b = await encryptSecret('same', key)
    expect(a).not.toBe(b)
    expect(await decryptSecret(a, key)).toBe(await decryptSecret(b, key))
  })

  test('fails to decrypt with a different key', async () => {
    const packed = await encryptSecret('secret', key)
    await expect(decryptSecret(packed, generateSecretKey())).rejects.toThrow()
  })

  test('rejects a tampered ciphertext', async () => {
    const packed = await encryptSecret('secret', key)
    const bytes = Uint8Array.from(atob(packed), (c) => c.charCodeAt(0))
    bytes[bytes.length - 1] ^= 0xff
    let tampered = ''
    for (const b of bytes) tampered += String.fromCharCode(b)
    await expect(decryptSecret(btoa(tampered), key)).rejects.toThrow()
  })

  test('rejects a key that is not 32 bytes', async () => {
    await expect(encryptSecret('x', btoa('short'))).rejects.toThrow(/32 bytes/)
  })

  test('round-trips JSON config', async () => {
    const config = { channelSecret: 'abc', accessToken: 'def', nested: { n: 1 } }
    const packed = await encryptJson(config, key)
    expect(await decryptJson<typeof config>(packed, key)).toEqual(config)
  })

  test('rejects ciphertext shorter than the IV', async () => {
    await expect(decryptSecret(btoa('tiny'), key)).rejects.toThrow(/too short/)
  })
})
