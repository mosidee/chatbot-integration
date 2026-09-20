import { z } from 'zod'

/**
 * Minimal HS256 JWT verification for widget visitor tokens.
 *
 * The host application (salon-saas) signs a short-lived token for its logged-in user and
 * the widget presents it, so a support conversation is linked to a known account from the
 * first message. Implemented over Web Crypto rather than a library: one algorithm, one
 * use, and no dependency that has to be kept current.
 */

export const visitorClaimsSchema = z.object({
  /** The host application's user or account id. Becomes the channel identity. */
  sub: z.string().min(1),
  name: z.string().optional(),
  email: z.string().optional(),
  /** Free-form attributes copied onto the customer record, e.g. plan or company. */
  attributes: z.record(z.string(), z.string()).optional(),
  exp: z.number().int().optional(),
  iat: z.number().int().optional(),
})

export type VisitorClaims = z.infer<typeof visitorClaimsSchema>

export class VisitorTokenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VisitorTokenError'
  }
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const withPadding = padded + '='.repeat((4 - (padded.length % 4)) % 4)
  const binary = atob(withPadding)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

/**
 * Verify an HS256 token and return its claims.
 * Throws VisitorTokenError on any failure; callers treat the visitor as anonymous.
 */
export async function verifyVisitorToken(
  token: string,
  secret: string,
  now: Date = new Date(),
): Promise<VisitorClaims> {
  const rawClaims = await verifyEnvelope(token, secret)

  const parsed = visitorClaimsSchema.safeParse(rawClaims)
  if (!parsed.success) throw new VisitorTokenError('payload is missing required claims')

  const claims = parsed.data
  if (claims.exp !== undefined && claims.exp * 1000 <= now.getTime()) {
    throw new VisitorTokenError('token has expired')
  }

  return claims
}

/** Signature and structure only. What the payload must contain is the caller's business. */
async function verifyEnvelope(token: string, secret: string): Promise<unknown> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new VisitorTokenError('token must have three segments')
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]

  let header: { alg?: string; typ?: string }
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerPart)))
  } catch {
    throw new VisitorTokenError('header is not valid JSON')
  }
  if (header.alg !== 'HS256') throw new VisitorTokenError(`unsupported algorithm ${header.alg}`)

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const expected = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${headerPart}.${payloadPart}`)),
  )

  let provided: Uint8Array
  try {
    provided = base64UrlDecode(signaturePart)
  } catch {
    throw new VisitorTokenError('signature is not valid base64url')
  }
  if (!timingSafeEqual(expected, provided)) throw new VisitorTokenError('signature mismatch')

  let rawClaims: unknown
  try {
    rawClaims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadPart)))
  } catch {
    throw new VisitorTokenError('payload is not valid JSON')
  }

  return rawClaims
}

/**
 * The same envelope, with the caller deciding what the payload must look like.
 *
 * The widget's own session token is not a visitor token from a host application: it is
 * ours, minted after we have decided who the visitor is, and it carries the conversation
 * they are allowed to see. Sharing the signing and verification keeps one HMAC
 * implementation rather than two.
 */
export async function verifySignedPayload<T>(
  token: string,
  secret: string,
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
  now: Date = new Date(),
): Promise<T> {
  const raw = await verifyEnvelope(token, secret)
  const parsed = schema.safeParse(raw)
  if (!parsed.success || parsed.data === undefined) {
    throw new VisitorTokenError('payload is missing required claims')
  }

  const expiry = (raw as { exp?: unknown }).exp
  if (typeof expiry === 'number' && expiry * 1000 <= now.getTime()) {
    throw new VisitorTokenError('token has expired')
  }

  return parsed.data
}

/** Sign a token. Used by tests and by the documentation example for host applications. */
export async function signVisitorToken(claims: VisitorClaims, secret: string): Promise<string> {
  return signPayload(claims, secret)
}

export async function signPayload(claims: unknown, secret: string): Promise<string> {
  const encode = (value: unknown): string =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  const headerPart = encode({ alg: 'HS256', typ: 'JWT' })
  const payloadPart = encode(claims)

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${headerPart}.${payloadPart}`)),
  )

  let binary = ''
  for (const b of signature) binary += String.fromCharCode(b)
  const signaturePart = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  return `${headerPart}.${payloadPart}.${signaturePart}`
}
