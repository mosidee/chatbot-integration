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

  async verifyWebhook() {
    // The route is behind session auth; there is no platform signature to check.
    return true
  },

  parseInbound(request: WebhookRequest): InboundEvent[] {
    const parsed = inboundSchema.parse(JSON.parse(request.rawBody))
    return [
      {
        platformEventId: parsed.eventId ?? crypto.randomUUID(),
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
