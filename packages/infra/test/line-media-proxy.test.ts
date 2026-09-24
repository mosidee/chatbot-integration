import { afterEach, describe, expect, test } from 'bun:test'
import type { Logger } from '@ci/core'
import { withLineMediaProxy } from '../src/line-media-proxy'

/**
 * LINE media through the Cloudflare Worker (ADR 0009). The Worker is stood in for by a local
 * server; what matters here is what is asked of it, and that a failure still gets the photo.
 */

const servers: { stop: (force?: boolean) => void }[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

const quiet = (): Logger & { warnings: string[] } => {
  const warnings: string[] = []
  return { info: () => {}, warn: (message) => warnings.push(message), error: () => {}, warnings }
}

const SECRET = 's'.repeat(40)
const direct = {
  fetchMedia: async () => ({
    data: new Uint8Array([9]) as Uint8Array<ArrayBuffer>,
    mime: 'image/png',
  }),
}

function proxy(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, fetch: handler })
  servers.push(server)
  return `http://localhost:${server.port}/`
}

describe('LINE media through the proxy', () => {
  test('asks for the message id with the channel token, behind the shared secret', async () => {
    const seen: { auth: string | null; body: unknown }[] = []
    const url = proxy(async (request) => {
      seen.push({ auth: request.headers.get('authorization'), body: await request.json() })
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } })
    })
    const fetcher = withLineMediaProxy(direct, {
      channelType: 'line',
      proxyUrl: url,
      proxySecret: SECRET,
      logger: quiet(),
    })

    const media = await fetcher.fetchMedia?.('line:5551234', { channelAccessToken: 'tok' } as never)
    expect(seen).toEqual([
      { auth: `Bearer ${SECRET}`, body: { messageId: '5551234', token: 'tok' } },
    ])
    expect([...(media?.data ?? [])]).toEqual([1, 2, 3])
    expect(media?.mime).toBe('image/jpeg')
  })

  test('falls back to the direct fetch when the proxy refuses', async () => {
    const url = proxy(() => new Response('no', { status: 502 }))
    const logger = quiet()
    const fetcher = withLineMediaProxy(direct, {
      channelType: 'line',
      proxyUrl: url,
      proxySecret: SECRET,
      logger,
    })

    const media = await fetcher.fetchMedia?.('line:1', { channelAccessToken: 'tok' } as never)
    expect([...(media?.data ?? [])]).toEqual([9])
    expect(logger.warnings).toContain('LINE media proxy failed; fetching directly')
  })

  test('leaves other channels, and an installation without a proxy, alone', () => {
    const base = { channelType: 'line' as const, proxySecret: SECRET, logger: quiet() }
    expect(withLineMediaProxy(direct, { ...base, proxyUrl: undefined })).toBe(direct)
    expect(
      withLineMediaProxy(direct, { ...base, channelType: 'messenger', proxyUrl: 'http://x/' }),
    ).toBe(direct)
  })
})
