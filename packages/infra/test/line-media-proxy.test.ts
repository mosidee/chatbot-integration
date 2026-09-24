import { afterEach, describe, expect, test } from 'bun:test'
import type { BlobStore, Logger } from '@ci/core'
import { withLineMediaProxy } from '../src/line-media-proxy'
import { resolveInboundMedia } from '../src/media'

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

const memoryBlob = (): BlobStore => {
  const objects = new Map<string, { data: Uint8Array<ArrayBuffer>; mime: string }>()
  return {
    async get(key) {
      const found = objects.get(key)
      if (!found) throw new Error(`missing ${key}`)
      return found
    },
    async put(key, data, mime) {
      objects.set(key, { data, mime })
    },
    async remove(key) {
      objects.delete(key)
    },
    urlFor: (key) => `/media/${key}`,
  }
}
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

  test('does not fall back or retry when LINE itself refused the media', async () => {
    let proxied = 0
    let directCalls = 0
    const url = proxy(() => {
      proxied += 1
      return new Response('gone', { status: 404, headers: { 'x-upstream': 'line' } })
    })
    const proxyLogger = quiet()
    const fetcher = withLineMediaProxy(
      {
        fetchMedia: async () => {
          directCalls += 1
          return { data: new Uint8Array([9]) as Uint8Array<ArrayBuffer>, mime: 'image/png' }
        },
      },
      { channelType: 'line', proxyUrl: url, proxySecret: SECRET, logger: proxyLogger },
    )
    const logger = quiet()
    const result = await resolveInboundMedia(
      {
        kind: 'image',
        text: null,
        attachments: [
          {
            storageKey: null,
            sourceUrl: 'line:1',
            mime: 'image/jpeg',
            sizeBytes: null,
            fileName: null,
            width: null,
            height: null,
            durationMs: null,
          },
        ],
      },
      {
        workspaceId: 'ws-1',
        channelType: 'line',
        adapter: fetcher,
        config: { channelAccessToken: 'tok' },
        blob: memoryBlob(),
        logger,
      },
    )
    expect(result.failed).toBe(1)
    expect(proxied).toBe(1)
    expect(directCalls).toBe(0)
    // Recorded as a failed download, and not as a proxy failure worth falling back from.
    expect(logger.warnings).toContain('could not download inbound media')
    expect(proxyLogger.warnings).toEqual([])
  })

  test("still falls back when the refusal is the proxy's own", async () => {
    let directCalls = 0
    const url = proxy(() => new Response('unauthorised', { status: 401 }))
    const fetcher = withLineMediaProxy(
      {
        fetchMedia: async () => {
          directCalls += 1
          return { data: new Uint8Array([9]) as Uint8Array<ArrayBuffer>, mime: 'image/png' }
        },
      },
      { channelType: 'line', proxyUrl: url, proxySecret: SECRET, logger: quiet() },
    )
    await fetcher.fetchMedia?.('line:1', { channelAccessToken: 'tok' } as never)
    expect(directCalls).toBe(1)
  })

  test('leaves other channels, and an installation without a proxy, alone', () => {
    const base = { channelType: 'line' as const, proxySecret: SECRET, logger: quiet() }
    expect(withLineMediaProxy(direct, { ...base, proxyUrl: undefined })).toBe(direct)
    expect(
      withLineMediaProxy(direct, { ...base, channelType: 'messenger', proxyUrl: 'http://x/' }),
    ).toBe(direct)
  })
})
