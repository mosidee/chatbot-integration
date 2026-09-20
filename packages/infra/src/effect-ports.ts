import { getAdapter } from '@ci/channels'
import type { EffectContext, EffectPorts, Logger } from '@ci/core'
import { type Database, decryptJson, schema } from '@ci/db'
import type { Language } from '@ci/shared'
import { eq } from 'drizzle-orm'
import { summaryJobId, waitingHumanJobId } from './queues'
import { loadWorkspaceSettings, storeMessage } from './repo'
import type { Runtime } from './runtime'

/**
 * Port implementations backed by the queue, the database and Redis.
 *
 * Every one of these must be idempotent: the queue retries jobs, and `applyEffects`
 * re-runs the whole effect list when it does.
 */
export function createEffectPorts(runtime: Runtime, logger: Logger): EffectPorts {
  const { db, queues, publisher } = runtime

  return {
    async enqueueAiTurn(ctx, deliver) {
      // One turn per inbound message, so no message can go unanswered.
      //
      // A burst therefore produces a reply each, and those replies interleave with the
      // later messages. Collapsing them needs a debounce: a deterministic job id alone
      // would drop any message that arrived while a turn was already running, which is a
      // worse failure than answering twice. Tracked for M2.
      await queues.ai_turn.add(
        'run',
        { workspaceId: ctx.workspaceId, conversationId: ctx.conversationId, deliver },
        { jobId: `ai-turn-${ctx.conversationId}-${Date.now()}` },
      )
    },

    async enqueueSuggestion(ctx) {
      await queues.suggestion.add('run', {
        workspaceId: ctx.workspaceId,
        conversationId: ctx.conversationId,
      })
    },

    async sendAcknowledgement(ctx, language) {
      const settings = await loadWorkspaceSettings(db, ctx.workspaceId)
      const chosen: Language = language ?? settings.defaultLanguage
      const text = settings.acknowledgementText[chosen] ?? settings.acknowledgementText.en
      if (!text) return

      const stored = await storeMessage(db, {
        workspaceId: ctx.workspaceId,
        conversationId: ctx.conversationId,
        direction: 'outbound',
        senderType: 'system',
        message: { kind: 'text', text },
        status: 'queued',
        redaction: settings.redaction,
      })

      await queues.outbound.add('send', {
        workspaceId: ctx.workspaceId,
        conversationId: ctx.conversationId,
        messageId: stored.id,
      })
    },

    async addInternalNote(ctx, body) {
      await db.insert(schema.internalNotes).values({
        id: crypto.randomUUID(),
        workspaceId: ctx.workspaceId,
        conversationId: ctx.conversationId,
        authorType: 'ai',
        body,
      })
    },

    async notifyAgents(ctx, reason) {
      await publisher.publish(ctx.workspaceId, {
        type: 'conversation.updated',
        conversationId: ctx.conversationId,
      })
      logger.info('agents notified', { conversationId: ctx.conversationId, reason })
    },

    async scheduleWaitingHumanTimeout(ctx, minutes) {
      // A deterministic job id makes rescheduling replace the timer instead of adding one.
      await queues.waiting_human.add(
        'timeout',
        { workspaceId: ctx.workspaceId, conversationId: ctx.conversationId },
        { delay: minutes * 60_000, jobId: waitingHumanJobId(ctx.conversationId) },
      )
    },

    async cancelWaitingHumanTimeout(ctx) {
      const job = await queues.waiting_human.getJob(waitingHumanJobId(ctx.conversationId))
      await job?.remove().catch(() => {
        // Already running or gone; the processor re-checks the mode before acting.
      })
    },

    async enqueueSummary(ctx) {
      const rows = await db
        .select({ customerId: schema.conversations.customerId })
        .from(schema.conversations)
        .where(eq(schema.conversations.id, ctx.conversationId))
        .limit(1)
      const customerId = rows[0]?.customerId
      if (!customerId) return

      await queues.summarize.add(
        'run',
        { workspaceId: ctx.workspaceId, customerId, conversationId: ctx.conversationId },
        // One pending summary per conversation: resolving twice should not rewrite twice.
        { jobId: summaryJobId(ctx.conversationId), removeOnComplete: true },
      )
    },
  }
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
