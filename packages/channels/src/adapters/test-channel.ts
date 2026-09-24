import { normalizedMessageSchema } from '@ci/shared'
import { z } from 'zod'
import type { ChannelAdapter, InboundEvent, WebhookRequest } from '../types'

/**
 * The internal test channel that backs the simulator page.
 *
 * Messages arrive through an authenticated API route rather than a public webhook, so
 * there is no signature to verify. Outbound messages are simply stored: the simulator
 * watches the conversation over the same WebSocket stream the agent inbox uses, so no
 * delivery mechanism is needed.
 *
 * Its real value is that the whole pipeline — AI turn, handoff, suggestions, redaction —
 * is exercisable in a browser with no platform account, no tunnel and no phone.
 */

const configSchema = z.object({}).default({})
export type TestChannelConfig = z.infer<typeof configSchema>

const inboundSchema = z.object({
  externalId: z.string().min(1),
  message: normalizedMessageSchema,
  eventId: z.string().min(1).optional(),
  displayName: z.string().optional(),
})

export const testChannelAdapter: ChannelAdapter<TestChannelConfig> = {
  type: 'test',

  capabilities: {
    publicWebhook: false,
    maxTextLength: 2000,
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
   * There is no platform signature to check, and this never admits anything.
   *
   * `publicWebhook: false` keeps the simulator off the public route; it reaches ingestion
   * through `ingestInternal`, behind the console session its route already requires. This
   * used to return true on the reasoning that the route was session-guarded — which was so
   * of the simulator route and not of the public one, where the same adapter was reachable
   * by anybody who knew a channel id.
   */
  async verifyWebhook() {
    return false
  },

  parseInbound(request: WebhookRequest): InboundEvent[] {
    const parsed = inboundSchema.parse(JSON.parse(request.rawBody))
    return [
      {
        // Never random: a retry re-parses the same body and must name the same event.
        platformEventId: parsed.eventId ?? `body-${stableHash(request.rawBody)}`,
        externalId: parsed.externalId,
        message: parsed.message,
        timestamp: new Date(),
        profile: parsed.displayName ? { displayName: parsed.displayName } : undefined,
      },
    ]
  },

  async send() {
    return { platformMessageId: `test-${crypto.randomUUID()}` }
  },
}

/** FNV-1a over the body: a stable name for an event that arrived without one. */
function stableHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}
