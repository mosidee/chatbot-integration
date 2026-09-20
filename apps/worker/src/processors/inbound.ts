import type { WebhookRequest } from '@ci/channels'
import type { EffectPorts, Logger } from '@ci/core'
import { applyEffects, type ConversationState, transition } from '@ci/core'
import { type Database, schema } from '@ci/db'
import type { InboundJob, Runtime } from '@ci/infra'
import { hasImages } from '@ci/shared'
import { and, eq } from 'drizzle-orm'
import { loadChannel } from '../ports'
import { loadWorkspaceSettings, resolveConversation, storeMessage } from '../repo'

/**
 * Turn a stored webhook payload into conversation state.
 *
 * The HTTP handler only persisted the raw request and returned 200, because LINE and Meta
 * retry or disable endpoints that respond slowly. Everything meaningful happens here.
 */
export async function processInbound(
  runtime: Runtime,
  ports: EffectPorts,
  logger: Logger,
  job: InboundJob,
): Promise<void> {
  const { db, env, publisher } = runtime

  const eventRows = await db
    .select()
    .from(schema.inboundEvents)
    .where(
      and(
        eq(schema.inboundEvents.id, job.inboundEventId),
        eq(schema.inboundEvents.workspaceId, job.workspaceId),
      ),
    )
    .limit(1)

  const eventRow = eventRows[0]
  if (!eventRow) {
    logger.warn('inbound event vanished', { inboundEventId: job.inboundEventId })
    return
  }
  if (eventRow.processedAt) {
    logger.info('inbound event already processed', { inboundEventId: job.inboundEventId })
    return
  }

  const settings = await loadWorkspaceSettings(db, job.workspaceId)
  const { channel, adapter, config } = await loadChannel(db, job.channelId, env.APP_SECRET_KEY)

  try {
    const request = eventRow.payload as WebhookRequest
    const events = adapter.parseInbound(request, config)

    for (const event of events) {
      const resolved = await resolveConversation(db, {
        workspaceId: job.workspaceId,
        channelId: job.channelId,
        event,
        defaultMode: channel.defaultMode ?? settings.defaultMode,
        defaultLanguage: settings.defaultLanguage,
        messagingWindowHours: adapter.capabilities.messagingWindowHours,
      })

      const stored = await storeMessage(db, {
        workspaceId: job.workspaceId,
        conversationId: resolved.conversationId,
        direction: 'inbound',
        senderType: 'customer',
        message: event.message,
        platformMessageId: event.platformEventId,
        redaction: settings.redaction,
      })

      if (stored.duplicate) {
        logger.info('duplicate platform message ignored', {
          conversationId: resolved.conversationId,
          platformMessageId: event.platformEventId,
        })
        continue
      }

      await publisher.publish(job.workspaceId, {
        type: 'message.created',
        conversationId: resolved.conversationId,
        messageId: stored.id,
      })

      // Channel events (follow, read receipts) update state but are not questions to answer.
      if (event.message.kind === 'event') continue

      const conversationRows = await db
        .select()
        .from(schema.conversations)
        .where(eq(schema.conversations.id, resolved.conversationId))
        .limit(1)
      const conversation = conversationRows[0]
      if (!conversation) continue

      const state: ConversationState = {
        mode: conversation.mode,
        status: conversation.status,
        assigneeUserId: conversation.assigneeUserId,
        waitingHumanSince: conversation.waitingHumanSince,
        handoffReason: conversation.handoffReason,
      }

      // Media the AI cannot interpret becomes a handoff, unless a vision slot is configured
      // and the message is an image.
      const visionConfigured = await hasVisionSlot(db, job.workspaceId)
      const isUninterpretableMedia =
        event.message.kind === 'file' ||
        event.message.kind === 'audio' ||
        event.message.kind === 'video' ||
        (hasImages(event.message) && !visionConfigured)

      const { patch, effects } = transition(
        state,
        { type: 'customer_message', at: event.timestamp, isMedia: isUninterpretableMedia },
        {
          waitingHumanFallbackMinutes: settings.waitingHumanFallbackMinutes,
          handoffOnUnsupportedMedia: true,
        },
      )

      if (Object.keys(patch).length > 0) {
        await db
          .update(schema.conversations)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(schema.conversations.id, resolved.conversationId))
      }

      await applyEffects(
        effects,
        { workspaceId: job.workspaceId, conversationId: resolved.conversationId },
        ports,
        logger,
      )
    }

    await db
      .update(schema.inboundEvents)
      .set({ processedAt: new Date(), error: null })
      .where(eq(schema.inboundEvents.id, eventRow.id))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await db
      .update(schema.inboundEvents)
      .set({ error: message })
      .where(eq(schema.inboundEvents.id, eventRow.id))
    throw error
  }
}

async function hasVisionSlot(db: Database, workspaceId: string): Promise<boolean> {
  const rows = await db
    .select({ model: schema.taskSlots.primaryModel })
    .from(schema.taskSlots)
    .where(and(eq(schema.taskSlots.workspaceId, workspaceId), eq(schema.taskSlots.task, 'vision')))
    .limit(1)
  return Boolean(rows[0]?.model)
}
