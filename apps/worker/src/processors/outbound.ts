import { splitText } from '@ci/channels'
import type { EffectPorts, Logger } from '@ci/core'
import { schema } from '@ci/db'
import type { OutboundJob, Runtime } from '@ci/infra'
import { loadChannel, workspaceIsWorkable } from '@ci/infra'
import type { NormalizedMessage } from '@ci/shared'
import { and, eq } from 'drizzle-orm'

/**
 * Deliver a stored outbound message through its channel.
 *
 * The message row is written before delivery is attempted, so an agent always sees what
 * was meant to go out even when the platform rejects it. Long text is split to the
 * platform's limit here rather than in the AI, which should write naturally.
 */
export async function processOutbound(
  runtime: Runtime,
  _ports: EffectPorts,
  logger: Logger,
  job: OutboundJob,
): Promise<void> {
  const { db, env, publisher } = runtime

  // The only processor that gains a query here rather than reusing one it already made.
  // It is a primary-key lookup, and it is what stops a message queued a second before a
  // suspension going out a second after it.
  if (!(await workspaceIsWorkable(db, job.workspaceId, logger, 'outbound'))) return

  const rows = await db
    .select()
    .from(schema.messages)
    .where(
      and(eq(schema.messages.id, job.messageId), eq(schema.messages.workspaceId, job.workspaceId)),
    )
    .limit(1)

  const message = rows[0]
  if (!message) {
    logger.warn('outbound message vanished', { messageId: job.messageId })
    return
  }
  if (message.status === 'sent' || message.status === 'delivered') return

  const conversationRows = await db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.id, job.conversationId))
    .limit(1)
  const conversation = conversationRows[0]
  if (!conversation) return

  const identityRows = await db
    .select()
    .from(schema.channelIdentities)
    .where(eq(schema.channelIdentities.id, conversation.channelIdentityId))
    .limit(1)
  const identity = identityRows[0]
  if (!identity) return

  const { adapter, config } = await loadChannel(db, conversation.channelId, env.APP_SECRET_KEY)

  // A reply token is free but single-use and short-lived. Use it only while fresh, and only
  // for the first part of a split message; the rest go out as pushes.
  const replyTokenIsFresh =
    conversation.replyToken !== null &&
    conversation.replyTokenExpiresAt !== null &&
    conversation.replyTokenExpiresAt.getTime() > Date.now()

  const replyToken = replyTokenIsFresh ? conversation.replyToken : null

  // Cleared before the attempt, not after it. A reply token is single-use whatever the
  // outcome, so clearing it on success only would leave a spent token behind for the retry
  // to present again, and LINE would reject it again.
  if (replyToken) {
    await db
      .update(schema.conversations)
      .set({ replyToken: null, replyTokenExpiresAt: null })
      .where(eq(schema.conversations.id, conversation.id))
  }

  try {
    const parts = toSendableParts(message.content, adapter.capabilities.maxTextLength)
    let lastPlatformId: string | null = null

    for (const [index, part] of parts.entries()) {
      const result = await adapter.send(identity.externalId, part, config, {
        messagingWindowExpiresAt: conversation.messagingWindowExpiresAt,
        // Only the first part can use the token; the rest are pushes.
        ...(index === 0 && replyToken ? { replyToken } : {}),
      })
      lastPlatformId = result.platformMessageId
    }

    await db
      .update(schema.messages)
      .set({ status: 'sent', platformMessageId: lastPlatformId, error: null })
      .where(eq(schema.messages.id, message.id))

    await publisher.publish(job.workspaceId, {
      type: 'message.updated',
      conversationId: job.conversationId,
      messageId: message.id,
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await db
      .update(schema.messages)
      .set({ status: 'failed', error: reason })
      .where(eq(schema.messages.id, message.id))

    await publisher.publish(job.workspaceId, {
      type: 'message.updated',
      conversationId: job.conversationId,
      messageId: message.id,
    })
    throw error
  }
}

/** Split only text; other kinds go out as one message. */
function toSendableParts(message: NormalizedMessage, maxLength: number): NormalizedMessage[] {
  if (message.kind !== 'text') return [message]
  const chunks = splitText(message.text, maxLength)
  if (chunks.length <= 1) return [message]
  return chunks.map((text) => ({ kind: 'text' as const, text }))
}
