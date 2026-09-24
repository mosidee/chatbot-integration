import type { NormalizedMessage } from '@ci/shared'
import { z } from 'zod'
import { verifyMetaSignature } from '../signature'
import { splitText } from '../text'
import type {
  ChannelAdapter,
  ChannelProfile,
  InboundEvent,
  SendContext,
  SendResult,
  WebhookRequest,
} from '../types'
import { UncertainDeliveryError } from '../types'

/**
 * Facebook Messenger, through the Graph API.
 *
 * Meta publishes no Node SDK, so this speaks the HTTP API directly. Two constraints shape it:
 *
 * **The customer-service window.** A page may reply freely for 24 hours after the customer's
 * last message. Outside it, only a pre-approved message tag is allowed. The window is
 * recorded on the conversation at ingestion so an agent can see it closing rather than
 * discovering it from a rejected send.
 *
 * **Attachments are CDN links that expire.** The URL in a webhook works for days, not
 * forever, so the worker downloads the bytes before they go stale.
 */

const configSchema = z.object({
  /** Verifies webhook signatures. From the Meta app, not the page. */
  appSecret: z.string().min(1),
  /** The page this channel serves. Outbound messages are sent as this page. */
  pageId: z.string().min(1),
  /** Long-lived page access token. */
  pageAccessToken: z.string().min(1),
  /** Graph API version, so an upgrade is a settings change rather than a deploy. */
  graphVersion: z.string().default('v26.0'),
})
export type MessengerConfig = z.infer<typeof configSchema>

/** A friendly page name when the token may read it, and null when it may not. */
async function pageName(config: MessengerConfig): Promise<string | null> {
  try {
    const response = await fetch(`${graphUrl(config, config.pageId)}?fields=name`, {
      headers: { authorization: `Bearer ${config.pageAccessToken}` },
    })
    if (!response.ok) return null
    const body = (await response.json()) as { name?: string }
    return body.name ?? null
  } catch {
    return null
  }
}

/** Messenger's limit for a single text message. */
const MAX_TEXT_LENGTH = 2000

/** A page may reply freely for 24 hours after the customer's last message. */
const MESSAGING_WINDOW_HOURS = 24

type MessengerAttachment = {
  type?: string
  payload?: { url?: string; sticker_id?: number | string; title?: string }
}

type MessagingEntry = {
  sender?: { id?: string }
  recipient?: { id?: string }
  timestamp?: number
  message?: {
    mid?: string
    text?: string
    attachments?: MessengerAttachment[]
    quick_reply?: { payload?: string }
    is_echo?: boolean
  }
  postback?: { mid?: string; title?: string; payload?: string; referral?: unknown }
  referral?: { ref?: string; source?: string; type?: string }
  read?: { watermark?: number }
  delivery?: { watermark?: number; mids?: string[] }
  optin?: { ref?: string }
}

type WebhookPayload = {
  object?: string
  entry?: { id?: string; time?: number; messaging?: MessagingEntry[] }[]
}

function graphUrl(config: MessengerConfig, path: string): string {
  return `https://graph.facebook.com/${config.graphVersion}/${path}`
}

function mediaKindFor(type: string | undefined): 'image' | 'audio' | 'video' | 'file' {
  if (type === 'image') return 'image'
  if (type === 'audio') return 'audio'
  if (type === 'video') return 'video'
  return 'file'
}

function mimeFor(kind: 'image' | 'audio' | 'video' | 'file'): string {
  switch (kind) {
    case 'image':
      return 'image/jpeg'
    case 'audio':
      return 'audio/mpeg'
    case 'video':
      return 'video/mp4'
    case 'file':
      return 'application/octet-stream'
  }
}

function toNormalized(entry: MessagingEntry): NormalizedMessage | null {
  if (entry.message) {
    // An echo is the page's own message coming back; we already stored it when we sent it.
    if (entry.message.is_echo) return null

    const attachments = entry.message.attachments ?? []

    // A Messenger sticker arrives as an image attachment with a sticker id. Treating it as
    // a sticker keeps the AI from trying to read a thumbs-up as a photograph.
    const sticker = attachments.find((a) => a.payload?.sticker_id !== undefined)
    if (sticker) {
      return {
        kind: 'sticker',
        packageId: null,
        stickerId: String(sticker.payload?.sticker_id ?? ''),
        keywords: [],
      }
    }

    if (attachments.length > 0) {
      const kind = mediaKindFor(attachments[0]?.type)
      const usable = attachments.flatMap((a) =>
        a.payload?.url ? [{ url: a.payload.url, title: a.payload.title ?? null }] : [],
      )
      if (usable.length === 0) {
        return { kind: 'text', text: entry.message.text ?? '[unsupported attachment]' }
      }
      return {
        kind,
        text: entry.message.text ?? null,
        attachments: usable.map((a) => ({
          storageKey: null,
          sourceUrl: a.url,
          mime: mimeFor(kind),
          sizeBytes: null,
          fileName: a.title,
          width: null,
          height: null,
          durationMs: null,
        })),
      }
    }

    // A tapped quick reply carries a payload as well as its visible text.
    if (entry.message.quick_reply?.payload) {
      return {
        kind: 'event',
        event: 'postback',
        data: { payload: entry.message.quick_reply.payload, text: entry.message.text ?? '' },
      }
    }

    if (typeof entry.message.text === 'string') {
      return { kind: 'text', text: entry.message.text }
    }
    return null
  }

  if (entry.postback) {
    return {
      kind: 'event',
      event: 'postback',
      data: {
        payload: entry.postback.payload ?? '',
        title: entry.postback.title ?? '',
      },
    }
  }

  if (entry.referral) {
    // Where the conversation came from: an ad, a QR code, a link with a ref parameter.
    return {
      kind: 'event',
      event: 'referral',
      data: {
        ref: entry.referral.ref ?? '',
        source: entry.referral.source ?? '',
        type: entry.referral.type ?? '',
      },
    }
  }

  if (entry.optin) {
    return { kind: 'event', event: 'optin', data: { ref: entry.optin.ref ?? '' } }
  }

  if (entry.read) {
    return { kind: 'event', event: 'read', data: { watermark: entry.read.watermark ?? 0 } }
  }

  if (entry.delivery) {
    return {
      kind: 'event',
      event: 'delivered',
      data: { watermark: entry.delivery.watermark ?? 0 },
    }
  }

  return null
}

type OutboundPayload = Record<string, unknown>

function toMessengerPayloads(message: NormalizedMessage): OutboundPayload[] {
  switch (message.kind) {
    case 'text':
      return splitText(message.text, MAX_TEXT_LENGTH).map((text) => ({ text }))

    case 'quick_replies':
      return [
        {
          text: message.text.slice(0, MAX_TEXT_LENGTH),
          // Messenger allows at most 13, with a 20-character title.
          quick_replies: message.items.slice(0, 13).map((item) => ({
            content_type: 'text',
            title: item.label.slice(0, 20),
            payload: item.payload,
          })),
        },
      ]

    case 'image': {
      const urls = message.attachments.flatMap((a) =>
        a.sourceUrl?.startsWith('http') ? [a.sourceUrl] : [],
      )
      if (urls.length === 0) return [{ text: message.text ?? '[image]' }]
      // A Messenger attachment carries no caption either, so the note goes first.
      return [
        ...(message.text ? [{ text: message.text }] : []),
        ...urls.map((url) => ({
          attachment: { type: 'image' as const, payload: { url, is_reusable: true } },
        })),
      ]
    }

    case 'template':
      return [{ text: message.altText.slice(0, MAX_TEXT_LENGTH) }]

    /**
     * Messenger does carry a document, with the same payload shape as an image. The flag
     * saying so has been true since the adapter was written; this is the branch that makes
     * it mean something.
     */
    case 'file': {
      const urls = message.attachments.flatMap((a) =>
        a.sourceUrl?.startsWith('http') ? [a.sourceUrl] : [],
      )
      if (urls.length === 0) return [{ text: message.text ?? '[file]' }]
      return [
        ...(message.text ? [{ text: message.text }] : []),
        ...urls.map((url) => ({
          attachment: { type: 'file' as const, payload: { url, is_reusable: true } },
        })),
      ]
    }

    case 'audio':
    case 'video':
    case 'location':
    case 'sticker':
      return [{ text: '[unsupported message]' }]

    case 'event':
      return []
  }
}

export const messengerChannelAdapter: ChannelAdapter<MessengerConfig> = {
  type: 'messenger',

  capabilities: {
    publicWebhook: true,
    maxTextLength: MAX_TEXT_LENGTH,
    supportsQuickReplies: true,
    supportsTemplates: true,
    supportsImages: true,
    supportsFiles: true,
    messagingWindowHours: MESSAGING_WINDOW_HOURS,
  },

  parseConfig(raw) {
    return configSchema.parse(raw ?? {})
  },

  async verifyWebhook(request, config) {
    return verifyMetaSignature(
      request.rawBody,
      config.appSecret,
      request.headers['x-hub-signature-256'],
    )
  },

  parseInbound(request: WebhookRequest, config: MessengerConfig): InboundEvent[] {
    const payload = JSON.parse(request.rawBody) as WebhookPayload
    if (payload.object !== 'page') return []

    const events: InboundEvent[] = []

    for (const entry of payload.entry ?? []) {
      for (const messaging of entry.messaging ?? []) {
        const externalId = messaging.sender?.id
        if (!externalId) continue
        // The page talking to itself, which happens with echoes.
        if (externalId === config.pageId) continue

        const message = toNormalized(messaging)
        if (!message) continue

        const timestamp = new Date(messaging.timestamp ?? Date.now())
        const platformEventId =
          messaging.message?.mid ??
          messaging.postback?.mid ??
          `${externalId}-${messaging.timestamp ?? Date.now()}`

        events.push({ platformEventId, externalId, message, timestamp })
      }
    }

    return events
  },

  async send(
    externalId: string,
    message: NormalizedMessage,
    config: MessengerConfig,
    context: SendContext,
  ): Promise<SendResult> {
    const payloads = toMessengerPayloads(message)
    if (payloads.length === 0) return { platformMessageId: null }

    // Outside the customer-service window a plain reply is rejected. Saying so plainly beats
    // a Graph error code an agent has to look up.
    const windowExpiry = context.messagingWindowExpiresAt
    if (windowExpiry && windowExpiry.getTime() < Date.now()) {
      throw new Error(
        'The 24-hour Messenger reply window has closed for this conversation. Only an approved message tag may be sent.',
      )
    }

    let lastMessageId: string | null = null

    for (const [index, payload] of payloads.entries()) {
      // Taken on an earlier attempt: sending it again would show the customer a duplicate.
      if (index < (context.startAt ?? 0)) continue

      let response: Response
      try {
        response = await fetch(graphUrl(config, `${config.pageId}/messages`), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.pageAccessToken}`,
          },
          body: JSON.stringify({
            recipient: { id: externalId },
            messaging_type: 'RESPONSE',
            message: payload,
          }),
        })
      } catch (error) {
        // No answer at all: Meta may have delivered it. Graph has no idempotency key, so
        // this is for a person to judge rather than for a retry to repeat.
        throw new UncertainDeliveryError(
          `Messenger did not answer, so it is unknown whether this was delivered: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`Messenger send failed (${response.status}): ${detail.slice(0, 300)}`)
      }

      const body = (await response.json()) as { message_id?: string }
      lastMessageId = body.message_id ?? lastMessageId
      await context.onUnitSent?.(index, body.message_id ?? null)
    }

    return { platformMessageId: lastMessageId }
  },

  async fetchProfile(externalId: string, config: MessengerConfig): Promise<ChannelProfile | null> {
    try {
      // The token goes in a header, not the query string: a URL ends up in proxy logs,
      // access logs and any intermediary's history.
      const response = await fetch(`${graphUrl(config, externalId)}?fields=name,profile_pic`, {
        headers: { authorization: `Bearer ${config.pageAccessToken}` },
      })
      if (!response.ok) return null
      const body = (await response.json()) as { name?: string; profile_pic?: string }
      return {
        displayName: body.name ?? null,
        avatarUrl: body.profile_pic ?? null,
        raw: {},
      }
    } catch {
      return null
    }
  },

  /**
   * Does this token let us do the one thing this channel is for: send messages?
   *
   * Reading the page's own name looks like the obvious check and is the wrong one. It needs
   * `pages_read_engagement`, which a messaging integration never uses, so a token that can
   * send perfectly well was reported as rejected. The messenger profile endpoint needs
   * `pages_messaging`, which is exactly the permission we depend on.
   *
   * The page name is still fetched, because "connected to <page>" is worth far more to an
   * operator than an id, but failing to read it is a missing nicety rather than a failure.
   */
  async checkCredentials(config: MessengerConfig) {
    try {
      const response = await fetch(`${graphUrl(config, 'me')}/messenger_profile?fields=greeting`, {
        headers: { authorization: `Bearer ${config.pageAccessToken}` },
      })
      const body = (await response.json()) as { error?: { message?: string } }

      if (!response.ok) {
        return {
          ok: false,
          detail: `Meta rejected the page token: ${body.error?.message ?? response.statusText}`,
        }
      }

      const name = await pageName(config)
      return {
        ok: true,
        detail: name
          ? `The token can send as "${name}".`
          : 'The token can send messages. Meta would not give us the page name, which needs the pages_read_engagement permission we do not otherwise use.',
        info: { page: name ?? config.pageId },
      }
    } catch (error) {
      return {
        ok: false,
        detail: `Could not reach Meta: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  },

  async fetchMedia(reference: string, _config: unknown, options?: { signal?: AbortSignal }) {
    // The webhook hands over a signed CDN URL; no token is needed, and it expires.
    const response = await fetch(reference, options?.signal ? { signal: options.signal } : {})
    if (!response.ok) throw new Error(`Media fetch failed with ${response.status}`)

    const buffer = await response.arrayBuffer()
    const data = new Uint8Array(new ArrayBuffer(buffer.byteLength))
    data.set(new Uint8Array(buffer))
    return {
      data,
      mime: response.headers.get('content-type') ?? 'application/octet-stream',
    }
  },
}
