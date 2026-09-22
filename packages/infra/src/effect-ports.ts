import { getAdapter } from '@ci/channels'
import type { EffectContext, EffectPorts, Logger } from '@ci/core'
import { type Database, decryptJson, type Executor, newId, schema } from '@ci/db'
import type { Language } from '@ci/shared'
import { and, eq } from 'drizzle-orm'
import { summaryJobId, waitingHumanJobId } from './queues'
import { loadWorkspaceSettings, storeMessage } from './repo'
import type { Runtime } from './runtime'

/**
 * Port implementations backed by the queue, the database and Redis.
 *
 * Every one of these must be idempotent: the queue retries jobs, and `applyEffects`
 * re-runs the whole effect list when it does.
 */
/**
 * Where a port's writes go, and what to do with work that must not happen inside a
 * transaction.
 *
 * The inbound processor runs one customer event as a single unit, so its ports write
 * through its transaction rather than the pool. Notifying agents is the exception: it is a
 * Redis publish, and holding a Postgres transaction open across a network call to another
 * system is how a fast path becomes a slow one. Those are collected and flushed after the
 * commit, which is also the first moment they would be true.
 */
export type PortScope = {
  executor: Executor
  /** Run after the surrounding transaction commits. Immediate when there is not one. */
  afterCommit: (fn: () => Promise<void>) => void
}

export function createEffectPorts(
  runtime: Runtime,
  logger: Logger,
  scope?: PortScope,
): EffectPorts {
  const { db, publisher, outbox } = runtime
  const executor: Executor = scope?.executor ?? db
  const afterCommit = scope?.afterCommit ?? ((fn: () => Promise<void>) => void fn())

  return {
    /**
     * One turn per customer message, so no message can go unanswered.
     *
     * The job id is that message, which is what makes a retry of the same turn the same
     * job rather than a second answer. It is deliberately not the conversation: collapsing
     * a burst would drop whichever message arrived while a turn was running, and leaving a
     * customer unanswered is worse than answering them twice. Interleaved replies are the
     * accepted cost, and the turn re-reads the conversation before it acts.
     *
     * Where no triggering message exists — a verification a customer just completed — the
     * caller supplies its own key, because there is still exactly one turn owed.
     */
    async enqueueAiTurn(ctx, deliver) {
      await outbox.enqueue(executor, {
        queue: 'ai_turn',
        name: 'run',
        workspaceId: ctx.workspaceId,
        payload: {
          workspaceId: ctx.workspaceId,
          conversationId: ctx.conversationId,
          deliver,
          ...(ctx.triggerMessageId ? { triggerMessageId: ctx.triggerMessageId } : {}),
        },
        jobId: turnJobId(ctx),
      })
    },

    async enqueueSuggestion(ctx) {
      await outbox.enqueue(executor, {
        queue: 'suggestion',
        name: 'run',
        workspaceId: ctx.workspaceId,
        payload: {
          workspaceId: ctx.workspaceId,
          conversationId: ctx.conversationId,
          ...(ctx.triggerMessageId ? { triggerMessageId: ctx.triggerMessageId } : {}),
        },
        ...(ctx.triggerMessageId ? { jobId: `suggestion-${ctx.triggerMessageId}` } : {}),
      })
    },

    async sendAcknowledgement(ctx, language) {
      const settings = await loadWorkspaceSettings(db, ctx.workspaceId)
      const chosen: Language = language ?? settings.defaultLanguage
      const text = settings.acknowledgementText[chosen] ?? settings.acknowledgementText.en
      if (!text) return

      const stored = await storeMessage(executor, {
        workspaceId: ctx.workspaceId,
        conversationId: ctx.conversationId,
        direction: 'outbound',
        senderType: 'system',
        message: { kind: 'text', text },
        status: 'queued',
        redaction: settings.redaction,
      })

      // The message and its delivery are one promise: a stored reply nobody was told to
      // send is the silence this product refuses.
      await outbox.enqueue(executor, {
        queue: 'outbound',
        name: 'send',
        workspaceId: ctx.workspaceId,
        payload: {
          workspaceId: ctx.workspaceId,
          conversationId: ctx.conversationId,
          messageId: stored.id,
        },
        jobId: `outbound-${stored.id}`,
      })
    },

    async addInternalNote(ctx, body) {
      await executor.insert(schema.internalNotes).values({
        id: newId(),
        workspaceId: ctx.workspaceId,
        conversationId: ctx.conversationId,
        authorType: 'ai',
        body,
      })
    },

    async recordHandoff(ctx, reason, at) {
      // The instant comes from the state machine, so a replayed effect list collides with
      // the row it already wrote instead of counting one handoff twice.
      await executor
        .insert(schema.handoffEvents)
        .values({
          id: newId(),
          workspaceId: ctx.workspaceId,
          conversationId: ctx.conversationId,
          reason,
          occurredAt: at,
        })
        .onConflictDoNothing({
          target: [schema.handoffEvents.conversationId, schema.handoffEvents.occurredAt],
        })
    },

    /**
     * Best-effort, and after the commit.
     *
     * This is a Redis publish, so inside a transaction it would both hold a Postgres
     * connection across a call to another system and announce a state that might still roll
     * back. Deferred, it fires when what it describes is actually true.
     */
    async notifyAgents(ctx, reason) {
      afterCommit(async () => {
        await publisher.publish(ctx.workspaceId, {
          type: 'conversation.updated',
          conversationId: ctx.conversationId,
        })
        logger.info('agents notified', { conversationId: ctx.conversationId, reason })
      })
    },

    async scheduleWaitingHumanTimeout(ctx, minutes) {
      // A deterministic job id makes rescheduling replace the timer instead of adding one.
      await outbox.enqueue(executor, {
        queue: 'waiting_human',
        name: 'timeout',
        workspaceId: ctx.workspaceId,
        payload: { workspaceId: ctx.workspaceId, conversationId: ctx.conversationId },
        jobId: waitingHumanJobId(ctx.conversationId),
        delayMs: minutes * 60_000,
      })
    },

    async cancelWaitingHumanTimeout(ctx) {
      // Cancelling is a promise like any other: a timer that fires because its cancellation
      // was lost in a crash interrupts a customer a colleague is already talking to.
      await outbox.cancel(executor, {
        queue: 'waiting_human',
        jobId: waitingHumanJobId(ctx.conversationId),
      })
    },

    async enqueueSummary(ctx) {
      const rows = await executor
        .select({ customerId: schema.conversations.customerId })
        .from(schema.conversations)
        .where(
          and(
            eq(schema.conversations.id, ctx.conversationId),
            eq(schema.conversations.workspaceId, ctx.workspaceId),
          ),
        )
        .limit(1)
      const customerId = rows[0]?.customerId
      if (!customerId) return

      await outbox.enqueue(executor, {
        queue: 'summarize',
        name: 'run',
        workspaceId: ctx.workspaceId,
        payload: {
          workspaceId: ctx.workspaceId,
          customerId,
          conversationId: ctx.conversationId,
        },
        // One pending summary per conversation: resolving twice should not rewrite twice.
        jobId: summaryJobId(ctx.conversationId),
        options: { removeOnComplete: true },
      })
    },
  }
}

/**
 * The job id for a turn: the customer message that prompted it.
 *
 * Stable across every retry of that turn, which is what lets the processor recognise that
 * an earlier attempt already answered instead of paying for a second one. A context with no
 * triggering message carries its own key; one with neither gets a unique job, because there
 * is no way to tell two such turns apart and refusing to run is worse than running twice.
 */
function turnJobId(ctx: EffectContext): string | undefined {
  if (ctx.turnKey) return ctx.turnKey
  if (ctx.triggerMessageId) return `ai-turn-${ctx.triggerMessageId}`
  return undefined
}

/** Decrypt a channel's stored credentials and hand back its adapter. */
export async function loadChannel(db: Database, channelId: string, secretKey: string) {
  const rows = await db
    .select()
    .from(schema.channels)
    .where(eq(schema.channels.id, channelId))
    .limit(1)
  const channel = rows[0]
  if (!channel) throw new Error(`channel ${channelId} not found`)

  const adapter = getAdapter(channel.type)
  const rawConfig = channel.configEncrypted
    ? await decryptJson<unknown>(channel.configEncrypted, secretKey)
    : {}

  return { channel, adapter, config: adapter.parseConfig(rawConfig) }
}

export type { EffectContext }
