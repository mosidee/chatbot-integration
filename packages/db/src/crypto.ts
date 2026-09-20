/**
 * AES-256-GCM encryption for provider API keys and channel credentials.
 *
 * Uses Web Crypto (`crypto.subtle`) rather than node:crypto so the same code runs on Bun,
 * Node and edge runtimes. Ciphertext format is base64(iv[12] || ciphertext || tag).
 */

const IV_BYTES = 12

function decodeKey(base64Key: string): Uint8Array<ArrayBuffer> {
  const raw = fromBase64(base64Key)
  if (raw.length !== 32) {
    throw new Error(`APP_SECRET_KEY must decode to 32 bytes, got ${raw.length}`)
  }
  return raw
}

async function importKey(base64Key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', decodeKey(base64Key), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ])
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  // Explicitly ArrayBuffer-backed: Web Crypto's BufferSource rejects ArrayBufferLike views.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export async function encryptSecret(plaintext: string, base64Key: string): Promise<string> {
  const key = await importKey(base64Key)
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(IV_BYTES)))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)),
  )
  const packed = new Uint8Array(new ArrayBuffer(iv.length + ciphertext.length))
  packed.set(iv, 0)
  packed.set(ciphertext, iv.length)
  return toBase64(packed)
}

export async function decryptSecret(packedBase64: string, base64Key: string): Promise<string> {
  const packed = fromBase64(packedBase64)
  if (packed.length <= IV_BYTES) throw new Error('ciphertext too short')
  const key = await importKey(base64Key)
  const iv = packed.slice(0, IV_BYTES)
  const ciphertext = packed.slice(IV_BYTES)
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
  return new TextDecoder().decode(plaintext)
}

/** Encrypt a JSON-serialisable value (channel config, custom headers). */
export async function encryptJson(value: unknown, base64Key: string): Promise<string> {
  return encryptSecret(JSON.stringify(value), base64Key)
}

export async function decryptJson<T>(packedBase64: string, base64Key: string): Promise<T> {
  return JSON.parse(await decryptSecret(packedBase64, base64Key)) as T
}

/** Generate a fresh 32-byte key, base64 encoded. For setup scripts and tests. */
export function generateSecretKey(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(new ArrayBuffer(32))))
}
