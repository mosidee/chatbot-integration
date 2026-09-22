import { describe, expect, test } from 'bun:test'
import { signMediaUrl, verifyMediaToken, withMediaLinks } from '../src/media-links'

/**
 * The link a chat platform fetches a file with.
 *
 * Everything else here keeps media private and reads it as bytes. This is the one place
 * that hands a URL to somebody else's infrastructure, so what makes it safe — the
 * signature and the expiry — is worth pinning down rather than assuming.
 */

const SECRET = 'a-secret-that-is-long-enough-to-sign-with'
const BASE = 'https://chat.example.com'

const tokenOf = (url: string): string => url.split('/api/media/')[1]?.split('/')[0] ?? ''

describe('a signed media link', () => {
  test('names the file it is for, and reads back', async () => {
    const url = await signMediaUrl({
      workspaceId: 'ws-1',
      storageKey: 'ws-1/invoice.pdf',
      fileName: 'invoice.pdf',
      secret: SECRET,
      baseUrl: BASE,
      ttlDays: 7,
    })

    expect(url.startsWith(`${BASE}/api/media/`)).toBe(true)
    // Ends in something a platform and a person both recognise.
    expect(url.endsWith('/invoice.pdf')).toBe(true)

    const claims = await verifyMediaToken(tokenOf(url), SECRET)
    expect(claims.key).toBe('ws-1/invoice.pdf')
  })

  test('cannot be edited into a link for another file', async () => {
    const mine = await signMediaUrl({
      workspaceId: 'ws-1',
      storageKey: 'ws-1/mine.pdf',
      secret: SECRET,
      baseUrl: BASE,
      ttlDays: 7,
    })

    // The claims are readable, as in any such envelope. Changing them breaks the signature,
    // which is the whole point: the key is signed, not hidden.
    const [header, , signature] = tokenOf(mine).split('.')
    const forgedPayload = btoa(JSON.stringify({ key: 'ws-2/theirs.pdf', exp: 9_999_999_999 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

    await expect(
      verifyMediaToken(`${header}.${forgedPayload}.${signature}`, SECRET),
    ).rejects.toThrow()
  })

  test('is refused once it has expired', async () => {
    const url = await signMediaUrl({
      workspaceId: 'ws-1',
      storageKey: 'ws-1/old.png',
      secret: SECRET,
      baseUrl: BASE,
      ttlDays: 7,
    })

    const eightDaysLater = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000)
    await expect(verifyMediaToken(tokenOf(url), SECRET, eightDaysLater)).rejects.toThrow()

    // And still good the day before.
    const sixDaysLater = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000)
    expect((await verifyMediaToken(tokenOf(url), SECRET, sixDaysLater)).key).toBe('ws-1/old.png')
  })

  test('is refused when signed with a different secret', async () => {
    const url = await signMediaUrl({
      workspaceId: 'ws-1',
      storageKey: 'ws-1/x.png',
      secret: SECRET,
      baseUrl: BASE,
      ttlDays: 7,
    })
    await expect(verifyMediaToken(tokenOf(url), 'a-completely-different-secret')).rejects.toThrow()
  })

  test('honours the lifetime it is given', async () => {
    const url = await signMediaUrl({
      workspaceId: 'ws-1',
      storageKey: 'ws-1/x.png',
      secret: SECRET,
      baseUrl: BASE,
      ttlDays: 1,
    })
    const twoDays = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)
    await expect(verifyMediaToken(tokenOf(url), SECRET, twoDays)).rejects.toThrow()
  })
})

describe('turning a stored file into something sendable', () => {
  const attachment: {
    storageKey: string | null
    sourceUrl: string | null
    mime: string
    sizeBytes: number | null
    fileName: string | null
    width: number | null
    height: number | null
    durationMs: number | null
  } = {
    storageKey: 'ws-1/receipt.pdf',
    sourceUrl: null,
    mime: 'application/pdf',
    sizeBytes: 10,
    fileName: 'receipt.pdf',
    width: null,
    height: null,
    durationMs: null,
  }

  test('gives an attachment we hold a link a platform can fetch', async () => {
    const message = await withMediaLinks(
      { kind: 'file', text: 'here it is', attachments: [attachment] },
      { workspaceId: 'ws-1', secret: SECRET, baseUrl: BASE, ttlDays: 7 },
    )
    expect(message.attachments[0]?.sourceUrl?.startsWith(`${BASE}/api/media/`)).toBe(true)
    // Untouched otherwise.
    expect(message.attachments[0]?.storageKey).toBe('ws-1/receipt.pdf')
    expect(message.text).toBe('here it is')
  })

  test('leaves an attachment that already has a url alone', async () => {
    const fromPlatform = { ...attachment, sourceUrl: 'https://cdn.line.me/abc' }
    const message = await withMediaLinks(
      { kind: 'image', text: null, attachments: [fromPlatform] },
      { workspaceId: 'ws-1', secret: SECRET, baseUrl: BASE, ttlDays: 7 },
    )
    expect(message.attachments[0]?.sourceUrl).toBe('https://cdn.line.me/abc')
  })

  test('passes a message with no attachments straight through', async () => {
    const message = await withMediaLinks(
      { kind: 'text', text: 'hello' },
      {
        workspaceId: 'ws-1',
        secret: SECRET,
        baseUrl: BASE,
        ttlDays: 7,
      },
    )
    expect(message).toEqual({ kind: 'text', text: 'hello' })
  })
})

describe('the workspace on a link', () => {
  /**
   * The signature proves we minted the link, not that its holder may see that tenant's
   * file. Key prefix is the tenancy boundary here — the authenticated uploads route
   * enforces exactly this — so the public route keeps it rather than dropping it.
   */
  test('refuses to sign a key outside the workspace it names', async () => {
    await expect(
      signMediaUrl({
        workspaceId: 'ws-1',
        storageKey: 'ws-2/theirs.pdf',
        secret: SECRET,
        baseUrl: BASE,
        ttlDays: 7,
      }),
    ).rejects.toThrow(/outside its workspace/)
  })

  test('refuses a link whose key was swapped for another tenant', async () => {
    // Forged with a valid-looking pair, which is what an attacker who learned the shape
    // would try. The mismatch alone is enough; the signature never has to be checked.
    const forged = btoa(JSON.stringify({ key: 'ws-2/theirs.pdf', ws: 'ws-1', exp: 9_999_999_999 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

    await expect(verifyMediaToken(`${header}.${forged}.nonsense`, SECRET)).rejects.toThrow()
  })

  test('names the workspace it was minted for', async () => {
    const url = await signMediaUrl({
      workspaceId: 'ws-1',
      storageKey: 'ws-1/ok.pdf',
      secret: SECRET,
      baseUrl: BASE,
      ttlDays: 7,
    })
    expect((await verifyMediaToken(tokenOf(url), SECRET)).ws).toBe('ws-1')
  })
})
