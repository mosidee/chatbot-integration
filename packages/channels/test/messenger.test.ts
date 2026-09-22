import { describe, expect, test } from 'bun:test'
import { type MessengerConfig, messengerChannelAdapter } from '../src/adapters/messenger'
import { signBodyHex } from '../src/signature'
import type { WebhookRequest } from '../src/types'

/**
 * Messenger adapter tests.
 *
 * Meta publishes no SDK, so unlike the LINE fixtures these payloads are composed from the
 * documented webhook reference rather than checked against a schema the platform owns. They
 * prove the adapter matches our reading of the docs. Real payloads should be captured on
 * staging once a Meta app exists and added here.
 */

const CONFIG: MessengerConfig = {
  appSecret: 'meta-app-secret',
  pageId: '100000000000001',
  pageAccessToken: 'page-access-token',
  graphVersion: 'v26.0',
}

const PSID = '900000000000009'

async function request(payload: unknown): Promise<WebhookRequest> {
  const rawBody = JSON.stringify(payload)
  return {
    rawBody,
    headers: { 'x-hub-signature-256': `sha256=${await signBodyHex(rawBody, CONFIG.appSecret)}` },
    query: {},
  }
}

function pageEvent(messaging: unknown[]): unknown {
  return {
    object: 'page',
    entry: [{ id: CONFIG.pageId, time: 1_789_000_000_000, messaging }],
  }
}

const textMessaging = {
  sender: { id: PSID },
  recipient: { id: CONFIG.pageId },
  timestamp: 1_789_000_000_000,
  message: { mid: 'm_abc123', text: 'ราคาเท่าไหร่คะ' },
}

describe('signature verification', () => {
  test('accepts a correctly signed payload', async () => {
    expect(
      await messengerChannelAdapter.verifyWebhook(
        await request(pageEvent([textMessaging])),
        CONFIG,
      ),
    ).toBe(true)
  })

  test('rejects a signature made with a different app secret', async () => {
    const payload = pageEvent([textMessaging])
    const rawBody = JSON.stringify(payload)
    const req: WebhookRequest = {
      rawBody,
      headers: { 'x-hub-signature-256': `sha256=${await signBodyHex(rawBody, 'wrong')}` },
      query: {},
    }
    expect(await messengerChannelAdapter.verifyWebhook(req, CONFIG)).toBe(false)
  })

  test('rejects a missing signature header', async () => {
    const req = await request(pageEvent([textMessaging]))
    expect(await messengerChannelAdapter.verifyWebhook({ ...req, headers: {} }, CONFIG)).toBe(false)
  })

  test('rejects a body altered after signing', async () => {
    const req = await request(pageEvent([textMessaging]))
    expect(
      await messengerChannelAdapter.verifyWebhook(
        { ...req, rawBody: req.rawBody.replace('ราคาเท่าไหร่คะ', 'ฟรีไหมคะ') },
        CONFIG,
      ),
    ).toBe(false)
  })
})

describe('inbound messages', () => {
  test('normalises a Thai text message', async () => {
    const events = messengerChannelAdapter.parseInbound(
      await request(pageEvent([textMessaging])),
      CONFIG,
    )
    expect(events).toHaveLength(1)
    expect(events[0]?.externalId).toBe(PSID)
    expect(events[0]?.platformEventId).toBe('m_abc123')
    expect(events[0]?.message).toEqual({ kind: 'text', text: 'ราคาเท่าไหร่คะ' })
  })

  test('records an image attachment as a URL to download', async () => {
    const events = messengerChannelAdapter.parseInbound(
      await request(
        pageEvent([
          {
            ...textMessaging,
            message: {
              mid: 'm_img',
              attachments: [{ type: 'image', payload: { url: 'https://cdn.fbsbx.com/photo.jpg' } }],
            },
          },
        ]),
      ),
      CONFIG,
    )
    const message = events[0]?.message
    if (message?.kind !== 'image') throw new Error('expected an image')
    expect(message.attachments[0]?.sourceUrl).toBe('https://cdn.fbsbx.com/photo.jpg')
    expect(message.attachments[0]?.storageKey).toBeNull()
  })

  test('treats a sticker as a sticker rather than a photograph', async () => {
    const events = messengerChannelAdapter.parseInbound(
      await request(
        pageEvent([
          {
            ...textMessaging,
            message: {
              mid: 'm_sticker',
              attachments: [
                {
                  type: 'image',
                  payload: {
                    url: 'https://cdn.fbsbx.com/thumbsup.png',
                    sticker_id: 369239263222822,
                  },
                },
              ],
            },
          },
        ]),
      ),
      CONFIG,
    )
    const message = events[0]?.message
    if (message?.kind !== 'sticker') throw new Error('expected a sticker')
    expect(message.stickerId).toBe('369239263222822')
  })

  test('carries the payload of a tapped quick reply', async () => {
    const events = messengerChannelAdapter.parseInbound(
      await request(
        pageEvent([
          {
            ...textMessaging,
            message: {
              mid: 'm_qr',
              text: 'Book now',
              quick_reply: { payload: 'action=book' },
            },
          },
        ]),
      ),
      CONFIG,
    )
    const message = events[0]?.message
    if (message?.kind !== 'event') throw new Error('expected an event')
    expect(message.event).toBe('postback')
    expect(message.data.payload).toBe('action=book')
  })

  test('captures a postback from a button', async () => {
    const events = messengerChannelAdapter.parseInbound(
      await request(
        pageEvent([
          {
            sender: { id: PSID },
            recipient: { id: CONFIG.pageId },
            timestamp: 1_789_000_000_100,
            postback: { mid: 'm_pb', title: 'Get started', payload: 'GET_STARTED' },
          },
        ]),
      ),
      CONFIG,
    )
    const message = events[0]?.message
    if (message?.kind !== 'event') throw new Error('expected an event')
    expect(message.data.payload).toBe('GET_STARTED')
  })

  test('captures where an ad-sourced conversation came from', async () => {
    const events = messengerChannelAdapter.parseInbound(
      await request(
        pageEvent([
          {
            sender: { id: PSID },
            recipient: { id: CONFIG.pageId },
            timestamp: 1_789_000_000_200,
            referral: { ref: 'promo-songkran', source: 'ADS', type: 'OPEN_THREAD' },
          },
        ]),
      ),
      CONFIG,
    )
    const message = events[0]?.message
    if (message?.kind !== 'event') throw new Error('expected an event')
    expect(message.event).toBe('referral')
    expect(message.data.ref).toBe('promo-songkran')
  })

  test("ignores an echo of the page's own message", async () => {
    const events = messengerChannelAdapter.parseInbound(
      await request(
        pageEvent([
          {
            sender: { id: CONFIG.pageId },
            recipient: { id: PSID },
            timestamp: 1_789_000_000_300,
            message: { mid: 'm_echo', text: 'our own reply', is_echo: true },
          },
        ]),
      ),
      CONFIG,
    )
    expect(events).toHaveLength(0)
  })

  test('ignores a payload that is not a page subscription', async () => {
    expect(
      messengerChannelAdapter.parseInbound(
        await request({ object: 'instagram', entry: [] }),
        CONFIG,
      ),
    ).toHaveLength(0)
  })

  test('normalises every messaging entry across every batch', async () => {
    const events = messengerChannelAdapter.parseInbound(
      await request({
        object: 'page',
        entry: [
          { id: CONFIG.pageId, time: 1, messaging: [textMessaging] },
          {
            id: CONFIG.pageId,
            time: 2,
            messaging: [{ ...textMessaging, message: { mid: 'm_two', text: 'second' } }],
          },
        ],
      }),
      CONFIG,
    )
    expect(events.map((e) => e.platformEventId)).toEqual(['m_abc123', 'm_two'])
  })
})

describe('the customer-service window', () => {
  test('is declared as 24 hours', () => {
    expect(messengerChannelAdapter.capabilities.messagingWindowHours).toBe(24)
  })

  test('refuses to send after it closes, with an explanation rather than a code', async () => {
    await expect(
      messengerChannelAdapter.send(PSID, { kind: 'text', text: 'too late' }, CONFIG, {
        messagingWindowExpiresAt: new Date(Date.now() - 1000),
      }),
    ).rejects.toThrow(/24-hour Messenger reply window has closed/)
  })
})

describe('capabilities and config', () => {
  test("declares Messenger's real text limit", () => {
    expect(messengerChannelAdapter.capabilities.maxTextLength).toBe(2000)
  })

  test('requires the app secret, page id and token', () => {
    expect(() => messengerChannelAdapter.parseConfig({ appSecret: 'only' })).toThrow()
    expect(messengerChannelAdapter.parseConfig(CONFIG)).toEqual(CONFIG)
  })

  test('defaults the Graph version so an upgrade is a settings change', () => {
    const parsed = messengerChannelAdapter.parseConfig({
      appSecret: 'a',
      pageId: 'b',
      pageAccessToken: 'c',
    })
    expect(parsed.graphVersion).toMatch(/^v\d+\.\d+$/)
  })
})

describe('checking credentials', () => {
  const realFetch = globalThis.fetch

  /** Answers per Graph path, so each permission can be granted or withheld separately. */
  function stubGraph(routes: Record<string, [number, unknown]>) {
    const impl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      for (const [fragment, [status, body]] of Object.entries(routes)) {
        if (url.includes(fragment)) return Response.json(body as object, { status })
      }
      return Response.json({ error: { message: 'unexpected path' } }, { status: 404 })
    }
    ;(impl as unknown as { preconnect: () => void }).preconnect = () => {}
    globalThis.fetch = impl as unknown as typeof fetch
  }

  const PERMISSION_ERROR = {
    error: {
      message:
        "(#100) Object does not exist, cannot be loaded due to missing permission or reviewable feature, or does not support this operation. This endpoint requires the 'pages_read_engagement' permission",
    },
  }

  test('accepts a token that can send, even when it cannot read the page name', async () => {
    // The real case from the pilot. `pages_read_engagement` is not a permission a messaging
    // integration uses, and demanding it reported a perfectly good token as rejected.
    stubGraph({
      messenger_profile: [200, { data: [] }],
      'fields=name': [400, PERMISSION_ERROR],
    })

    const result = await messengerChannelAdapter.checkCredentials?.(CONFIG)

    expect(result?.ok).toBe(true)
    expect(result?.detail).toContain('pages_read_engagement')
    globalThis.fetch = realFetch
  })

  test('names the page when the token may read it', async () => {
    stubGraph({
      messenger_profile: [200, { data: [] }],
      'fields=name': [200, { name: 'Run Time Leb' }],
    })

    const result = await messengerChannelAdapter.checkCredentials?.(CONFIG)

    expect(result?.ok).toBe(true)
    expect(result?.detail).toContain('Run Time Leb')
    globalThis.fetch = realFetch
  })

  test('rejects a token that cannot send', async () => {
    stubGraph({
      messenger_profile: [
        400,
        { error: { message: '(#200) This endpoint requires the pages_messaging permission' } },
      ],
    })

    const result = await messengerChannelAdapter.checkCredentials?.(CONFIG)

    expect(result?.ok).toBe(false)
    expect(result?.detail).toContain('pages_messaging')
    globalThis.fetch = realFetch
  })

  test('reports an unreachable Meta rather than throwing', async () => {
    const impl = async () => {
      throw new Error('getaddrinfo ENOTFOUND graph.facebook.com')
    }
    ;(impl as unknown as { preconnect: () => void }).preconnect = () => {}
    globalThis.fetch = impl as unknown as typeof fetch

    const result = await messengerChannelAdapter.checkCredentials?.(CONFIG)

    expect(result?.ok).toBe(false)
    expect(result?.detail).toContain('ENOTFOUND')
    globalThis.fetch = realFetch
  })
})

/**
 * Sending a file, which the adapter declared it could do since it was written and could
 * not until now. Nothing here had ever asserted an outbound message that was not text.
 */
describe('sending media', () => {
  const realFetch = globalThis.fetch

  /** Captures what would have gone to Graph, and answers as Graph would. */
  function captureSends(): { bodies: unknown[] } {
    const bodies: unknown[] = []
    const impl = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')))
      return Response.json({ message_id: 'mid.1' }, { status: 200 })
    }
    ;(impl as unknown as { preconnect: () => void }).preconnect = () => {}
    globalThis.fetch = impl as unknown as typeof fetch
    return { bodies }
  }

  const attachment = (mime: string) => ({
    storageKey: 'ws/file',
    sourceUrl: 'https://chat.example.com/api/media/tok/receipt.pdf',
    mime,
    sizeBytes: 12,
    fileName: 'receipt.pdf',
    width: null,
    height: null,
    durationMs: null,
  })

  test('sends a document as a file attachment rather than as an apology', async () => {
    const captured = captureSends()
    try {
      await messengerChannelAdapter.send(
        'psid-1',
        { kind: 'file', text: null, attachments: [attachment('application/pdf')] },
        CONFIG,
        { messagingWindowExpiresAt: new Date(Date.now() + 3600_000) },
      )
    } finally {
      globalThis.fetch = realFetch
    }

    const payload = captured.bodies[0] as { message?: { attachment?: { type?: string } } }
    expect(payload.message?.attachment?.type).toBe('file')
  })

  test('sends the agent note before the file, rather than losing it', async () => {
    const captured = captureSends()
    try {
      await messengerChannelAdapter.send(
        'psid-1',
        { kind: 'file', text: 'your receipt', attachments: [attachment('application/pdf')] },
        CONFIG,
        { messagingWindowExpiresAt: new Date(Date.now() + 3600_000) },
      )
    } finally {
      globalThis.fetch = realFetch
    }

    expect(captured.bodies).toHaveLength(2)
    expect((captured.bodies[0] as { message?: { text?: string } }).message?.text).toBe(
      'your receipt',
    )
  })

  test('falls back to words when there is no link to fetch', async () => {
    const captured = captureSends()
    try {
      await messengerChannelAdapter.send(
        'psid-1',
        {
          kind: 'file',
          text: 'could not attach',
          attachments: [{ ...attachment('application/pdf'), sourceUrl: null }],
        },
        CONFIG,
        { messagingWindowExpiresAt: new Date(Date.now() + 3600_000) },
      )
    } finally {
      globalThis.fetch = realFetch
    }

    expect((captured.bodies[0] as { message?: { text?: string } }).message?.text).toBe(
      'could not attach',
    )
  })
})
