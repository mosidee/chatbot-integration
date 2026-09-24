import { z } from 'zod'

/**
 * The normalised message model.
 *
 * Every channel adapter translates its platform payload INTO this shape on the way in,
 * and OUT of this shape on the way out. Nothing downstream (core, worker, GUI) ever sees
 * a platform-specific payload. Adding a channel means writing one adapter, not touching
 * the domain.
 */

export const attachmentSchema = z.object({
  /** Key in object storage. Absent until the inbound job has downloaded the media. */
  storageKey: z.string().nullable().default(null),
  /** Original URL on the platform's CDN. Often short-lived, so we download eagerly. */
  sourceUrl: z.string().nullable().default(null),
  mime: z.string().default('application/octet-stream'),
  sizeBytes: z.number().int().nonnegative().nullable().default(null),
  fileName: z.string().nullable().default(null),
  width: z.number().int().positive().nullable().default(null),
  height: z.number().int().positive().nullable().default(null),
  durationMs: z.number().int().nonnegative().nullable().default(null),
})
export type Attachment = z.infer<typeof attachmentSchema>

export const quickReplyItemSchema = z.object({
  /** Shown to the customer. */
  label: z.string().min(1).max(20),
  /** Sent back to us when tapped. Adapters map this to postback data / payload. */
  payload: z.string().min(1).max(1000),
})
export type QuickReplyItem = z.infer<typeof quickReplyItemSchema>

export const channelEventKindSchema = z.enum([
  'follow',
  'unfollow',
  'postback',
  'read',
  'delivered',
  'unsend',
  'join',
  'leave',
  'optin',
  'referral',
])
export type ChannelEventKind = z.infer<typeof channelEventKindSchema>

const textMessage = z.object({
  kind: z.literal('text'),
  text: z.string(),
})

const mediaMessage = z.object({
  kind: z.enum(['image', 'file', 'audio', 'video']),
  /** Optional caption; LINE/Messenger rarely provide one but the widget does. */
  text: z.string().nullable().default(null),
  attachments: z.array(attachmentSchema).min(1),
})

const stickerMessage = z.object({
  kind: z.literal('sticker'),
  packageId: z.string().nullable().default(null),
  stickerId: z.string().nullable().default(null),
  /** Words the platform associates with the sticker; used as the AI's text stand-in. */
  keywords: z.array(z.string()).default([]),
})

const locationMessage = z.object({
  kind: z.literal('location'),
  latitude: z.number(),
  longitude: z.number(),
  address: z.string().nullable().default(null),
  title: z.string().nullable().default(null),
})

const quickRepliesMessage = z.object({
  kind: z.literal('quick_replies'),
  text: z.string(),
  items: z.array(quickReplyItemSchema).min(1).max(13),
})

/**
 * Placeholder for LINE Flex / Messenger generic templates (M3+) and for
 * WhatsApp's pre-approved templates, which are the only thing sendable
 * outside the customer-service window.
 */
const templateMessage = z.object({
  kind: z.literal('template'),
  /** Channel-neutral card description; adapters render per platform. */
  templateName: z.string().nullable().default(null),
  altText: z.string(),
  cards: z
    .array(
      z.object({
        title: z.string(),
        subtitle: z.string().nullable().default(null),
        imageUrl: z.string().nullable().default(null),
        buttons: z.array(quickReplyItemSchema).default([]),
      }),
    )
    .default([]),
  variables: z.record(z.string(), z.string()).default({}),
})

const eventMessage = z.object({
  kind: z.literal('event'),
  event: channelEventKindSchema,
  /** Postback payload, referral ref, unsent message id, etc. */
  data: z.record(z.string(), z.unknown()).default({}),
})

export const normalizedMessageSchema = z.discriminatedUnion('kind', [
  textMessage,
  mediaMessage,
  stickerMessage,
  locationMessage,
  quickRepliesMessage,
  templateMessage,
  eventMessage,
])
export type NormalizedMessage = z.infer<typeof normalizedMessageSchema>

/**
 * Plain-text stand-in used for prompts, previews and search.
 * Never send this to a customer; it is a lossy summary for machines and list views.
 */
export function messageToText(message: NormalizedMessage): string {
  switch (message.kind) {
    case 'text':
      return message.text
    case 'image':
    case 'file':
    case 'audio':
    case 'video': {
      const names = message.attachments.map((a) => a.fileName).filter(Boolean)
      const label = names.length > 0 ? ` (${names.join(', ')})` : ''
      return message.text ?? `[${message.kind}${label}]`
    }
    case 'sticker':
      return message.keywords.length > 0 ? `[sticker: ${message.keywords.join(', ')}]` : '[sticker]'
    case 'location':
      return `[location: ${message.address ?? `${message.latitude},${message.longitude}`}]`
    case 'quick_replies':
      return message.text
    case 'template':
      return message.altText
    case 'event':
      return `[event: ${message.event}]`
  }
}

/**
 * What the sender actually typed, or null.
 *
 * `messageToText` renders a photo as `[image]` and a sticker as `[sticker]` for the thread
 * and the prompt. Those are our words, in English, and treating them as evidence of the
 * customer's language answered a Thai customer's photo with an English handoff message.
 */
export function typedText(message: NormalizedMessage): string | null {
  switch (message.kind) {
    case 'text':
    case 'quick_replies':
    case 'image':
    case 'file':
    case 'audio':
    case 'video':
      return message.text
    default:
      return null
  }
}

/** True when the message carries at least one image the vision slot could describe. */
export function hasImages(message: NormalizedMessage): boolean {
  return message.kind === 'image' && message.attachments.length > 0
}
