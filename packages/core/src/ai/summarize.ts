import { generateObject } from 'ai'
import { z } from 'zod'
import { estimateCost } from './cost'
import { runWithFallback } from './registry'
import type {
  ConversationTurn,
  CustomerContext,
  PriceTable,
  SlotConfig,
  TraceRecord,
} from './types'

/**
 * The rolling customer summary.
 *
 * This is what makes the AI recognise a customer who returns a month later, and what gives
 * a human agent a one-paragraph brief at the top of a conversation. It is rewritten from
 * the previous summary plus the new messages rather than regenerated from the whole
 * history, so it stays cheap as a relationship grows.
 */

const summarySchema = z.object({
  summary: z
    .string()
    .max(1200)
    .describe('Two to four sentences: who this customer is and what they have needed'),
  facts: z
    .record(z.string(), z.string())
    .describe('Durable details worth remembering, such as plan, company or timezone'),
  openIssues: z
    .array(z.string().max(200))
    .max(5)
    .describe('Anything left unresolved that a colleague should pick up'),
})

export type CustomerSummary = z.infer<typeof summarySchema>

export type SummarizeResult = {
  summary: CustomerSummary | null
  trace: TraceRecord
}

const SYSTEM = [
  'You maintain a short running summary of a customer for a support team.',
  'Rewrite the previous summary in light of the new messages. Keep what still matters and',
  'drop what has been resolved. Write plainly, in the language the customer uses.',
  'Record only what a colleague would need to know. Never record payment card numbers or',
  'national ID numbers, and do not speculate about the customer.',
].join(' ')

export async function summarizeCustomer(options: {
  slot: SlotConfig
  customer: CustomerContext
  previousSummary: string | null
  messages: ConversationTurn[]
  prices: PriceTable
  maxRetries?: number
}): Promise<SummarizeResult> {
  const { slot, customer, previousSummary, messages, prices } = options
  const startedAt = Date.now()

  const transcript = messages
    .map(
      (m) =>
        `${m.role === 'customer' ? 'Customer' : m.role === 'ai' ? 'AI' : 'Colleague'}: ${m.text}`,
    )
    .join('\n')

  const prompt = [
    customer.displayName ? `Customer name: ${customer.displayName}` : null,
    Object.keys(customer.fields).length > 0
      ? `Known details: ${Object.entries(customer.fields)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ')}`
      : null,
    previousSummary ? `Previous summary:\n${previousSummary}` : 'No previous summary.',
    `New messages:\n${transcript}`,
  ]
    .filter(Boolean)
    .join('\n\n')

  try {
    const attempt = await runWithFallback(slot, async (_target, model) =>
      generateObject({
        model,
        schema: summarySchema,
        system: SYSTEM,
        prompt,
        temperature: slot.params.temperature ?? 0.2,
        maxRetries: options.maxRetries ?? slot.params.maxRetries ?? 1,
      }),
    )

    const tokensIn = attempt.result.usage?.inputTokens ?? null
    const tokensOut = attempt.result.usage?.outputTokens ?? null

    return {
      summary: attempt.result.object,
      trace: {
        task: 'summarize',
        providerId: attempt.target.provider.id,
        providerName: attempt.target.provider.name,
        model: attempt.target.model,
        usedFallback: attempt.usedFallback,
        prompt: { system: SYSTEM, prompt },
        toolCalls: [],
        retrieved: [],
        tokensIn,
        tokensOut,
        latencyMs: Date.now() - startedAt,
        costEstimate: estimateCost(
          prices,
          attempt.target.provider.name,
          attempt.target.model,
          tokensIn,
          tokensOut,
        ),
        outcome: 'draft',
        error: null,
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // A failed summary is not worth interrupting anyone over; the old one stays.
    return {
      summary: null,
      trace: {
        task: 'summarize',
        providerId: slot.primary?.provider.id ?? null,
        providerName: slot.primary?.provider.name ?? null,
        model: slot.primary?.model ?? null,
        usedFallback: false,
        prompt: { system: SYSTEM, prompt },
        toolCalls: [],
        retrieved: [],
        tokensIn: null,
        tokensOut: null,
        latencyMs: Date.now() - startedAt,
        costEstimate: null,
        outcome: 'error',
        error: message,
      },
    }
  }
}

/** Render the structured summary into the paragraph agents and prompts read. */
export function renderSummary(summary: CustomerSummary): string {
  const parts = [summary.summary.trim()]
  if (summary.openIssues.length > 0) {
    parts.push(`Open: ${summary.openIssues.join('; ')}`)
  }
  return parts.join('\n')
}
