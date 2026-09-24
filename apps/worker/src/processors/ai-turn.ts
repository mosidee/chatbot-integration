import {
  type AgentTurnInput,
  aiMaySend,
  applyEffects,
  type ConversationTurn,
  detectLanguage,
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
  createEffectPorts,
  createTurnRetrieval,
  createWorkspaceToolSources,
  describeWriteFailure,
  isWorkspaceKey,
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
  workspaceProviderFetch,
} from '@ci/infra'
import type { HandoffReason } from '@ci/shared'
import { and, desc, eq } from 'drizzle-orm'

/**
 * Run one AI turn and deliver the outcome.
 *
 * The mode is read three times, and that is the point. A model call takes seconds, and a
 * colleague can take the conversation over during any of them — so it is checked before the
 * call is worth making, again before the tenant's own systems are written to, and again
 * before the reply is stored and queued. The rule is that the AI never sends while a human
 * owns the conversation, and it has to hold at the moment of sending rather than the moment
 * of deciding. Until recently only the first check existed, and the comment here claimed
 * otherwise.
 *
 * The turn is also idempotent. Its job id is the customer message that prompted it, written
 * onto the reply as `turn_key`, so a retry that finds one knows an earlier attempt already
 * answered: it resumes at delivery rather than paying for a second answer and sending the
 * customer two.
 */
/** Long enough for a primary and a fallback attempt, short enough that somebody is told. */
const TURN_DEADLINE_MS = 150_000

export async function processAiTurn(
  runtime: Runtime,
  ports: EffectPorts,
  logger: Logger,
  job: AiTurnJob,
  meta?: JobMeta,
): Promise<void> {
  const { db, env, publisher } = runtime

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

  // The first of three. Cheapest to ask before a model is called at all.
  if (job.deliver === 'send' && !aiMaySend(conversation.mode)) {
    logger.info('AI turn abandoned: a human owns the conversation', {
      conversationId: job.conversationId,
      mode: conversation.mode,
    })
    await suggestInstead(runtime, job)
    return
  }

  /**
   * Did an earlier attempt of this same turn already answer?
   *
   * The job id is stable across retries, so a reply carrying it means the model has already
   * been called and the customer already has an answer — or is about to, if the failure was
   * in queueing delivery. Either way the work owed is delivery, not another turn. Without
   * this a throw anywhere after the reply was stored bought a second model call, a second
   * reply to the customer and a second pass over the tenant's writes.
   */
  const turnKey = meta?.jobId ?? null
  if (turnKey) {
    const already = await db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(
        and(eq(schema.messages.workspaceId, job.workspaceId), eq(schema.messages.turnKey, turnKey)),
      )
      .limit(1)
    const answered = already[0]
    if (answered) {
      logger.info('AI turn already answered on an earlier attempt; delivering only', {
        conversationId: job.conversationId,
        messageId: answered.id,
      })
      await runtime.outbox.enqueue(db, {
        queue: 'outbound',
        name: 'send',
        workspaceId: job.workspaceId,
        payload: {
          workspaceId: job.workspaceId,
          conversationId: job.conversationId,
          messageId: answered.id,
        },
        jobId: `outbound-${answered.id}`,
      })
      return
    }
  }

  /** Is the AI still the one answering? Asked again where it matters. */
  const stillAiOwned = async (): Promise<boolean> => {
    if (job.deliver !== 'send') return true
    const rows = await db
      .select({ mode: schema.conversations.mode })
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.id, job.conversationId),
          eq(schema.conversations.workspaceId, job.workspaceId),
        ),
      )
      .limit(1)
    const mode = rows[0]?.mode
    return mode !== undefined && aiMaySend(mode)
  }

  const providerFetch = await workspaceProviderFetch(runtime, job.workspaceId)
  const aiConfig = await loadAiConfig(
    db,
    job.workspaceId,
    env.APP_SECRET_KEY,
    settings.modelPrices,
    providerFetch,
  )
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
  const writeKey = turnKey ?? `turn-${job.conversationId}-${Date.now()}`

  // Retrieval is bound to this workspace, customer and conversation before the model sees
  // it, so the tools it is offered cannot widen their own scope.
  const embedSlot = usableSlot(aiConfig, 'embed')
  const retrieval = createTurnRetrieval(db, {
    workspaceId: job.workspaceId,
    customerId: conversation.customerId,
    conversationId: job.conversationId,
    // Recall may reach this conversation's own earlier episodes, just not what is on screen.
    activeWindowStart: recentMessages[0]?.createdAt ?? null,
    language: customer.primaryLanguage ?? settings.defaultLanguage,
    channelType: context.channel.type,
    embedSlot,
    rerankSlot: usableSlot(aiConfig, 'rerank'),
    externalRetrieval: await resolveExternalRetrieval(
      settings.externalRetrieval,
      env.APP_SECRET_KEY,
      providerFetch,
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
    // The whole turn's budget, fallback included. A provider that accepts the request and
    // never answers now ends in a handoff instead of holding a worker slot indefinitely.
    signal: AbortSignal.timeout(TURN_DEADLINE_MS),
    input,
    chatSlot,
    visionSlot,
    prices: aiConfig.prices,
    mode: job.deliver === 'draft' ? 'suggest' : 'answer',
    bound,
    turnKey: writeKey,
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

  /**
   * The second check: before anything this turn learned is written to the customer.
   *
   * A colleague who took over while the model was thinking now owns the conversation, and
   * fields and tags the AI inferred on its way to an answer nobody will send are its
   * guesses, not theirs. The turn becomes a suggestion for them instead.
   */
  if (!(await stillAiOwned())) {
    logger.info('a human took over during the turn; nothing it learned was written', {
      conversationId: job.conversationId,
    })
    await suggestInstead(runtime, job)
    return
  }

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
    /**
     * The second check, and the one with teeth. Everything past here changes something in
     * the tenant's own systems, and a colleague who took the conversation over during the
     * model call has not agreed to any of it.
     */
    if (!(await stillAiOwned())) {
      logger.info('a human took over during the turn; the writes were not carried out', {
        conversationId: job.conversationId,
        tools: result.pendingWrites.map((write) => write.tool),
      })
      await suggestInstead(runtime, job)
      return
    }

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

  /**
   * The third check, immediately before the reply becomes real.
   *
   * A human who took over while the model was writing has answered the customer themselves
   * by now. Sending on top of them is the thing the product's central rule exists to stop,
   * and the gap between deciding and sending is exactly where it used to be possible.
   */
  if (!(await stillAiOwned())) {
    logger.info('a human took over during the turn; the reply was not sent', {
      conversationId: job.conversationId,
      wrote: result.pendingWrites.map((write) => write.tool),
    })
    await suggestInstead(runtime, job)
    return
  }

  /**
   * Stored, dated and queued as one commit.
   *
   * A reply in the thread that nothing was told to deliver is a customer waiting on an
   * answer everybody else believes was given. `turnKey` goes on the row here; the unique
   * index behind it is what stops two attempts of the same job both answering.
   */
  const committed = await db.transaction(async (tx) => {
    /**
     * The last check, and the only one that cannot race.
     *
     * Every earlier check is its own read, and a takeover could land between it and this
     * commit. Locking the conversation row here makes the two serialise: a takeover that
     * already committed is seen, and one that has not waits until this reply is stored and
     * queued — where the outbound job's own check then withholds it.
     */
    if (job.deliver === 'send') {
      const [locked] = await tx
        .select({ mode: schema.conversations.mode })
        .from(schema.conversations)
        .where(
          and(
            eq(schema.conversations.id, job.conversationId),
            eq(schema.conversations.workspaceId, job.workspaceId),
          ),
        )
        .for('update')
      if (!locked || !aiMaySend(locked.mode)) return false
    }

    const message = await storeMessage(tx, {
      workspaceId: job.workspaceId,
      conversationId: job.conversationId,
      direction: 'outbound',
      senderType: 'ai',
      message: { kind: 'text', text: result.text },
      status: 'queued',
      aiTraceId: traceId,
      turnKey,
      redaction: settings.redaction,
    })

    /**
     * The index caught what the read at the top of this function could not: two attempts
     * of this job in flight at once, both past that read. The insert did nothing, so the
     * id in hand names no row — the reply that exists is the other attempt's, and delivery
     * is what is owed for it.
     */
    let messageId = message.id
    if (message.duplicate && turnKey) {
      const winner = await tx
        .select({ id: schema.messages.id })
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.workspaceId, job.workspaceId),
            eq(schema.messages.turnKey, turnKey),
          ),
        )
        .limit(1)
      if (winner[0]) messageId = winner[0].id
    }

    await updateConversation(tx, job.workspaceId, job.conversationId, {
      lastMessageAt: new Date(),
    })

    await runtime.outbox.enqueue(tx, {
      queue: 'outbound',
      name: 'send',
      workspaceId: job.workspaceId,
      payload: {
        workspaceId: job.workspaceId,
        conversationId: job.conversationId,
        messageId,
      },
      jobId: `outbound-${messageId}`,
    })
    return true
  })

  if (!committed) {
    logger.info('a human took over as the reply was being stored; it was not sent', {
      conversationId: job.conversationId,
    })
    await suggestInstead(runtime, job)
    return
  }

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

/**
 * Hand what the AI wrote to a person instead of the customer.
 *
 * Used wherever a turn stops because a colleague has taken the conversation over. The
 * suggestion is keyed on the same customer message, so the person sees one draft however
 * many times the job was retried.
 */
async function suggestInstead(runtime: Runtime, job: AiTurnJob): Promise<void> {
  await runtime.outbox.enqueue(runtime.db, {
    queue: 'suggestion',
    name: 'run',
    workspaceId: job.workspaceId,
    payload: {
      workspaceId: job.workspaceId,
      conversationId: job.conversationId,
      ...(job.triggerMessageId ? { triggerMessageId: job.triggerMessageId } : {}),
    },
    ...(job.triggerMessageId ? { jobId: `suggestion-${job.triggerMessageId}` } : {}),
  })
}

/**
 * The turn failed for good: every retry threw before it could reply or hand off itself.
 *
 * Anything outside the model call — loading context, decrypting a provider key, a database
 * error — used to exhaust the job's attempts with a log line, and the customer waited for
 * an answer nobody knew was owed. This is the last path out of a turn, so it hands off like
 * the others. `handOff` is safe to repeat: the state machine ignores a second handoff.
 */
export async function handOffAfterFailure(
  runtime: Runtime,
  ports: EffectPorts,
  logger: Logger,
  job: AiTurnJob,
  error: Error,
): Promise<void> {
  await handOff(
    runtime,
    ports,
    logger,
    job,
    'model_error',
    `The AI turn failed after every retry, so this needs a person: ${error.message}`,
  )
}

async function handOff(
  runtime: Runtime,
  // Unused: the handoff builds its own ports, bound to the transaction it runs in.
  _ports: EffectPorts,
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
    .where(
      and(
        eq(schema.conversations.id, job.conversationId),
        eq(schema.conversations.workspaceId, job.workspaceId),
      ),
    )
    .limit(1)
  const conversation = rows[0]
  if (!conversation) return

  /**
   * The language to apologise in.
   *
   * Read here rather than threaded through five call sites: every one of them is a path
   * that has already given up on answering, so one more query costs nothing that matters.
   * The customer's last message is the best evidence available — better than the language
   * recorded on their record, which is seeded from the workspace default and never
   * updated — and `detectLanguage` returns null rather than guessing when the message is
   * a photograph, an emoji or a number.
   */
  const lastCustomerMessage = await db
    .select({ text: schema.messages.text })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.workspaceId, job.workspaceId),
        eq(schema.messages.conversationId, job.conversationId),
        eq(schema.messages.senderType, 'customer'),
      ),
    )
    .orderBy(desc(schema.messages.createdAt))
    .limit(1)

  /**
   * The instant this handoff happened, the same on every attempt of the job.
   *
   * It keys both the handoff row and the acknowledgement, so it has to be something a retry
   * computes identically: the customer message the turn is answering, where there is one.
   */
  const trigger = job.triggerMessageId
    ? await db
        .select({ createdAt: schema.messages.createdAt })
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.id, job.triggerMessageId),
            eq(schema.messages.workspaceId, job.workspaceId),
          ),
        )
        .limit(1)
    : []

  const { patch, effects } = transition(
    {
      mode: conversation.mode,
      status: conversation.status,
      assigneeUserId: conversation.assigneeUserId,
      waitingHumanSince: conversation.waitingHumanSince,
      handoffReason: conversation.handoffReason,
    },
    {
      type: 'ai_handoff',
      at: trigger[0]?.createdAt ?? new Date(),
      reason,
      note,
      language: detectLanguage(lastCustomerMessage[0]?.text),
    },
    { waitingHumanFallbackMinutes: settings.waitingHumanFallbackMinutes },
  )

  /**
   * The new mode and everything it owes, in one commit.
   *
   * They used to be two steps. If an effect threw after the mode was saved, the retry found
   * the conversation already waiting: a send stopped at its first mode check, and the
   * acknowledgement, the note, the nudge and the fallback timer were lost for good — the
   * customer heard nothing and no colleague was told. Together, a retry finds either
   * nothing done or everything done, and the state machine ignores a second handoff.
   */
  const notifications: (() => Promise<void>)[] = []
  await db.transaction(async (tx) => {
    if (Object.keys(patch).length > 0) {
      await updateConversation(tx, job.workspaceId, job.conversationId, patch)
    }
    await applyEffects(
      effects,
      { workspaceId: job.workspaceId, conversationId: job.conversationId },
      createEffectPorts(runtime, logger, {
        executor: tx,
        afterCommit: (fn) => notifications.push(fn),
      }),
      logger,
    )
  })
  for (const notify of notifications) {
    await notify().catch((error: unknown) => {
      logger.warn('notifying agents failed after a handoff', {
        conversationId: job.conversationId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }
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
    if (!isWorkspaceKey(workspaceId, attachment.storageKey)) {
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
