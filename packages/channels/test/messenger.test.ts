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
