import { describe, expect, test } from 'bun:test'
import type { BlobStore, Logger } from '@ci/core'
import type { NormalizedMessage } from '@ci/shared'
import { resolveInboundMedia } from '../src/media'

/**
 * Inbound media resolution.
 *
 * The property that matters most: a download that fails degrades the message rather than
 * dropping it. The customer said something and an agent needs to see it.
 */

function memoryBlobStore() {
  const objects = new Map<string, { data: Uint8Array<ArrayBuffer>; mime: string }>()
  const store: BlobStore = {
    async get(key) {
      const found = objects.get(key)
      if (!found) throw new Error(`missing ${key}`)
      return found
    },
    async remove(key) {
      objects.delete(key)
    },
    async put(key, data, mime) {
      objects.set(key, { data, mime })
    },
    urlFor: (key) => `/media/${key}`,
  }
  return { store, objects }
}

function collectingLogger() {
  const warnings: string[] = []
  const logger: Logger = {
    info: () => {},
    warn: (message) => warnings.push(message),
    error: () => {},
  }
  return { logger, warnings }
}

const bytes = (values: number[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(new ArrayBuffer(values.length))
  out.set(values)
  return out
}

function imageMessage(sourceUrl: string | null, mime = 'image/jpeg'): NormalizedMessage {
  return {
    kind: 'image',
    text: null,
    attachments: [
      {
        storageKey: null,
        sourceUrl,
        mime,
        sizeBytes: null,
        fileName: null,
        width: null,
        height: null,
        durationMs: null,
      },
    ],
  }
}

describe('resolveInboundMedia', () => {
  test('downloads a platform reference into our own storage', async () => {
    const { store, objects } = memoryBlobStore()
    const { logger } = collectingLogger()

    const result = await resolveInboundMedia(imageMessage('line:500000000002'), {
      workspaceId: 'ws-1',
      channelType: 'line',
      adapter: {
        fetchMedia: async () => ({ data: bytes([1, 2, 3, 4]), mime: 'image/png' }),
      },
      config: {},
      blob: store,
      logger,
    })

    expect(result.downloaded).toBe(1)
    expect(result.failed).toBe(0)
    if (result.message.kind !== 'image') throw new Error('kind changed')

    const key = result.message.attachments[0]?.storageKey
    expect(key).toBeTruthy()
    // Keys are namespaced by workspace, so one tenant cannot name another's object.
    expect(key?.startsWith('ws-1/inbound/')).toBe(true)
    expect(key?.endsWith('.png')).toBe(true)
    expect(result.message.attachments[0]?.mime).toBe('image/png')
    expect(result.message.attachments[0]?.sizeBytes).toBe(4)
    expect(objects.has(key ?? '')).toBe(true)
  })

  test('a failed download degrades the message rather than dropping it', async () => {
    const { store } = memoryBlobStore()
    const { logger, warnings } = collectingLogger()

    const result = await resolveInboundMedia(imageMessage('line:missing'), {
      workspaceId: 'ws-1',
      channelType: 'line',
      adapter: {
        fetchMedia: async () => {
          throw new Error('blob endpoint unavailable')
        },
      },
      config: {},
      blob: store,
      logger,
    })

    expect(result.failed).toBe(1)
    if (result.message.kind !== 'image') throw new Error('kind changed')
    // The attachment survives, so an agent sees that something was sent.
    expect(result.message.attachments).toHaveLength(1)
    expect(result.message.attachments[0]?.storageKey).toBeNull()
    expect(result.message.attachments[0]?.sourceUrl).toBe('line:missing')
    expect(warnings).toContain('could not download inbound media')
  })

  test('retries once before giving up', async () => {
    const { store } = memoryBlobStore()
    const { logger } = collectingLogger()
    let attempts = 0

    const result = await resolveInboundMedia(imageMessage('line:flaky'), {
      workspaceId: 'ws-1',
      channelType: 'line',
      adapter: {
        fetchMedia: async () => {
          attempts += 1
          if (attempts === 1) throw new Error('transient')
          return { data: bytes([7]), mime: 'image/jpeg' }
        },
      },
      config: {},
      blob: store,
      logger,
    })

    expect(attempts).toBe(2)
    expect(result.downloaded).toBe(1)
  })

  test('refuses media above the size limit', async () => {
    const { store } = memoryBlobStore()
    const { logger } = collectingLogger()

    const result = await resolveInboundMedia(imageMessage('line:huge'), {
      workspaceId: 'ws-1',
      channelType: 'line',
      adapter: {
        fetchMedia: async () => ({
          data: new Uint8Array(new ArrayBuffer(26 * 1024 * 1024)),
          mime: 'image/jpeg',
        }),
      },
      config: {},
      blob: store,
      logger,
    })

    expect(result.failed).toBe(1)
    expect(result.downloaded).toBe(0)
  })

  test('prefers a specific media type over the generic one a platform returns', async () => {
    const { store } = memoryBlobStore()
    const { logger } = collectingLogger()

    const result = await resolveInboundMedia(imageMessage('line:1', 'image/jpeg'), {
      workspaceId: 'ws-1',
      channelType: 'line',
      adapter: {
        // LINE's blob endpoint returns a generic type; the adapter already knew better.
        fetchMedia: async () => ({ data: bytes([1]), mime: 'application/octet-stream' }),
      },
      config: {},
      blob: store,
      logger,
    })

    if (result.message.kind !== 'image') throw new Error('kind changed')
    expect(result.message.attachments[0]?.mime).toBe('image/jpeg')
  })

  test('leaves an attachment we already stored alone', async () => {
    const { store } = memoryBlobStore()
    const { logger } = collectingLogger()
    let called = false

    const already: NormalizedMessage = {
      kind: 'image',
      text: null,
      attachments: [
        {
          storageKey: 'ws-1/inbound/existing.png',
          sourceUrl: 'line:1',
          mime: 'image/png',
          sizeBytes: 10,
          fileName: null,
          width: null,
          height: null,
          durationMs: null,
        },
      ],
    }

    const result = await resolveInboundMedia(already, {
      workspaceId: 'ws-1',
      channelType: 'line',
      adapter: {
        fetchMedia: async () => {
          called = true
          return { data: bytes([1]), mime: 'image/png' }
        },
      },
      config: {},
      blob: store,
      logger,
    })

    expect(called).toBe(false)
    expect(result.downloaded).toBe(0)
  })

  test('passes non-media messages straight through', async () => {
    const { store } = memoryBlobStore()
    const { logger } = collectingLogger()
    const text: NormalizedMessage = { kind: 'text', text: 'สวัสดีค่ะ' }

    const result = await resolveInboundMedia(text, {
      workspaceId: 'ws-1',
      channelType: 'line',
      adapter: { fetchMedia: async () => ({ data: bytes([1]), mime: 'image/png' }) },
      config: {},
      blob: store,
      logger,
    })

    expect(result.message).toEqual(text)
    expect(result.downloaded).toBe(0)
  })

  test('does nothing for an adapter that cannot fetch media', async () => {
    const { store } = memoryBlobStore()
    const { logger } = collectingLogger()

    const result = await resolveInboundMedia(imageMessage('web:1'), {
      workspaceId: 'ws-1',
      channelType: 'web',
      adapter: {},
      config: {},
      blob: store,
      logger,
    })

    expect(result.downloaded).toBe(0)
    if (result.message.kind !== 'image') throw new Error('kind changed')
    expect(result.message.attachments[0]?.storageKey).toBeNull()
  })
})
