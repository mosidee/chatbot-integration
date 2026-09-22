import type { WebhookRequest } from '@ci/channels'
import type { EffectPorts, Logger } from '@ci/core'
import { applyEffects, type ConversationState, transition } from '@ci/core'
import { type Executor, schema } from '@ci/db'
import type { InboundJob, Runtime, TrustedEnvelope } from '@ci/infra'
import {
  applyReceipt,
  conversationForReceipt,
  createEffectPorts,
  enrichIdentityProfile,
  loadChannel,
  resolveConversation,
  resolveInboundMedia,
  storeMessage,
  workspaceIsWorkable,
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
  // Unused: this processor builds its own ports, bound to the transaction each event runs
  // in, so that the work it promises commits with the message that prompted it.
  _ports: EffectPorts,
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

  const workspace = await workspaceIsWorkable(db, job.workspaceId, logger, 'inbound')
  // The row is left unprocessed on purpose: nothing was read from it, and a restored
  // workspace should not have to explain a gap in its own audit trail.
  if (!workspace) return
  const settings = workspace.settings
  const { channel, adapter, config } = await loadChannel(db, job.channelId, env.APP_SECRET_KEY)

  try {
    const request = eventRow.payload as WebhookRequest
    const events = adapter.parseInbound(request, config)

    /**
     * A proved identity comes from the envelope, never from the body.
     *
     * `ingestInternal` is the only thing that writes `trusted`, and only the widget session
     * route passes one, having just verified the host application's token. The adapter that
     * parsed the body above cannot see this and cannot set it: a `verified` block inside a
     * request used to be copied straight onto the identity row and bound into tool calls,
     * and the public webhook route reached that adapter with a channel id printed in the
     * host's own page source.
     */
    const trusted = (eventRow.payload as TrustedEnvelope).verified

    for (const event of events) {
      // Receipts are handled before a conversation is resolved, because resolving one
      // creates it. A receipt arriving after its conversation was resolved would otherwise
      // open a fresh, empty conversation, which is exactly when receipts tend to arrive.
      if (
        event.message.kind === 'event' &&
        (event.message.event === 'delivered' || event.message.event === 'read')
      ) {
        const conversationId = await conversationForReceipt(db, {
          channelId: job.channelId,
          externalId: event.externalId,
        })
        if (!conversationId) continue

        const watermark = Number(event.message.data.watermark ?? 0)
        const touched = await applyReceipt(db, {
          workspaceId: job.workspaceId,
          conversationId,
          receipt: event.message.event,
          watermark: watermark > 0 ? watermark : event.timestamp.getTime(),
        })
        if (touched > 0) {
          await publisher.publish(job.workspaceId, {
            type: 'conversation.updated',
            conversationId,
          })
        }
        continue
      }

      const resolved = await resolveConversation(db, {
        workspaceId: job.workspaceId,
        channelId: job.channelId,
        event: trusted ? { ...event, verified: trusted } : event,
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

      /**
       * One customer event, one commit.
       *
       * The message, the state it moves the conversation to, and the work that follows —
       * an AI turn, an acknowledgement, a timer — are written together. Held apart, a
       * crash between them left the message stored and the work never queued, and the
       * retry then saw the stored message, called it a duplicate and skipped effects that
       * had never run: a customer's question sat in the thread that nobody was told about.
       *
       * The duplicate check below is only sound *because* of this. A message that is here
       * means its transaction committed, which means everything it owed was promised too.
       *
       * Media was downloaded before this opens, and the conversation resolved before that:
       * both take network calls or their own row locks, and neither belongs inside a
       * transaction held across the rest of the work.
       */
      const notifications: (() => Promise<void>)[] = []
      const outcome = await db.transaction(async (tx) => {
        const txPorts = createEffectPorts(runtime, logger, {
          executor: tx,
          afterCommit: (fn) => notifications.push(fn),
        })

        const stored = await storeMessage(tx, {
          workspaceId: job.workspaceId,
          conversationId: resolved.conversationId,
          direction: 'inbound',
          senderType: 'customer',
          message: media.message,
          platformMessageId: event.platformEventId,
          redaction: settings.redaction,
        })

        if (stored.duplicate) return { duplicate: true as const }

        // A reply token lets us answer for free, but only once and only for about a
        // minute. It is carried on the conversation so the outbound step can use it while
        // still fresh.
        if (event.replyToken) {
          await tx
            .update(schema.conversations)
            .set({
              replyToken: event.replyToken,
              replyTokenExpiresAt: new Date(event.timestamp.getTime() + REPLY_TOKEN_TTL_MS),
            })
            .where(eq(schema.conversations.id, resolved.conversationId))
        }

        // Channel events (follow, read receipts) update state but are not questions to
        // answer.
        if (event.message.kind === 'event') return { duplicate: false as const, stored }

        const conversationRows = await tx
          .select()
          .from(schema.conversations)
          .where(eq(schema.conversations.id, resolved.conversationId))
          .limit(1)
        const conversation = conversationRows[0]
        if (!conversation) return { duplicate: false as const, stored }

        const state: ConversationState = {
          mode: conversation.mode,
          status: conversation.status,
          assigneeUserId: conversation.assigneeUserId,
          waitingHumanSince: conversation.waitingHumanSince,
          handoffReason: conversation.handoffReason,
        }

        // Media the AI cannot interpret becomes a handoff, unless a vision slot is
        // configured and the message is an image.
        const visionConfigured = await hasVisionSlot(tx, job.workspaceId)
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
          await tx
            .update(schema.conversations)
            .set({ ...patch, updatedAt: new Date() })
            .where(eq(schema.conversations.id, resolved.conversationId))
        }

        await applyEffects(
          effects,
          {
            workspaceId: job.workspaceId,
            conversationId: resolved.conversationId,
            // Names the turn that answers this message, so a retry of it is the same job
            // rather than a second reply.
            triggerMessageId: stored.id,
          },
          txPorts,
          logger,
        )

        return { duplicate: false as const, stored }
      })

      if (outcome.duplicate) {
        logger.info('duplicate platform message ignored', {
          conversationId: resolved.conversationId,
          platformMessageId: event.platformEventId,
        })
        continue
      }

      /**
       * Everything that talks to somebody else, once the commit means it is true.
       *
       * A publish inside the transaction would both hold a Postgres connection across a
       * call to Redis and announce a message that might still roll back.
       */
      await publisher.publish(job.workspaceId, {
        type: 'message.created',
        conversationId: resolved.conversationId,
        messageId: outcome.stored.id,
      })
      for (const notify of notifications) {
        await notify().catch((error: unknown) => {
          logger.warn('notifying agents failed after the event was handled', {
            conversationId: resolved.conversationId,
            error: error instanceof Error ? error.message : String(error),
          })
        })
      }
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

async function hasVisionSlot(db: Executor, workspaceId: string): Promise<boolean> {
  const rows = await db
    .select({ model: schema.taskSlots.primaryModel })
    .from(schema.taskSlots)
    .where(and(eq(schema.taskSlots.workspaceId, workspaceId), eq(schema.taskSlots.task, 'vision')))
    .limit(1)
  return Boolean(rows[0]?.model)
}
