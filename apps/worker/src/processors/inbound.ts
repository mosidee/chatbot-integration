import type { WebhookRequest } from '@ci/channels'
import type { EffectPorts, Logger } from '@ci/core'
import { applyEffects, type ConversationState, transition } from '@ci/core'
import { type Database, schema } from '@ci/db'
import type { InboundJob, Runtime } from '@ci/infra'
import {
  applyReceipt,
  enrichIdentityProfile,
  loadChannel,
  loadWorkspaceSettings,
  resolveConversation,
  resolveInboundMedia,
  storeMessage,
} from '@ci/infra'
import { hasImages } from '@ci/shared'
import { and, eq } from 'drizzle-orm'

/**
 * Turn a stored webhook payload into conversation state.
 *
 * The HTTP handler only persisted the raw request and returned 200, because LINE and Meta
 * retry or disable endpoints that respond slowly. Everything meaningful happens here.
 */
/**
 * How long a LINE reply token stays usable. LINE documents about a minute and does not
 * guarantee anything beyond it, so this is deliberately conservative.
 */
const REPLY_TOKEN_TTL_MS = 55_000

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

      // A new identity has no name yet. Messenger's webhook carries only a page-scoped id,
      // so without this every conversation shows an opaque number in the inbox.
      if (resolved.isNew) {
        await enrichIdentityProfile(db, {
          workspaceId: job.workspaceId,
          identityId: resolved.channelIdentityId,
          externalId: event.externalId,
          adapter,
          config,
          logger,
        })
      }

      // A delivery or read receipt is not a message. It says something about messages we
      // already sent, so it updates their status and never appears in the thread. Handled
      // before anything is stored, or every receipt would leave a bubble behind.
      if (
        event.message.kind === 'event' &&
        (event.message.event === 'delivered' || event.message.event === 'read')
      ) {
        const watermark = Number(event.message.data.watermark ?? 0)
        const touched = await applyReceipt(db, {
          workspaceId: job.workspaceId,
          conversationId: resolved.conversationId,
          receipt: event.message.event,
          watermark: watermark > 0 ? watermark : event.timestamp.getTime(),
        })
        if (touched > 0) {
          await publisher.publish(job.workspaceId, {
            type: 'conversation.updated',
            conversationId: resolved.conversationId,
          })
        }
        continue
      }

      // Pull media into our own storage before the AI turn runs. A platform reference is
      // worthless later: LINE needs its blob endpoint and Messenger's CDN links expire.
      const media = await resolveInboundMedia(event.message, {
        workspaceId: job.workspaceId,
        channelType: channel.type,
        adapter,
        config,
        blob: runtime.blob,
        logger,
      })
      if (media.downloaded > 0 || media.failed > 0) {
        logger.info('inbound media resolved', {
          conversationId: resolved.conversationId,
          downloaded: media.downloaded,
          failed: media.failed,
        })
      }

      const stored = await storeMessage(db, {
        workspaceId: job.workspaceId,
        conversationId: resolved.conversationId,
        direction: 'inbound',
        senderType: 'customer',
        message: media.message,
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

      // A reply token lets us answer for free, but only once and only for about a minute.
      // It is carried on the conversation so the outbound step can use it while still fresh.
      if (event.replyToken) {
        await db
          .update(schema.conversations)
          .set({
            replyToken: event.replyToken,
            replyTokenExpiresAt: new Date(event.timestamp.getTime() + REPLY_TOKEN_TTL_MS),
          })
          .where(eq(schema.conversations.id, resolved.conversationId))
      }

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
