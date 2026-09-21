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
import type { AiTurnJob, JobMeta, Runtime } from '@ci/infra'
import {
  addConversationTags,
  boundIdentityFor,
  createTurnRetrieval,
  createWorkspaceToolSources,
  describeWriteFailure,
  loadAiConfig,
  loadToolDefinitions,
  loadTurnContext,
  loadWorkspaceSettings,
  mergeCustomerFields,
  recordTrace,
  resolveExternalRetrieval,
  runPendingWrites,
  sendVerificationLink,
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
  meta?: JobMeta,
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

  // Tools the workspace defined for itself, and the values the system will bind into them.
  // The subject comes from a proof recorded on the channel identity, never from anything
  // the model or the customer said; see packages/infra/src/identity.ts.
  const toolDefinitions = await loadToolDefinitions(db, job.workspaceId, env.APP_SECRET_KEY)
  const bound = boundIdentityFor(context, settings)
  // Stable across a retry of this job, so a write that is sent twice carries one key.
  const turnKey = meta?.jobId ?? `turn-${job.conversationId}-${Date.now()}`

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
    bound,
    turnKey,
    logger,
    toolSources: createWorkspaceToolSources(toolDefinitions, runtime),
    // Only worth offering when a link can actually be sent and nothing is proven yet.
    identityVerificationAvailable:
      settings.identity.verificationLink.enabled &&
      settings.identity.verificationLink.url !== null &&
      bound.subject === null,
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
    // Pending writes are deliberately abandoned here. The model asked for them on the way
    // to deciding it could not finish, and a turn that ends with a person should not also
    // have changed something in the tenant's system on its own initiative.
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

  // Writes fire here: after the turn is known to have succeeded, and before the reply is
  // stored. A customer must never read "done" for something that then failed, so a failed
  // write discards the reply and fetches a person instead.
  if (result.pendingWrites.length > 0) {
    const outcome = await runPendingWrites(
      toolDefinitions,
      result.pendingWrites,
      bound,
      runtime,
      turnKey,
    )
    if (outcome.failed) {
      logger.warn('a tenant tool write failed; the reply was held back', {
        conversationId: job.conversationId,
        tool: outcome.failed.tool,
        succeeded: outcome.succeeded,
      })
      await handOff(runtime, ports, logger, job, 'tool_error', describeWriteFailure(outcome))
      return
    }
    logger.info('tenant tool writes carried out', {
      conversationId: job.conversationId,
      tools: outcome.succeeded,
    })
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

  // Queued after the reply, so the customer reads the answer and then the link, in that
  // order, rather than being handed a login prompt before being told why.
  if (result.verificationRequested) {
    const sent = await sendVerificationLink(runtime, {
      workspaceId: job.workspaceId,
      conversationId: job.conversationId,
    })
    if (!sent.ok) {
      logger.warn('the AI asked for a verification link that could not be sent', {
        conversationId: job.conversationId,
        reason: sent.reason,
      })
    }
  }
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
