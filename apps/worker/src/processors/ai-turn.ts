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
  workspaceIsWorkable,
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

  /**
   * The one place this codebase lets an AI turn end without a message or a handoff.
   *
   * Everywhere else, going silent is the bug that rule exists to prevent: the customer is
   * left waiting for a reply no colleague knows is owed. A suspended or deleted workspace is
   * the exception, and deliberately so — there is nobody to hand off to, because every agent
   * in the tenant is locked out of the console as well. Sending on behalf of a tenant whose
   * operator has been suspended is the worse outcome.
   */
  const workspace = await workspaceIsWorkable(db, job.workspaceId, logger, 'ai_turn')
  if (!workspace) return
  const settings = workspace.settings
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
  const images = visionSlot ? await readImages(runtime, job.workspaceId, recentMessages) : []

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
      ? await retrieval.prefetch(newestCustomerText).catch((error) => {
          // The turn carries on without pre-fetched knowledge, which is the right call: the
          // model can still search, and the customer still gets an answer. But a retrieval
          // outage and an empty knowledge base produce identical turns, so the difference
          // has to be in the log or nobody will ever find it.
          logger.warn('pre-fetching knowledge failed; the turn continues without it', {
            conversationId: job.conversationId,
            error: error instanceof Error ? error.message : String(error),
          })
          return []
        })
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
    // Offered only where it can actually be honoured. `draft` is excluded because that
    // path ends at a suggestion for a person to approve and never reaches the code below
    // that sends the link: the model would otherwise write "I've sent you a link", an
    // agent would approve it, and nothing would arrive.
    identityVerificationAvailable:
      job.deliver === 'send' &&
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
    const outcome = await runPendingWrites(toolDefinitions, result.pendingWrites, bound, runtime)
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
      // Names the writes if any already fired. The tool told the model they were queued and
      // the model then said nothing, so the customer has been told nothing at all while
      // something in the tenant's system has already changed.
      result.pendingWrites.length > 0
        ? `The AI returned nothing at all, so this needs a person. It had already carried out: ${result.pendingWrites
            .map((w) => w.tool)
            .join(', ')}. The trace shows what it was asked.`
        : 'The AI returned nothing at all, so this needs a person. The trace shows what it was asked.',
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

  // Queued after the reply so the customer is told why before being handed a login
  // prompt. Both are separate jobs on the outbound queue, which runs ten at a time, so
  // this is the order they are enqueued in rather than a guarantee of the order they
  // arrive in.
  if (result.verificationRequested) {
    // Everything above has already happened: the reply is stored and queued. A throw here
    // would fail the job, and BullMQ would re-run the whole turn — a second model call, a
    // second reply to the customer and a second pass over the writes. Whatever goes wrong
    // with the link, it must not undo work that succeeded.
    let sent: Awaited<ReturnType<typeof sendVerificationLink>> | null = null
    try {
      sent = await sendVerificationLink(runtime, {
        workspaceId: job.workspaceId,
        conversationId: job.conversationId,
      })
    } catch (error) {
      logger.error('sending a verification link threw', {
        conversationId: job.conversationId,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    if (!sent?.ok) {
      // The customer has just been told a link is coming. Leaving it at a log line is the
      // one way out of an AI turn that leaves somebody waiting with nobody told, which is
      // the rule this product is built around.
      logger.warn('the AI asked for a verification link that could not be sent', {
        conversationId: job.conversationId,
        reason: sent?.reason ?? 'threw',
      })
      await handOff(
        runtime,
        ports,
        logger,
        job,
        'tool_error',
        'The AI told this customer a verification link was on its way, and it could not be sent. They are waiting for it.',
      )
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
 *
 * A key outside the workspace is skipped rather than read. `storeMessage` refuses to write
 * one, so this only ever fires for a row written before that rule existed — but a foreign
 * image read here would be described by the model into this tenant's conversation, which is
 * the leak this product refuses to accept.
 */
async function readImages(
  runtime: Runtime,
  workspaceId: string,
  messages: (typeof schema.messages.$inferSelect)[],
): Promise<ImageInput[]> {
  const newest = [...messages].reverse().find((m) => m.direction === 'inbound')
  if (!newest) return []
  const content = newest.content
  if (content.kind !== 'image') return []

  const images: ImageInput[] = []
  for (const attachment of content.attachments) {
    if (!attachment.storageKey) continue
    if (!attachment.storageKey.startsWith(`${workspaceId}/`)) {
      runtime.logger.warn('skipped an attachment outside the workspace', {
        workspaceId,
        storageKey: attachment.storageKey,
      })
      continue
    }
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
