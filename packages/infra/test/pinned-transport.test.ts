import { afterAll, describe, expect, test } from 'bun:test'
import { gzipSync } from 'node:zlib'
import { pinnedRequest } from '../src/pinned-transport'

/**
 * Recommendation #4, the DNS race: the request must reach the address the egress check
 * approved, not whatever a second resolution of the name says.
 *
 * The host below does not resolve at all. Reaching the local server through it proves the
 * connection used the pinned address and never asked DNS.
 */
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/gzip') {
      return new Response(gzipSync(JSON.stringify({ ok: 'ไทย' })), {
        headers: { 'content-encoding': 'gzip', 'content-type': 'application/json' },
      })
    }
    return Response.json({
      method: request.method,
      host: request.headers.get('host'),
      key: request.headers.get('x-api-key'),
      body: request.method === 'POST' ? await request.text() : null,
    })
  },
})
afterAll(() => server.stop(true))

const PINNED = [{ address: '127.0.0.1', family: 4 }]
const at = (path: string) => new URL(`http://does-not-resolve.invalid:${server.port}${path}`)

describe('pinnedRequest', () => {
  test('connects to the pinned address while keeping the hostname', async () => {
    const response = await pinnedRequest(at('/x'), {}, PINNED)
    const seen = await response.json()
    expect(seen.method).toBe('GET')
    expect(seen.host).toBe(`does-not-resolve.invalid:${server.port}`)
  })

  test('carries method, headers and a UTF-8 body', async () => {
    const response = await pinnedRequest(
      at('/x'),
      { method: 'POST', headers: { 'x-api-key': 'k' }, body: '{"q":"ราคา"}' },
      PINNED,
    )
    expect(await response.json()).toMatchObject({ method: 'POST', key: 'k', body: '{"q":"ราคา"}' })
  })

  test('decompresses as fetch would', async () => {
    const response = await pinnedRequest(at('/gzip'), {}, PINNED)
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(await response.json()).toEqual({ ok: 'ไทย' })
  })

  test('honours an abort signal', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(pinnedRequest(at('/x'), { signal: controller.signal }, PINNED)).rejects.toThrow()
  })
})
