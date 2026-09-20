import type { NormalizedMessage } from '@ci/shared'
import { messagingApi, type webhook } from '@line/bot-sdk'
import { z } from 'zod'
import { verifyLineSignature } from '../signature'
import { splitText } from '../text'
import type {
  ChannelAdapter,
  ChannelProfile,
  InboundEvent,
  SendContext,
  SendResult,
  WebhookRequest,
} from '../types'

/**
 * LINE Messaging API.
 *
 * Two details drive most of this adapter.
 *
 * **Reply tokens.** A webhook event carries a token that lets us answer for free, but it is
 * single-use and expires about a minute after the event. Our pipeline is asynchronous, so
 * the token is carried forward on the conversation and used only while it is still fresh.
 * Everything else is a push, which counts against the account's monthly quota.
 *
 * **Media is a reference, not bytes.** An image arrives as a message id; the content must be
 * fetched separately from the blob endpoint. The worker does that before the AI turn runs,
 * so a vision model has something to look at.
 */

const configSchema = z.object({
  channelSecret: z.string().min(1),
  channelAccessToken: z.string().min(1),
})
export type LineConfig = z.infer<typeof configSchema>

/** LINE's own limit for a single text message. */
const MAX_TEXT_LENGTH = 5000

function clientFor(config: LineConfig): messagingApi.MessagingApiClient {
  return new messagingApi.MessagingApiClient({ channelAccessToken: config.channelAccessToken })
}

function blobClientFor(config: LineConfig): messagingApi.MessagingApiBlobClient {
  return new messagingApi.MessagingApiBlobClient({
    channelAccessToken: config.channelAccessToken,
  })
}

/** A LINE event only concerns us when it comes from a single user, not a group or room. */
function userIdOf(source: webhook.Source | undefined): string | null {
  if (!source) return null
  const withUser = source as { userId?: string }
  return withUser.userId ?? null
}

function attachmentPlaceholder(
  mime: string,
): NormalizedMessage['kind'] extends never ? never : 'image' | 'file' | 'audio' | 'video' {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  return 'file'
}

/**
 * Media arrives as a message id. The attachment is recorded with that id in `sourceUrl`
 * under a `line:` scheme, and the worker exchanges it for bytes; `storageKey` stays null
 * until then.
 */
function mediaMessage(
  kind: 'image' | 'audio' | 'video' | 'file',
  messageId: string,
  mime: string,
  fileName: string | null,
  sizeBytes: number | null,
): NormalizedMessage {
  return {
    kind,
    text: null,
    attachments: [
      {
        storageKey: null,
        sourceUrl: `line:${messageId}`,
        mime,
        sizeBytes,
        fileName,
        width: null,
        height: null,
        durationMs: null,
      },
    ],
  }
}

function toNormalized(event: webhook.Event): NormalizedMessage | null {
  switch (event.type) {
    case 'message': {
      const message = (event as webhook.MessageEvent).message
      switch (message.type) {
        case 'text':
          return { kind: 'text', text: (message as webhook.TextMessageContent).text }

        case 'image':
          return mediaMessage('image', message.id, 'image/jpeg', null, null)

        case 'video':
          return mediaMessage('video', message.id, 'video/mp4', null, null)

        case 'audio':
          return mediaMessage('audio', message.id, 'audio/m4a', null, null)

        case 'file': {
          const file = message as webhook.FileMessageContent
          return mediaMessage(
            'file',
            message.id,
            'application/octet-stream',
            file.fileName ?? null,
            file.fileSize ?? null,
          )
        }

        case 'sticker': {
          const sticker = message as webhook.StickerMessageContent
          return {
            kind: 'sticker',
            packageId: sticker.packageId ?? null,
            stickerId: sticker.stickerId ?? null,
            // LINE supplies the words behind a sticker, which is what the AI reads.
            keywords: sticker.keywords ?? [],
          }
        }

        case 'location': {
          const location = message as webhook.LocationMessageContent
          return {
            kind: 'location',
            latitude: location.latitude ?? 0,
            longitude: location.longitude ?? 0,
            address: location.address ?? null,
            title: location.title ?? null,
          }
        }

        default:
          return null
      }
    }

    case 'follow':
      return { kind: 'event', event: 'follow', data: {} }

    case 'unfollow':
      return { kind: 'event', event: 'unfollow', data: {} }

    case 'join':
      return { kind: 'event', event: 'join', data: {} }

    case 'leave':
      return { kind: 'event', event: 'leave', data: {} }

    case 'postback': {
      const postback = (event as webhook.PostbackEvent).postback
      return {
        kind: 'event',
        event: 'postback',
        data: { payload: postback?.data ?? '', params: postback?.params ?? {} },
      }
    }

    case 'unsend': {
      const unsend = (event as webhook.UnsendEvent).unsend
      return { kind: 'event', event: 'unsend', data: { messageId: unsend?.messageId ?? '' } }
    }

    default:
      // Beacon, account link, membership and the rest are not part of a support conversation.
      return null
  }
}

/** Translate our outbound model into LINE's message objects. */
function toLineMessages(message: NormalizedMessage): messagingApi.Message[] {
  switch (message.kind) {
    case 'text':
      return splitText(message.text, MAX_TEXT_LENGTH).map((text) => ({ type: 'text', text }))

    case 'quick_replies':
      return [
        {
          type: 'text',
          text: message.text.slice(0, MAX_TEXT_LENGTH),
          quickReply: {
            // LINE allows at most 13 items.
            items: message.items.slice(0, 13).map((item) => ({
              type: 'action',
              action: { type: 'postback', label: item.label, data: item.payload },
            })),
          },
        },
      ]

    case 'image': {
      // LINE needs publicly reachable HTTPS URLs for images it must fetch itself.
      const urls = message.attachments.flatMap((a) =>
        a.sourceUrl && a.sourceUrl.startsWith('http') ? [a.sourceUrl] : [],
      )
      if (urls.length === 0) {
        return [{ type: 'text', text: message.text ?? '[image]' }]
      }
      return urls.map((url) => ({
        type: 'image',
        originalContentUrl: url,
        previewImageUrl: url,
      }))
    }

    case 'template':
      return [{ type: 'text', text: message.altText.slice(0, MAX_TEXT_LENGTH) }]

    case 'file':
    case 'audio':
    case 'video':
    case 'location':
    case 'sticker':
      // Nothing outbound needs these yet; send the text stand-in rather than nothing.
      return [{ type: 'text', text: '[unsupported message]' }]

    case 'event':
      return []
  }
}

export const lineChannelAdapter: ChannelAdapter<LineConfig> = {
  type: 'line',

  capabilities: {
    maxTextLength: MAX_TEXT_LENGTH,
    supportsQuickReplies: true,
    supportsTemplates: true,
    supportsImages: true,
    supportsFiles: false,
    // LINE has no customer-service window; replies are limited by the reply token instead.
    messagingWindowHours: null,
  },

  parseConfig(raw) {
    return configSchema.parse(raw ?? {})
  },

  async verifyWebhook(request, config) {
    return verifyLineSignature(
      request.rawBody,
      config.channelSecret,
      request.headers['x-line-signature'],
    )
  },

  parseInbound(request: WebhookRequest): InboundEvent[] {
    const payload = JSON.parse(request.rawBody) as webhook.CallbackRequest
    const events: InboundEvent[] = []

    for (const event of payload.events ?? []) {
      const externalId = userIdOf(event.source)
      // Group and room conversations have no single customer to attribute this to.
      if (!externalId) continue

      const message = toNormalized(event)
      if (!message) continue

      const platformEventId =
        event.webhookEventId ??
        (event.type === 'message' ? (event as webhook.MessageEvent).message.id : null) ??
        `${externalId}-${event.timestamp}`

      events.push({
        platformEventId,
        externalId,
        message,
        timestamp: new Date(event.timestamp ?? Date.now()),
        ...(replyTokenOf(event) ? { replyToken: replyTokenOf(event) as string } : {}),
      })
    }

    return events
  },

  async send(
    externalId: string,
    message: NormalizedMessage,
    config: LineConfig,
    context: SendContext,
  ): Promise<SendResult> {
    const messages = toLineMessages(message)
    if (messages.length === 0) return { platformMessageId: null }

    const client = clientFor(config)

    // A reply is free; a push is billed. Use the token while it is still valid.
    if (context.replyToken) {
      try {
        await client.replyMessage({ replyToken: context.replyToken, messages })
        return { platformMessageId: null }
      } catch (error) {
        // An expired or already-used token is expected sometimes; fall through to a push
        // rather than losing the message.
        if (!isReplyTokenError(error)) throw error
      }
    }

    await client.pushMessage({ to: externalId, messages })
    return { platformMessageId: null }
  },

  async fetchProfile(externalId: string, config: LineConfig): Promise<ChannelProfile | null> {
    try {
      const profile = await clientFor(config).getProfile(externalId)
      return {
        displayName: profile.displayName ?? null,
        avatarUrl: profile.pictureUrl ?? null,
        raw: { language: profile.language, statusMessage: profile.statusMessage },
      }
    } catch {
      // A customer who has blocked the account has no readable profile.
      return null
    }
  },

  async checkCredentials(config: LineConfig) {
    try {
      const quota = await clientFor(config).getMessageQuota()
      return {
        ok: true,
        detail: 'The access token works.',
        info: {
          quotaType: quota.type ?? 'unknown',
          ...(quota.value !== undefined ? { monthlyLimit: quota.value } : {}),
        },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        // The channel secret cannot be checked here: it is only exercised when LINE signs
        // a real webhook, so a wrong secret shows up as rejected deliveries instead.
        detail: `LINE rejected the access token: ${message.slice(0, 200)}`,
      }
    }
  },

  async fetchMedia(reference: string, config: LineConfig) {
    const messageId = reference.startsWith('line:') ? reference.slice('line:'.length) : reference
    const blob = await blobClientFor(config).getMessageContent(messageId)
    const buffer = await new Response(blob as unknown as ReadableStream).arrayBuffer()
    const data = new Uint8Array(new ArrayBuffer(buffer.byteLength))
    data.set(new Uint8Array(buffer))
    return { data, mime: 'application/octet-stream' }
  },
}

/** Only some event types carry a reply token; the union does not declare it on all of them. */
function replyTokenOf(event: webhook.Event): string | null {
  return (event as { replyToken?: string }).replyToken ?? null
}

function isReplyTokenError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /reply token|400/i.test(message)
}
