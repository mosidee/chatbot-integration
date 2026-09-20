import type { ChannelType, NormalizedMessage } from '@ci/shared'

/**
 * The channel adapter contract.
 *
 * Every platform translates into the normalised message model on the way in and out of
 * this interface. Nothing downstream sees a platform payload, which is what makes adding
 * Instagram, Telegram, WhatsApp or TikTok a matter of writing one adapter rather than
 * touching the domain.
 */

export type ChannelCapabilities = {
  /** Longest single outbound text. The adapter splits anything longer. */
  maxTextLength: number
  supportsQuickReplies: boolean
  supportsTemplates: boolean
  supportsImages: boolean
  supportsFiles: boolean
  /**
   * Hours after the customer's last message during which free-form replies are allowed.
   * Null means no window applies. WhatsApp is 24; Messenger has policy windows.
   */
  messagingWindowHours: number | null
}

/** The raw HTTP request as the adapter needs to see it for signature verification. */
export type WebhookRequest = {
  rawBody: string
  headers: Record<string, string>
  query: Record<string, string>
}

/** One customer action, normalised. */
export type InboundEvent = {
  /** Platform-unique id. The idempotency key that stops webhook retries duplicating. */
  platformEventId: string
  /** Opaque platform user id: LINE userId, Messenger PSID, widget visitor id. */
  externalId: string
  message: NormalizedMessage
  timestamp: Date
  /** LINE reply tokens are single-use and short-lived; replying with one is free. */
  replyToken?: string
  /** Profile hints the platform included, saved on the channel identity. */
  profile?: { displayName?: string; avatarUrl?: string }
}

export type SendResult = {
  platformMessageId: string | null
}

export type SendContext = {
  /** Present when replying to a very recent inbound message. */
  replyToken?: string
  /** Null when no window applies or it has lapsed. */
  messagingWindowExpiresAt?: Date | null
}

export type ChannelProfile = {
  displayName: string | null
  avatarUrl: string | null
  raw: Record<string, unknown>
}

/**
 * Adapter config is whatever the platform needs, decrypted by the caller.
 * Each adapter validates its own shape with Zod.
 */
export type ChannelAdapter<TConfig = unknown> = {
  type: ChannelType
  capabilities: ChannelCapabilities
  /** Parse and validate the stored configuration blob. */
  parseConfig(raw: unknown): TConfig
  /**
   * Verify the request genuinely came from the platform.
   * Returning false must cause the webhook to be rejected without side effects.
   */
  verifyWebhook(request: WebhookRequest, config: TConfig): Promise<boolean>
  /** Answer a platform's subscription handshake, if it has one. */
  handleVerification?(request: WebhookRequest, config: TConfig): string | null
  parseInbound(request: WebhookRequest, config: TConfig): InboundEvent[]
  send(
    externalId: string,
    message: NormalizedMessage,
    config: TConfig,
    context: SendContext,
  ): Promise<SendResult>
  fetchProfile?(externalId: string, config: TConfig): Promise<ChannelProfile | null>
  /**
   * Exchange a platform media reference for bytes.
   *
   * Neither LINE nor Messenger sends media in the webhook: LINE gives a message id to fetch
   * from its blob endpoint, and Messenger gives a CDN URL that expires. The worker resolves
   * these before the AI turn runs, so a vision model has something to look at and an agent
   * sees the image after the platform's link has died.
   */
  fetchMedia?(
    reference: string,
    config: TConfig,
  ): Promise<{ data: Uint8Array<ArrayBuffer>; mime: string }>
}

export class ChannelConfigError extends Error {
  constructor(type: ChannelType, message: string) {
    super(`[${type}] ${message}`)
    this.name = 'ChannelConfigError'
  }
}
