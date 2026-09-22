import { attributesFromClaims, normalizedMessageSchema, type VerifiedIdentity } from '@ci/shared'
import { z } from 'zod'
import { verifyVisitorToken } from '../jwt'
import type { ChannelAdapter, InboundEvent, WebhookRequest } from '../types'

/**
 * The embeddable web widget channel.
 *
 * A visitor is either anonymous, identified by a browser-generated id, or authenticated by
 * a short-lived HS256 token the host application signs for its logged-in user. The latter
 * is how a salon-saas customer gets support without ever identifying themselves, and how
 * account-specific tools can act on their behalf.
 *
 * The browser widget that speaks to this adapter lives in apps/widget.
 */

const configSchema = z.object({
  /** Shared secret the host application signs visitor tokens with. */
  visitorTokenSecret: z.string().min(16).nullable().default(null),
  /** Origins allowed to embed the widget. Empty means any, which suits development only. */
  allowedOrigins: z.array(z.string()).default([]),
})
export type WebChannelConfig = z.infer<typeof configSchema>

const inboundSchema = z.object({
  /** Anonymous browser id, used when no token is supplied. */
  visitorId: z.string().min(1),
  message: normalizedMessageSchema,
  eventId: z.string().min(1).optional(),
  /** Token minted by the host application for a logged-in user. */
  token: z.string().optional(),
})

export const webChannelAdapter: ChannelAdapter<WebChannelConfig> = {
  type: 'web',

  capabilities: {
    publicWebhook: false,
    maxTextLength: 4000,
    supportsQuickReplies: true,
    supportsTemplates: false,
    supportsImages: true,
    supportsFiles: true,
    messagingWindowHours: null,
  },

  parseConfig(raw) {
    return configSchema.parse(raw ?? {})
  },

  /**
   * There is nothing here to verify, and this is never the thing that admits a request.
   *
   * `publicWebhook: false` keeps the web channel off the public route entirely; the widget
   * reaches ingestion through `ingestInternal`, having already proved itself with the
   * session we signed. An `Origin` header is a browser's courtesy, not a credential — any
   * client can send one — so checking it here only ever gave false assurance. Where origin
   * genuinely matters, the session route enforces `allowedOrigins` against the header a
   * real browser sent.
   */
  async verifyWebhook() {
    return false
  },

  /**
   * A parsed body never carries a proved identity.
   *
   * It used to: the schema accepted a `verified` block and this copied it onto the event,
   * where it was written to the channel identity and later bound into tool calls. The
   * assumption was that only the widget route would ever call in, but the public webhook
   * route reached every adapter, and a web channel id is printed in the embed code on the
   * host's own page — so anybody could name a visitor and assert who they were.
   *
   * The proof now travels beside the body, in the envelope only `ingestInternal` can write,
   * and this adapter no longer knows the concept exists.
   */
  parseInbound(request: WebhookRequest): InboundEvent[] {
    const parsed = inboundSchema.parse(JSON.parse(request.rawBody))
    return [
      {
        platformEventId: parsed.eventId ?? crypto.randomUUID(),
        externalId: parsed.visitorId,
        message: parsed.message,
        timestamp: new Date(),
      },
    ]
  },

  async send() {
    // Delivered over the widget's own WebSocket connection, like the simulator.
    return { platformMessageId: `web-${crypto.randomUUID()}` }
  },
}

/**
 * Resolve a widget visitor to a stable identity.
 *
 * A valid token wins, so the same person reaching support from two browsers lands on one
 * customer record. An invalid or expired token degrades to anonymous rather than failing:
 * a customer with a stale session should still be able to ask for help.
 */
export async function resolveWebVisitor(
  input: { visitorId: string; token?: string },
  config: WebChannelConfig,
  now: Date = new Date(),
): Promise<{
  externalId: string
  identified: boolean
  displayName: string | null
  attributes: Record<string, string>
  /**
   * The proof itself, when there was one. Distinct from `identified`, which has always
   * meant "we know which visitor this is": that is continuity, and this is evidence.
   */
  verified?: VerifiedIdentity & { via: 'widget_token' }
}> {
  if (input.token && config.visitorTokenSecret) {
    try {
      const claims = await verifyVisitorToken(input.token, config.visitorTokenSecret, now)
      const attributes = attributesFromClaims(claims)
      return {
        externalId: `host:${claims.sub}`,
        identified: true,
        displayName: claims.name ?? null,
        attributes,
        verified: { subject: claims.sub, attributes, via: 'widget_token' },
      }
    } catch {
      // Fall through to anonymous.
    }
  }

  return {
    externalId: `anon:${input.visitorId}`,
    identified: false,
    displayName: null,
    attributes: {},
  }
}
