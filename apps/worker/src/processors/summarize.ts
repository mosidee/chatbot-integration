import {
  type ConversationTurn,
  type EffectPorts,
  type Logger,
  renderSummary,
  summarizeCustomer,
} from '@ci/core'
import { newId, schema } from '@ci/db'
import {
  indexConversationText,
  loadAiConfig,
  loadWorkspaceSettings,
  type Runtime,
  recordTrace,
  usableSlot,
} from '@ci/infra'
import { and, asc, desc, eq } from 'drizzle-orm'

/**
 * Rewrite a customer's rolling summary, and index the conversation for recall.
 *
 * Runs when a conversation is resolved and periodically during a long one. Both jobs are
 * cheap to repeat: the summary is rewritten from the previous one rather than the whole
 * history, and indexing replaces what it wrote for the same conversation.
 */
export type SummarizeJob = {
  workspaceId: string
  customerId: string
  conversationId?: string | null
}

export async function processSummarize(
  runtime: Runtime,
  _ports: EffectPorts,
  logger: Logger,
  job: SummarizeJob,
): Promise<void> {
  const { db, env } = runtime

  const customerRows = await db
    .select()
    .from(schema.customers)
    .where(
      and(
        eq(schema.customers.id, job.customerId),
        eq(schema.customers.workspaceId, job.workspaceId),
      ),
    )
    .limit(1)
  const customer = customerRows[0]
  if (!customer) return

  const settings = await loadWorkspaceSettings(db, job.workspaceId)
  const aiConfig = await loadAiConfig(db, job.workspaceId, env.APP_SECRET_KEY, settings.modelPrices)

  // Falls back to the chat slot so summaries work before a cheaper model is configured.
  const slot = usableSlot(aiConfig, 'summarize') ?? usableSlot(aiConfig, 'agent_chat')
  const embedSlot = usableSlot(aiConfig, 'embed')

  // The messages to fold in: this conversation if named, otherwise the customer's recent.
  const messageRows = job.conversationId
    ? await db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.conversationId, job.conversationId))
        .orderBy(asc(schema.messages.createdAt))
        .limit(200)
    : await db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.workspaceId, job.workspaceId))
        .orderBy(desc(schema.messages.createdAt))
        .limit(60)

  const relevant = messageRows.filter((m) => m.content.kind !== 'event')
  if (relevant.length === 0) return

  const turns: ConversationTurn[] = relevant.map((m) => ({
    role:
      m.senderType === 'customer'
        ? 'customer'
        : m.senderType === 'human'
          ? 'human'
          : m.senderType === 'system'
            ? 'system'
            : 'ai',
    text: m.text,
    at: m.createdAt,
  }))

  if (slot) {
    const result = await summarizeCustomer({
      slot,
      customer: {
        displayName: customer.displayName,
        primaryLanguage: customer.primaryLanguage,
        summary: customer.summary,
        fields: customer.fields,
      },
      previousSummary: customer.summary,
      messages: turns,
      prices: aiConfig.prices,
    })

    const traceId = await recordTrace(db, job.workspaceId, job.conversationId ?? null, result.trace)

    if (result.summary) {
      const rendered = renderSummary(result.summary)

      await db
        .update(schema.customers)
        .set({
          summary: rendered,
          // Facts the model extracted are merged under what a human or tool already set,
          // because a person correcting a detail should outrank the model re-deriving it.
          fields: { ...result.summary.facts, ...customer.fields },
          summaryUpdatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.customers.id, customer.id))

      await db.insert(schema.customerSummaries).values({
        id: newId(),
        workspaceId: job.workspaceId,
        customerId: customer.id,
        summary: rendered,
        facts: result.summary.facts,
        model: result.trace.model,
        aiTraceId: traceId,
      })

      logger.info('customer summary updated', { customerId: customer.id })
    } else {
      logger.warn('summary failed; keeping the previous one', {
        customerId: customer.id,
        error: result.trace.error,
      })
    }
  }

  // Index for recall. Only the customer's own words and what was said back to them; a
  // digest, not a transcript, so recall surfaces topics rather than pleasantries.
  if (embedSlot && job.conversationId) {
    await db
      .delete(schema.conversationEmbeddings)
      .where(eq(schema.conversationEmbeddings.conversationId, job.conversationId))

    const digest = turns
      .filter((t) => t.role === 'customer' || t.role === 'ai' || t.role === 'human')
      .map((t) => `${t.role === 'customer' ? 'ลูกค้า/Customer' : 'Support'}: ${t.text}`)
      .join('\n')

    const indexed = await indexConversationText(
      db,
      {
        workspaceId: job.workspaceId,
        customerId: customer.id,
        conversationId: job.conversationId,
        text: digest,
      },
      embedSlot,
    )
    logger.info('conversation indexed for recall', {
      conversationId: job.conversationId,
      chunks: indexed,
    })
  }
}
