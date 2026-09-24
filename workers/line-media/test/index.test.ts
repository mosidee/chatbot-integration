import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { timingSafeEqual } from 'node:crypto'
import worker from '../src/index'

/**
 * The LINE media Worker (ADR 0009), run under Bun with LINE stubbed at `fetch`. What matters
 * is what it refuses: it holds a channel token in transit and must never become a proxy for
 * anything but LINE's content endpoint.
 */

const SECRET = 'x'.repeat(48)
const env = { PROXY_SECRET: SECRET }
const realFetch = globalThis.fetch
let upstream: { url: string; auth: string | null }[] = []

beforeAll(() => {
  // Cloudflare's runtime adds `timingSafeEqual` to `crypto.subtle`; Bun does not.
  const subtle = crypto.subtle as unknown as Record<string, unknown>
  if (!subtle.timingSafeEqual) {
    subtle.timingSafeEqual = (a: ArrayBuffer, b: ArrayBuffer) =>
      timingSafeEqual(new Uint8Array(a), new Uint8Array(b))
  }
})

afterEach(() => {
  globalThis.fetch = realFetch
  upstream = []
})

function lineAnswers(response: () => Response) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    upstream.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') })
    return response()
  }) as unknown as typeof fetch
}

const call = (body: unknown, init: { secret?: string | null; method?: string } = {}) =>
  worker.fetch(
    new Request('https://proxy.example/', {
      method: init.method ?? 'POST',
      headers: init.secret === null ? {} : { authorization: `Bearer ${init.secret ?? SECRET}` },
      ...(init.method === 'GET' ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  )

describe('the LINE media Worker', () => {
  test('fetches only LINE content for the id, with the token, and marks the answer as LINE', async () => {
    lineAnswers(
      () => new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'image/jpeg' } }),
    )
    const response = await call({ messageId: '5551234', token: 'channel-token' })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/jpeg')
    expect(response.headers.get('x-upstream')).toBe('line')
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2])
    expect(upstream).toEqual([
      {
        url: 'https://api-data.line.me/v2/bot/message/5551234/content',
        auth: 'Bearer channel-token',
      },
    ])
  })

  test("passes LINE's refusal through, still marked as LINE's", async () => {
    lineAnswers(() => new Response('gone', { status: 404 }))
    const response = await call({ messageId: '1', token: 't' })
    expect(response.status).toBe(404)
    expect(response.headers.get('x-upstream')).toBe('line')
  })

  test('refuses a caller without the secret, or with the wrong one', async () => {
    lineAnswers(() => new Response('should not be called'))
    expect((await call({ messageId: '1', token: 't' }, { secret: null })).status).toBe(401)
    expect((await call({ messageId: '1', token: 't' }, { secret: 'y'.repeat(48) })).status).toBe(
      401,
    )
    expect(upstream).toEqual([])
  })

  test('refuses anything that is not a numeric message id, so it cannot be aimed elsewhere', async () => {
    lineAnswers(() => new Response('should not be called'))
    for (const messageId of ['https://example.com/x', '../1', '1/../../2', '', 42]) {
      expect((await call({ messageId, token: 't' })).status).toBe(400)
    }
    expect((await call({ messageId: '1' })).status).toBe(400)
    expect((await call({ messageId: '1', token: '' })).status).toBe(400)
    expect(upstream).toEqual([])
  })

  test('answers only POST', async () => {
    expect((await call(null, { method: 'GET' })).status).toBe(405)
  })
})
