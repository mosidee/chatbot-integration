import { tool } from 'ai'
import { z } from 'zod'
import type { CustomerContext, HandoffIntent, RetrievedChunk } from './types'

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
  /** Everything retrieval surfaced this turn, pre-fetched or via a tool, for the trace. */
  retrieved: RetrievedChunk[]
}

export function createScratchpad(): TurnScratchpad {
  return { handoff: null, customerFieldUpdates: {}, tagsToAdd: [], retrieved: [] }
}

export type PastConversationHit = {
  conversationId: string
  text: string
  at: Date
}

export type ToolContext = {
  customer: CustomerContext
  scratchpad: TurnScratchpad
  /**
   * Optional capabilities. A tool is only offered to the model when its capability is
   * present, so a workspace with no knowledge base does not advertise a search that can
   * only ever come back empty.
   */
  searchKnowledge?: (query: string) => Promise<RetrievedChunk[]>
  /**
   * Already bound to this customer by the caller. The tool cannot widen the scope, which is
   * what keeps one customer's history out of another's conversation.
   */
  searchPastConversations?: (query: string) => Promise<PastConversationHit[]>
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

    ...(ctx.searchKnowledge
      ? {
          search_knowledge: tool({
            description: [
              'Search the knowledge base for product facts. Use this when the customer asks',
              'something the entries already supplied do not cover, or when you want to check',
              'a detail before stating it. Search with the words the customer used.',
            ].join(' '),
            inputSchema: z.object({
              query: z.string().min(1).max(300).describe('What to look up'),
            }),
            execute: async ({ query }) => {
              const chunks = await (
                ctx.searchKnowledge as (q: string) => Promise<RetrievedChunk[]>
              )(query)
              for (const chunk of chunks) {
                if (!ctx.scratchpad.retrieved.some((r) => r.id === chunk.id)) {
                  ctx.scratchpad.retrieved.push(chunk)
                }
              }
              return {
                found: chunks.length,
                entries: chunks.map((c) => ({ source: c.sourceTitle, text: c.text })),
              }
            },
          }),
        }
      : {}),

    ...(ctx.searchPastConversations
      ? {
          search_past_conversations: tool({
            description: [
              "Search this customer's own earlier conversations. Use it when they refer to",
              "something discussed before. It only ever returns this customer's history.",
            ].join(' '),
            inputSchema: z.object({
              query: z.string().min(1).max(300),
            }),
            execute: async ({ query }) => {
              const hits = await (
                ctx.searchPastConversations as (q: string) => Promise<PastConversationHit[]>
              )(query)
              return {
                found: hits.length,
                excerpts: hits.map((h) => ({ when: h.at.toISOString(), text: h.text })),
              }
            },
          }),
        }
      : {}),
  }
}

export type InternalTools = ReturnType<typeof createInternalTools>
