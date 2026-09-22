import { describe, expect, test } from 'bun:test'
import type { webhook } from '@line/bot-sdk'
import { type LineConfig, lineChannelAdapter, toLineMessages } from '../src/adapters/line'
import { signBodyBase64 } from '../src/signature'
import type { WebhookRequest } from '../src/types'

/**
 * LINE adapter tests.
 *
 * The fixtures are typed as the SDK's own `webhook.CallbackRequest`, so a payload that LINE
 * would not send fails to compile. That is as close to a recorded payload as we can get
 * without an Official Account: it proves the adapter agrees with the published schema, not
 * that it agrees with production. Real payloads should be captured on staging and added
 * here once an account exists.
 */

const CONFIG: LineConfig = {
  channelSecret: 'line-channel-secret',
  channelAccessToken: 'line-access-token',
}

const USER_ID = 'U0123456789abcdef0123456789abcdef'

async function request(payload: webhook.CallbackRequest): Promise<WebhookRequest> {
  const rawBody = JSON.stringify(payload)
  return {
    rawBody,
    headers: { 'x-line-signature': await signBodyBase64(rawBody, CONFIG.channelSecret) },
    query: {},
  }
}

function callback(events: webhook.Event[]): webhook.CallbackRequest {
  return { destination: 'U99999999999999999999999999999999', events }
}

const textEvent: webhook.MessageEvent = {
  type: 'message',
  mode: 'active',
  timestamp: 1_789_000_000_000,
  webhookEventId: '01HZZZTEXT',
  deliveryContext: { isRedelivery: false },
  source: { type: 'user', userId: USER_ID },
  replyToken: 'reply-token-abc',
  message: { type: 'text', id: '500000000001', text: 'ราคาเท่าไหร่คะ', quoteToken: 'q1' },
}

describe('signature verification', () => {
  test('accepts a correctly signed payload', async () => {
    const req = await request(callback([textEvent]))
    expect(await lineChannelAdapter.verifyWebhook(req, CONFIG)).toBe(true)
  })

  test('rejects a payload signed with the wrong secret', async () => {
    const payload = callback([textEvent])
    const rawBody = JSON.stringify(payload)
    const req: WebhookRequest = {
      rawBody,
      headers: { 'x-line-signature': await signBodyBase64(rawBody, 'wrong-secret') },
      query: {},
    }
    expect(await lineChannelAdapter.verifyWebhook(req, CONFIG)).toBe(false)
  })

  test('rejects a payload with no signature header', async () => {
    const req = await request(callback([textEvent]))
    expect(await lineChannelAdapter.verifyWebhook({ ...req, headers: {} }, CONFIG)).toBe(false)
  })

  test('rejects a body altered after signing, including Thai text', async () => {
    const req = await request(callback([textEvent]))
    const tampered = { ...req, rawBody: req.rawBody.replace('ราคาเท่าไหร่คะ', 'ฟรีไหมคะ') }
    expect(await lineChannelAdapter.verifyWebhook(tampered, CONFIG)).toBe(false)
  })
})

describe('inbound messages', () => {
  test('normalises a Thai text message and keeps the reply token', async () => {
    const events = lineChannelAdapter.parseInbound(await request(callback([textEvent])), CONFIG)

    expect(events).toHaveLength(1)
    expect(events[0]?.externalId).toBe(USER_ID)
    expect(events[0]?.message).toEqual({ kind: 'text', text: 'ราคาเท่าไหร่คะ' })
    expect(events[0]?.replyToken).toBe('reply-token-abc')
    expect(events[0]?.platformEventId).toBe('01HZZZTEXT')
    expect(events[0]?.timestamp.getTime()).toBe(1_789_000_000_000)
  })

  test('records an image as a reference to fetch rather than bytes', async () => {
    const imageEvent: webhook.MessageEvent = {
      ...textEvent,
      webhookEventId: '01HZZZIMAGE',
      message: {
        type: 'image',
        id: '500000000002',
        contentProvider: { type: 'line' },
        quoteToken: 'qi1',
      },
    }
    const events = lineChannelAdapter.parseInbound(await request(callback([imageEvent])), CONFIG)
    const message = events[0]?.message

    expect(message?.kind).toBe('image')
    if (message?.kind !== 'image') throw new Error('expected an image')
    expect(message.attachments[0]?.storageKey).toBeNull()
    expect(message.attachments[0]?.sourceUrl).toBe('line:500000000002')
  })

  test("carries a sticker's keywords, which is what the AI reads", async () => {
    const stickerEvent: webhook.MessageEvent = {
      ...textEvent,
      webhookEventId: '01HZZZSTICKER',
      message: {
        type: 'sticker',
        id: '500000000003',
        packageId: '446',
        stickerId: '1988',
        stickerResourceType: 'STATIC',
        keywords: ['thank you', 'ขอบคุณ'],
        quoteToken: 'qs1',
      },
    }
    const events = lineChannelAdapter.parseInbound(await request(callback([stickerEvent])), CONFIG)
    const message = events[0]?.message
    if (message?.kind !== 'sticker') throw new Error('expected a sticker')
    expect(message.keywords).toEqual(['thank you', 'ขอบคุณ'])
    expect(message.packageId).toBe('446')
  })

  test('normalises a location', async () => {
    const locationEvent: webhook.MessageEvent = {
      ...textEvent,
      webhookEventId: '01HZZZLOC',
      message: {
        type: 'location',
        id: '500000000004',
        title: 'ร้านทำผม',
        address: 'เชียงใหม่',
        latitude: 18.7883,
        longitude: 98.9853,
      },
    }
    const events = lineChannelAdapter.parseInbound(await request(callback([locationEvent])), CONFIG)
    const message = events[0]?.message
    if (message?.kind !== 'location') throw new Error('expected a location')
    expect(message.address).toBe('เชียงใหม่')
    expect(message.latitude).toBeCloseTo(18.7883, 4)
  })

  test('turns a follow into a channel event', async () => {
    const followEvent: webhook.FollowEvent = {
      type: 'follow',
      mode: 'active',
      timestamp: 1_789_000_000_100,
      webhookEventId: '01HZZZFOLLOW',
      deliveryContext: { isRedelivery: false },
      source: { type: 'user', userId: USER_ID },
      replyToken: 'reply-follow',
      follow: { isUnblocked: false },
    }
    const events = lineChannelAdapter.parseInbound(await request(callback([followEvent])), CONFIG)
    expect(events[0]?.message).toEqual({ kind: 'event', event: 'follow', data: {} })
  })

  test('turns a postback into a channel event carrying its payload', async () => {
    const postbackEvent: webhook.PostbackEvent = {
      type: 'postback',
      mode: 'active',
      timestamp: 1_789_000_000_200,
      webhookEventId: '01HZZZPOST',
      deliveryContext: { isRedelivery: false },
      source: { type: 'user', userId: USER_ID },
      replyToken: 'reply-postback',
      postback: { data: 'action=book&staff=nok' },
    }
    const events = lineChannelAdapter.parseInbound(await request(callback([postbackEvent])), CONFIG)
    const message = events[0]?.message
    if (message?.kind !== 'event') throw new Error('expected an event')
    expect(message.event).toBe('postback')
    expect(message.data.payload).toBe('action=book&staff=nok')
  })

  test('ignores group messages, which have no single customer', async () => {
    const groupEvent: webhook.MessageEvent = {
      ...textEvent,
      webhookEventId: '01HZZZGROUP',
      source: { type: 'group', groupId: 'C1234567890abcdef1234567890abcdef' },
    }
    expect(
      lineChannelAdapter.parseInbound(await request(callback([groupEvent])), CONFIG),
    ).toHaveLength(0)
  })

  test('handles the empty verification payload LINE sends when testing a webhook', async () => {
    expect(lineChannelAdapter.parseInbound(await request(callback([])), CONFIG)).toHaveLength(0)
  })

  test('normalises every event in a batch', async () => {
    const second: webhook.MessageEvent = {
      ...textEvent,
      webhookEventId: '01HZZZSECOND',
      message: { type: 'text', id: '500000000009', text: 'อีกข้อความค่ะ', quoteToken: 'q2' },
    }
    const events = lineChannelAdapter.parseInbound(
      await request(callback([textEvent, second])),
      CONFIG,
    )
    expect(events).toHaveLength(2)
    expect(events.map((e) => e.platformEventId)).toEqual(['01HZZZTEXT', '01HZZZSECOND'])
  })
})

describe('capabilities and config', () => {
  test("declares LINE's real text limit", () => {
    expect(lineChannelAdapter.capabilities.maxTextLength).toBe(5000)
    expect(lineChannelAdapter.capabilities.supportsQuickReplies).toBe(true)
    // LINE has no customer-service window; the reply token governs free replies instead.
    expect(lineChannelAdapter.capabilities.messagingWindowHours).toBeNull()
  })

  test('requires both credentials', () => {
    expect(() => lineChannelAdapter.parseConfig({ channelSecret: 'only-one' })).toThrow()
    expect(() => lineChannelAdapter.parseConfig({})).toThrow()
    expect(lineChannelAdapter.parseConfig(CONFIG)).toEqual(CONFIG)
  })
})

/**
 * Sending media, which nothing here had ever asserted.
 *
 * LINE has no document message: its outbound types are text, sticker, image, video, audio,
 * location, imagemap, template and flex. A file therefore has to reach the customer as a
 * link, and what matters is that it reaches them at all rather than as the literal words
 * "[unsupported message]", which is what it used to send.
 */
describe('sending media', () => {
  const attachment = (mime: string, url: string | null) => ({
    storageKey: 'ws/file',
    sourceUrl: url,
    mime,
    sizeBytes: 12,
    fileName: 'receipt.pdf',
    width: null,
    height: null,
    durationMs: null,
  })

  const LINK = 'https://chat.example.com/api/media/tok/receipt.pdf'

  test('sends an image as an image', () => {
    const messages = toLineMessages({
      kind: 'image',
      text: null,
      attachments: [attachment('image/png', LINK)],
    })

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ type: 'image', originalContentUrl: LINK })
  })

  test('sends the note before the image, because a LINE image carries no caption', () => {
    const messages = toLineMessages({
      kind: 'image',
      text: 'here is the receipt',
      attachments: [attachment('image/png', LINK)],
    })

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ type: 'text', text: 'here is the receipt' })
    expect(messages[1]).toMatchObject({ type: 'image' })
  })

  test('offers a document as a card with a button, since LINE cannot carry the file', () => {
    const messages = toLineMessages(
      {
        kind: 'file',
        text: 'your invoice',
        attachments: [attachment('application/pdf', LINK)],
      },
      'th',
    )

    // The note first, then the card: a LINE message carries no caption of its own.
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ type: 'text', text: 'your invoice' })

    const card = messages[1] as {
      type: string
      altText: string
      contents: { footer: { contents: { action: { uri: string; label: string } }[] } }
    }
    expect(card.type).toBe('flex')
    expect(card.contents.footer.contents[0]?.action.uri).toBe(LINK)
    expect(card.contents.footer.contents[0]?.action.label).toBe('เปิดไฟล์')

    /**
     * A client too old for Flex shows only this, so it has to carry the link or the message
     * is a dead end for exactly the people least able to work around it.
     */
    expect(card.altText).toContain(LINK)
    expect(card.altText).toContain('receipt.pdf')
    expect(card.altText.length).toBeLessThanOrEqual(400)
  })

  test('labels the button in English for an English-speaking customer', () => {
    const messages = toLineMessages(
      { kind: 'file', text: null, attachments: [attachment('application/pdf', LINK)] },
      'en',
    )
    const card = messages[0] as {
      contents: { footer: { contents: { action: { label: string } }[] } }
    }
    expect(card.contents.footer.contents[0]?.action.label).toBe('Open file')
  })

  test('names the file and its kind on the card', () => {
    const messages = toLineMessages(
      { kind: 'file', text: null, attachments: [attachment('application/pdf', LINK)] },
      'th',
    )
    const card = messages[0] as {
      contents: { body: { contents: { text: string }[] } }
    }
    expect(card.contents.body.contents[0]?.text).toBe('receipt.pdf')
    expect(card.contents.body.contents[1]?.text).toBe('PDF')
  })

  test('says something useful when there is no link to send', () => {
    const messages = toLineMessages({
      kind: 'file',
      text: 'could not attach',
      attachments: [attachment('application/pdf', null)],
    })
    expect(messages[0]).toMatchObject({ type: 'text', text: 'could not attach' })
  })
})
