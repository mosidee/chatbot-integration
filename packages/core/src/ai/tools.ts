import { tool } from 'ai'
import { z } from 'zod'
import type { CustomerContext, HandoffIntent } from './types'

/**
 * Internal tools available to the agent.
 *
 * Tools never write to the database. They record intent on a scratchpad that the worker
 * reads after the turn and applies transactionally, so a failed turn leaves no partial
 * side effects. External HTTP and MCP tools register through the same shape in M5.
 */

export type TurnScratchpad = {
  handoff: HandoffIntent | null
  customerFieldUpdates: Record<string, string>
  tagsToAdd: string[]
}

export function createScratchpad(): TurnScratchpad {
  return { handoff: null, customerFieldUpdates: {}, tagsToAdd: [] }
}

export type ToolContext = {
  customer: CustomerContext
  scratchpad: TurnScratchpad
}

const handoffReasonForAi = z.enum([
  'customer_requested',
  'low_confidence',
  'negative_sentiment',
  'unsupported_media',
])

export function createInternalTools(ctx: ToolContext) {
  return {
    handoff_to_human: tool({
      description: [
        'Hand the conversation to a human colleague. Use this when you cannot answer',
        'confidently from the knowledge available, when the customer asks for a person,',
        'when the customer is upset, or when the request needs account-specific action',
        'you cannot take. After calling this, stop and do not answer the question yourself.',
      ].join(' '),
      inputSchema: z.object({
        reason: handoffReasonForAi.describe('Why the conversation needs a human'),
        note: z
          .string()
          .max(500)
          .describe('One or two sentences telling the colleague what is needed'),
      }),
      execute: async ({ reason, note }) => {
        ctx.scratchpad.handoff = { reason, note }
        return { ok: true, message: 'A colleague has been notified.' }
      },
    }),

    tag_conversation: tool({
      description:
        'Attach short topic tags to this conversation so the team can filter and report on it.',
      inputSchema: z.object({
        tags: z.array(z.string().min(1).max(40)).min(1).max(5),
      }),
      execute: async ({ tags }) => {
        for (const t of tags) {
          if (!ctx.scratchpad.tagsToAdd.includes(t)) ctx.scratchpad.tagsToAdd.push(t)
        }
        return { ok: true, tags: ctx.scratchpad.tagsToAdd }
      },
    }),

    set_customer_field: tool({
      description: [
        'Record a business identifier the customer has given you, such as their phone',
        'number, order id or account id. Use the exact value the customer wrote.',
        'Never record payment card numbers or national ID numbers.',
      ].join(' '),
      inputSchema: z.object({
        key: z
          .enum(['phone', 'email', 'order_id', 'account_id', 'company'])
          .describe('Which identifier this is'),
        value: z.string().min(1).max(200),
      }),
      execute: async ({ key, value }) => {
        ctx.scratchpad.customerFieldUpdates[key] = value
        return { ok: true, key, value }
      },
    }),

    get_customer_profile: tool({
      description:
        'Look up what is already known about this customer: their name, language, saved identifiers and a summary of past conversations.',
      inputSchema: z.object({}),
      execute: async () => ({
        displayName: ctx.customer.displayName,
        language: ctx.customer.primaryLanguage,
        summary: ctx.customer.summary,
        fields: ctx.customer.fields,
      }),
    }),
  }
}

export type InternalTools = ReturnType<typeof createInternalTools>
