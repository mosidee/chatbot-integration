import {
  type AgentTurnInput,
  aiMaySend,
  applyEffects,
  type ConversationTurn,
  type EffectPorts,
  type ImageInput,
  type Logger,
  runAgentTurn,
  transition,
} from '@ci/core'
import { newId, schema } from '@ci/db'
import type { AiTurnJob, Runtime } from '@ci/infra'
import {
  addConversationTags,
  addInternalNote,
  createTurnRetrieval,
  loadAiConfig,
  loadTurnContext,
  loadWorkspaceSettings,
  mergeCustomerFields,
  recordTrace,
  resolveExternalRetrieval,
  storeMessage,
  suggestMergesFor,
  updateConversation,
  usableSlot,
  workspaceHasKnowledge,
} from '@ci/infra'
import type { HandoffReason } from '@ci/shared'
import { eq } from 'drizzle-orm'

/**
 * Run one AI turn and deliver the outcome.
 *
 * The mode is re-read here, not trusted from the job payload. A human may have taken the
 * conversation over in the seconds between enqueueing and running, and the rule that the
 * AI never sends while a human owns the conversation has to hold at the moment of sending,
 * not the moment of deciding.
 */
export async function processAiTurn(
  runtime: Runtime,
  ports: EffectPorts,
  logger: Logger,
  job: AiTurnJob,
): Promise<void> {
  const { db, env, publisher, queues } = runtime

  const context = await loadTurnContext(db, job.workspaceId, job.conversationId)
  if (!context) {
    logger.warn('conversation vanished before the AI turn ran', {
      conversationId: job.conversationId,
    })
    return
  }

  const settings = await loadWorkspaceSettings(db, job.workspaceId)
  const { conversation, customer, notes, recentMessages } = context

  // The last line of defence for the product's central rule.
  if (job.deliver === 'send' && !aiMaySend(conversation.mode)) {
    logger.info('AI turn abandoned: a human owns the conversation', {
      conversationId: job.conversationId,
      mode: conversation.mode,
    })
    await queues.suggestion.add('run', {
      workspaceId: job.workspaceId,
      conversationId: job.conversationId,
    })
    return
  }

  const aiConfig = await loadAiConfig(db, job.workspaceId, env.APP_SECRET_KEY, settings.modelPrices)
  // Both delivery modes use agent_chat: in ai_supervised the AI is still answering, the
  // answer is just held for a human to approve.
  const chatSlot = usableSlot(aiConfig, 'agent_chat')
  if (!chatSlot) {
    logger.warn('no agent_chat provider configured; handing off', {
      workspaceId: job.workspaceId,
    })
    await handOff(runtime, ports, logger, job, 'model_error', 'No AI provider is configured.')
    return
  }

  const visionSlot = usableSlot(aiConfig, 'vision')
  const images = visionSlot ? await readImages(runtime, recentMessages) : []

  // Retrieval is bound to this workspace, customer and conversation before the model sees
  // it, so the tools it is offered cannot widen their own scope.
  const embedSlot = usableSlot(aiConfig, 'embed')
  const retrieval = createTurnRetrieval(db, {
    workspaceId: job.workspaceId,
    customerId: conversation.customerId,
    conversationId: job.conversationId,
    language: customer.primaryLanguage ?? settings.defaultLanguage,
    channelType: context.channel.type,
    embedSlot,
    rerankSlot: usableSlot(aiConfig, 'rerank'),
    externalRetrieval: await resolveExternalRetrieval(
      settings.externalRetrieval,
      env.APP_SECRET_KEY,
    ),
    hasKnowledge: await workspaceHasKnowledge(db, job.workspaceId),
  })

  // Pre-fetch for the newest customer message so the model has the obvious facts in hand
  // without spending a tool call on them.
  const newestCustomerText = [...recentMessages]
    .reverse()
    .find((m) => m.senderType === 'customer')?.text
  const prefetched =
    retrieval.enabled.knowledge && newestCustomerText
      ? await retrieval.prefetch(newestCustomerText).catch(() => [])
      : []

  const input: AgentTurnInput = {
    workspace: { persona: settings.persona, defaultLanguage: settings.defaultLanguage },
    customer: {
      displayName: customer.displayName,
      primaryLanguage: customer.primaryLanguage,
      summary: customer.summary,
      fields: customer.fields,
    },
    recentMessages: recentMessages.map(toTurn),
    internalNotes: notes.map((n) => ({ body: n.body, at: n.createdAt })),
    retrieved: prefetched,
    images,
  }

  const result = await runAgentTurn({
    input,
    chatSlot,
    visionSlot,
    prices: aiConfig.prices,
    mode: job.deliver === 'draft' ? 'suggest' : 'answer',
    ...(retrieval.enabled.knowledge ? { searchKnowledge: retrieval.searchKnowledge } : {}),
    ...(retrieval.enabled.pastConversations
      ? { searchPastConversations: retrieval.searchPastConversations }
      : {}),
  })

  const traceId = await recordTrace(db, job.workspaceId, job.conversationId, result.trace)

  const changedFields = await mergeCustomerFields(
    db,
    job.workspaceId,
    conversation.customerId,
    result.customerFieldUpdates,
  )
  // A newly learned phone or account id may be one we already hold under another name.
  // This only proposes; joining the two records is a person's decision, never ours.
  const proposed = await suggestMergesFor(
    db,
    job.workspaceId,
    conversation.customerId,
    changedFields,
  )
  if (proposed > 0) {
    logger.info('merge suggested', { customerId: conversation.customerId, proposed })
  }
  await addConversationTags(db, job.workspaceId, job.conversationId, result.tagsToAdd)

  if (result.handoff) {
    await handOff(
      runtime,
      ports,
      logger,
      job,
      result.handoff.reason,
      result.handoff.note ?? `AI handed off: ${result.handoff.reason}`,
    )
    return
  }

  // An empty answer used to end the turn here, which left the customer with silence and
  // told nobody. Seen in production when a reasoning model spent its whole output budget
  // thinking: the conversation simply stopped. Whatever the cause, a person is told.
  if (!result.text) {
    logger.warn('AI produced an empty reply', {
      conversationId: job.conversationId,
      tokensOut: result.trace.tokensOut,
    })
    if (job.deliver === 'draft') return
    await handOff(
      runtime,
      ports,
      logger,
      job,
      'model_error',
      'The AI returned nothing at all, so this needs a person. The trace shows what it was asked.',
    )
    return
  }

  if (job.deliver === 'draft') {
    const suggestionId = newId()
    await db.insert(schema.suggestions).values({
      id: suggestionId,
      workspaceId: job.workspaceId,
      conversationId: job.conversationId,
      messageText: result.text,
      chunks: result.trace.retrieved,
      aiTraceId: traceId,
      status: 'pending',
    })
    await publisher.publish(job.workspaceId, {
      type: 'suggestion.created',
      conversationId: job.conversationId,
      suggestionId,
    })
    await ports.notifyAgents(
      { workspaceId: job.workspaceId, conversationId: job.conversationId },
      'draft_ready',
    )
    return
  }

  const stored = await storeMessage(db, {
    workspaceId: job.workspaceId,
    conversationId: job.conversationId,
    direction: 'outbound',
    senderType: 'ai',
    message: { kind: 'text', text: result.text },
    status: 'queued',
    aiTraceId: traceId,
    redaction: settings.redaction,
  })

  await updateConversation(db, job.workspaceId, job.conversationId, { lastMessageAt: new Date() })

  await queues.outbound.add('send', {
    workspaceId: job.workspaceId,
    conversationId: job.conversationId,
    messageId: stored.id,
  })
}

async function handOff(
  runtime: Runtime,
  ports: EffectPorts,
  logger: Logger,
  job: AiTurnJob,
  reason: HandoffReason,
  note: string,
): Promise<void> {
  const { db } = runtime
  const settings = await loadWorkspaceSettings(db, job.workspaceId)

  const rows = await db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.id, job.conversationId))
    .limit(1)
  const conversation = rows[0]
  if (!conversation) return

  const { patch, effects } = transition(
    {
      mode: conversation.mode,
      status: conversation.status,
      assigneeUserId: conversation.assigneeUserId,
      waitingHumanSince: conversation.waitingHumanSince,
      handoffReason: conversation.handoffReason,
    },
    { type: 'ai_handoff', at: new Date(), reason, note },
    { waitingHumanFallbackMinutes: settings.waitingHumanFallbackMinutes },
  )

  if (Object.keys(patch).length > 0) {
    await updateConversation(db, job.workspaceId, job.conversationId, patch)
  }
  await applyEffects(
    effects,
    { workspaceId: job.workspaceId, conversationId: job.conversationId },
    ports,
    logger,
  )
}

function toTurn(message: typeof schema.messages.$inferSelect): ConversationTurn {
  const role =
    message.senderType === 'customer'
      ? 'customer'
      : message.senderType === 'human'
        ? 'human'
        : message.senderType === 'system'
          ? 'system'
          : 'ai'
  return { role, text: message.text, at: message.createdAt }
}

/**
 * Read images from the newest customer message out of object storage.
 * Bytes, not URLs: the provider never reaches into our bucket (ADR 0001).
 */
async function readImages(
  runtime: Runtime,
  messages: (typeof schema.messages.$inferSelect)[],
): Promise<ImageInput[]> {
  const newest = [...messages].reverse().find((m) => m.direction === 'inbound')
  if (!newest) return []
  const content = newest.content
  if (content.kind !== 'image') return []

  const images: ImageInput[] = []
  for (const attachment of content.attachments) {
    if (!attachment.storageKey) continue
    try {
      const object = await runtime.blob.get(attachment.storageKey)
      images.push({ data: object.data, mime: object.mime || attachment.mime })
    } catch (error) {
      runtime.logger.warn('could not read attachment for vision', {
        storageKey: attachment.storageKey,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return images
}

export { addInternalNote }
