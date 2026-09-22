import { tool } from 'ai'
import { z } from 'zod'
import type { BoundIdentity, ToolSource } from './tool-source'
import type { CustomerContext, HandoffIntent, RetrievedChunk } from './types'

/**
 * Internal tools available to the agent.
 *
 * Tools never write to the database. They record intent on a scratchpad that the worker
 * reads and applies only after the turn has finished, so a turn that fails part way
 * leaves no side effects at all. Tenant-defined HTTP tools join through `ToolSource` and
 * obey the same rule; see `http-tool.ts`.
 */

/** A tenant tool the model asked for that has not run yet. See `ToolEffect`. */
export type PendingWrite = {
  toolId: string
  tool: string
  args: Record<string, unknown>
  /**
   * Decided here, when the model asks, rather than by position when the writes are fired.
   *
   * A retry re-runs the whole turn, and the model may then ask for a different set of
   * calls or the same ones in a different order. A key built from the position in that
   * list would give a second operation the key the tenant already answered for a first
   * one, which is how a refund gets issued twice.
   */
  idempotencyKey: string
}

export type TurnScratchpad = {
  handoff: HandoffIntent | null
  customerFieldUpdates: Record<string, string>
  tagsToAdd: string[]
  /** Everything retrieval surfaced this turn, pre-fetched or via a tool, for the trace. */
  retrieved: RetrievedChunk[]
  /**
   * Tenant tools that failed during the turn. A model told "that lookup failed" will
   * cheerfully invent the answer instead, so the turn ends in a handoff rather than
   * whatever it wrote next.
   */
  toolErrors: { tool: string; message: string }[]
  /** Writing tools the model called, to be fired after the turn. */
  pendingWrites: PendingWrite[]
  /** The model asked for a verification link to be sent to this customer. */
  verificationRequested: boolean
}

export function createScratchpad(): TurnScratchpad {
  return {
    handoff: null,
    customerFieldUpdates: {},
    tagsToAdd: [],
    retrieved: [],
    toolErrors: [],
    pendingWrites: [],
    verificationRequested: false,
  }
}

export type PastConversationHit = {
  conversationId: string
  text: string
  at: Date
}

export type ToolContext = {
  customer: CustomerContext
  scratchpad: TurnScratchpad
  /** Values the system supplies to a tool call. The model can neither see nor set these. */
  bound: BoundIdentity
  /**
   * `suggest` means a human will approve whatever is drafted, so no writing tool is
   * offered: a draft nobody has read must not change anything in the tenant's system.
   */
  mode: 'answer' | 'suggest'
  /**
   * Stable across a retry of the same job, so a write that reaches the tenant twice
   * carries one idempotency key and lands once.
   */
  turnKey: string
  /** Whether a verification link can actually be sent, which decides if the tool exists. */
  identityVerificationAvailable?: boolean
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

    /**
     * The shape every bound tool follows: an empty input schema, because there is nothing
     * here for the model to choose. Which customer this is was decided by the caller.
     */
    get_customer_profile: tool({
      description: [
        'Look up what is already known about this customer: their name, language, saved',
        'identifiers, a summary of past conversations, and any account details their',
        'verified login carried, such as which plan they are on.',
      ].join(' '),
      inputSchema: z.object({}),
      execute: async () => ({
        displayName: ctx.customer.displayName,
        language: ctx.customer.primaryLanguage,
        summary: ctx.customer.summary,
        fields: ctx.customer.fields,
        // Told apart on purpose. `fields` is what somebody typed into a chat window;
        // `account` is what an identity proof carried and is the only half worth trusting
        // for anything that costs money.
        verified: ctx.bound.subject !== null,
        account: ctx.bound.attributes,
      }),
    }),

    ...(ctx.bound.subject === null && ctx.identityVerificationAvailable
      ? {
          request_identity_verification: tool({
            description: [
              'Send this customer a one-time link to confirm who they are by logging into',
              'their account. Use it when they ask about their own account, subscription or',
              'orders and you have no verified identity for them. Tell them a link is on its',
              'way; do not guess at their account details in the meantime.',
            ].join(' '),
            inputSchema: z.object({}),
            execute: async () => {
              ctx.scratchpad.verificationRequested = true
              return {
                ok: true,
                message: 'A verification link will be sent to this customer after your reply.',
              }
            },
          }),
        }
      : {}),

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

/**
 * The internal tools as a source.
 *
 * Always merged first, so no tenant definition can take a name this one needs.
 */
export const internalToolSource: ToolSource = {
  id: 'internal',
  tools: (ctx) => createInternalTools(ctx),
}
