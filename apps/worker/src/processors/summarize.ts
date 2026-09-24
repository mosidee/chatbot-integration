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
  type Runtime,
  recordTrace,
  usableSlot,
  workspaceIsWorkable,
  workspaceProviderFetch,
} from '@ci/infra'
import { and, desc, eq, gt } from 'drizzle-orm'

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
  conversationId: string
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

  const workspace = await workspaceIsWorkable(db, job.workspaceId, logger, 'summarize')
  if (!workspace) return
  const settings = workspace.settings
  const providerFetch = await workspaceProviderFetch(runtime, job.workspaceId)
  const aiConfig = await loadAiConfig(
    db,
    job.workspaceId,
    env.APP_SECRET_KEY,
    settings.modelPrices,
    providerFetch,
  )

  // Falls back to the chat slot so summaries work before a cheaper model is configured.
  const slot = usableSlot(aiConfig, 'summarize') ?? usableSlot(aiConfig, 'agent_chat')
  const embedSlot = usableSlot(aiConfig, 'embed')

  // The conversation must belong to this customer. A job that named someone else's
  // conversation would fold their words into this customer's summary, which is the leak
  // this product refuses, so it is refused here rather than trusted from the queue.
  const owned = await db
    .select({
      id: schema.conversations.id,
      summarizedThrough: schema.conversations.summarizedThroughMessageId,
    })
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.id, job.conversationId),
        eq(schema.conversations.workspaceId, job.workspaceId),
        eq(schema.conversations.customerId, job.customerId),
      ),
    )
    .limit(1)
  if (owned.length === 0) {
    logger.warn("summary skipped: conversation is not this customer's", {
      customerId: job.customerId,
      conversationId: job.conversationId,
    })
    return
  }

  /**
   * What came after the last summary, newest two hundred of it.
   *
   * The previous summary is an input, so only the new part of the conversation needs
   * reading. Selecting the first two hundred every time meant a long, reopened conversation
   * was summarised from its opening for ever and its latest exchanges never reached memory.
   */
  const through = owned[0]?.summarizedThrough ?? null
  const messageRows = (
    await db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.workspaceId, job.workspaceId),
          eq(schema.messages.conversationId, job.conversationId),
          ...(through ? [gt(schema.messages.id, through)] : []),
        ),
      )
      .orderBy(desc(schema.messages.id))
      .limit(200)
  ).reverse()
  const newestId = messageRows.at(-1)?.id ?? null

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

    const traceId = await recordTrace(db, job.workspaceId, job.conversationId, result.trace)

    if (result.summary) {
      const rendered = renderSummary(result.summary)

      await db
        .update(schema.customers)
        .set({
          summary: rendered,
          /**
           * Into `notes`, not `fields`.
           *
           * `fields` holds identifiers — the five keys `set_customer_field` may write, which
           * merge matching reads and an agent scans to check they have the right person.
           * The model's facts are free-form and keyed however it felt that turn, and
           * merging them in put a paragraph about somebody's plan in the same list as their
           * phone number.
           *
           * Newer facts win. Only the summariser writes here, so what is already there is an
           * older reading of the same customer, and a plan they changed should read as changed.
           */
          notes: { ...customer.notes, ...result.summary.facts },
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
      // Not advanced past messages the summary never took in; the next resolve tries again.
      return
    }
  }

  // Index for recall. Only the customer's own words and what was said back to them; a
  // digest, not a transcript, so recall surfaces topics rather than pleasantries.
  /**
   * Recall grows with the conversation rather than being rebuilt: each summary indexes only
   * what it just read, so nothing is deleted, and a failed embedding call leaves the earlier
   * episodes answering rather than an empty index.
   */
  if (embedSlot) {
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

  if (newestId) {
    await db
      .update(schema.conversations)
      .set({ summarizedThroughMessageId: newestId })
      .where(
        and(
          eq(schema.conversations.id, job.conversationId),
          eq(schema.conversations.workspaceId, job.workspaceId),
        ),
      )
  }
}
