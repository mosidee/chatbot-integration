/**
 * Webhook signature verification.
 *
 * Both platforms sign the raw request body with HMAC-SHA256. The critical property is that
 * the hash must run over the exact bytes the platform sent: parsing JSON and re-serialising
 * it changes key order, whitespace and escaping, and the signature then fails. It fails
 * intermittently, too, because ASCII-only bodies often survive a round trip while Thai text
 * does not, which makes it look like a platform problem rather than ours.
 *
 * The raw body therefore travels from `request.text()` to here untouched.
 */

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

function decodeHex(value: string): Uint8Array | null {
  if (value.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(value)) return null
  const bytes = new Uint8Array(value.length / 2)
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

async function hmacSha256(secret: string, rawBody: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  // The body is encoded here and nowhere else, so what is hashed is what arrived.
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody))
  return new Uint8Array(signature)
}

/**
 * LINE signs with HMAC-SHA256 and sends the result base64 encoded in `x-line-signature`.
 */
export async function verifyLineSignature(
  rawBody: string,
  channelSecret: string,
  headerValue: string | undefined,
): Promise<boolean> {
  if (!headerValue || !channelSecret) return false
  const provided = decodeBase64(headerValue.trim())
  if (!provided) return false
  return timingSafeEqual(await hmacSha256(channelSecret, rawBody), provided)
}

/**
 * Meta signs with HMAC-SHA256 over the raw body using the app secret, and sends it
 * hex encoded in `x-hub-signature-256`, prefixed with `sha256=`.
 */
export async function verifyMetaSignature(
  rawBody: string,
  appSecret: string,
  headerValue: string | undefined,
): Promise<boolean> {
  if (!headerValue || !appSecret) return false
  const trimmed = headerValue.trim()
  if (!trimmed.startsWith('sha256=')) return false
  const provided = decodeHex(trimmed.slice('sha256='.length))
  if (!provided) return false
  return timingSafeEqual(await hmacSha256(appSecret, rawBody), provided)
}

/** Sign a body the way a platform would. Used by tests and by the settings self-check. */
export async function signBodyBase64(rawBody: string, secret: string): Promise<string> {
  const bytes = await hmacSha256(secret, rawBody)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

export async function signBodyHex(rawBody: string, secret: string): Promise<string> {
  const bytes = await hmacSha256(secret, rawBody)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}
