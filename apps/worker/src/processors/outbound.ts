import { splitText, UncertainDeliveryError } from '@ci/channels'
import { aiMaySend, type EffectPorts, type Logger } from '@ci/core'
import { schema } from '@ci/db'
import type { JobMeta, OutboundJob, Runtime } from '@ci/infra'
import { customerLanguage, loadChannel, withMediaLinks, workspaceIsWorkable } from '@ci/infra'
import type { NormalizedMessage } from '@ci/shared'
import { and, eq, sql } from 'drizzle-orm'

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
  meta?: JobMeta,
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
  /**
   * `read` belongs here too. Receipts only ever raise a status, so a message the customer
   * has already opened is as sent as one can be — and leaving it out meant a retry sent it
   * to them a second time.
   */
  if (message.status === 'sent' || message.status === 'delivered' || message.status === 'read') {
    return
  }
  // Withdrawn, or possibly delivered already: neither is this job's to send again.
  if (message.status === 'canceled' || message.status === 'uncertain') return

  /**
   * An AI reply a human has since overtaken is not delivered.
   *
   * The turn checks the mode before it stores the reply, but this job can sit in the queue
   * behind others, and a colleague who took the conversation over in between has answered
   * the customer themselves by now. Only the AI's own words are held back: a human's
   * message and a system acknowledgement were never subject to the rule.
   */
  if (message.senderType === 'ai') {
    const modeRows = await db
      .select({ mode: schema.conversations.mode })
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.id, job.conversationId),
          eq(schema.conversations.workspaceId, job.workspaceId),
        ),
      )
      .limit(1)
    const mode = modeRows[0]?.mode
    if (mode !== undefined && !aiMaySend(mode)) {
      logger.info('an AI reply was not delivered: a human took the conversation over', {
        conversationId: job.conversationId,
        messageId: message.id,
        mode,
      })
      await db
        .update(schema.messages)
        .set({ status: 'canceled', error: 'A colleague took over before this was delivered' })
        .where(eq(schema.messages.id, message.id))
      await publisher
        .publish(job.workspaceId, {
          type: 'message.updated',
          conversationId: job.conversationId,
          messageId: message.id,
        })
        .catch(() => {
          // The row is already right; the console will catch up on its next poll.
        })
      return
    }
  }

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

  /**
   * Claimed before the attempt, not cleared after it.
   *
   * A reply token is single-use whatever the outcome, so releasing it only on success would
   * leave a spent token for the retry to present again. And the claim is conditional on the
   * token still being the one that was read: two jobs for one conversation — a reply and a
   * verification link, say — would otherwise both present it, and LINE would reject the
   * second.
   */
  let claimedToken: string | null = null
  if (replyToken) {
    const claimed = await db
      .update(schema.conversations)
      .set({ replyToken: null, replyTokenExpiresAt: null })
      .where(
        and(
          eq(schema.conversations.id, conversation.id),
          eq(schema.conversations.replyToken, replyToken),
        ),
      )
      .returning({ id: schema.conversations.id })
    if (claimed.length > 0) claimedToken = replyToken
  }

  const announce = () =>
    publisher
      .publish(job.workspaceId, {
        type: 'message.updated',
        conversationId: job.conversationId,
        messageId: message.id,
      })
      .catch((error: unknown) => {
        logger.warn('could not announce a delivery outcome', {
          messageId: message.id,
          error: error instanceof Error ? error.message : String(error),
        })
      })

  try {
    /**
     * A file we hold becomes a link before the adapter sees it.
     *
     * LINE and Messenger do not take bytes: they take a URL and fetch it themselves, from
     * their own servers, with no session. So the one place that knows both the storage key
     * and the public address of this installation turns the first into the second, and the
     * adapters stay pure translators of a message they are handed.
     *
     * Signed and short-lived rather than public and permanent; see `signMediaUrl`.
     */
    const outbound = await withMediaLinks(message.content, {
      workspaceId: job.workspaceId,
      secret: env.APP_SECRET_KEY,
      baseUrl: env.WEBHOOK_BASE_URL,
      ttlDays: env.MEDIA_LINK_TTL_DAYS,
    })

    /**
     * The customer's language, for the one control an adapter has to label itself: the
     * button on a file card. Looked up only when a message carries an attachment, because
     * every other outbound word was written by an agent or the AI and is already right.
     */
    const language = hasAttachments(outbound)
      ? await customerLanguage(db, job.workspaceId, conversation.customerId, 'en')
      : undefined

    const parts = toSendableParts(outbound, adapter.capabilities.maxTextLength)
    let lastPlatformId: string | null = message.platformMessageId

    /**
     * Resume where the last attempt stopped.
     *
     * Long text goes out as several sends, and a failure on the third used to start the
     * retry at the first: the customer read the opening of the message twice. Each part is
     * checkpointed as the platform takes it.
     */
    /**
     * Two kinds of checkpoint share `sent_parts`. Text split into several parts counts
     * parts. A single non-text message counts the adapter's own units — Messenger sends a
     * caption and then each file as separate requests — so a failure on the second file
     * does not send the first again.
     */
    const unitsWithinOnePart = parts.length === 1 && outbound.kind !== 'text'
    const recordUnit = async (platformId: string | null, sentParts: number) => {
      lastPlatformId = platformId ?? lastPlatformId
      await db
        .update(schema.messages)
        .set({
          sentParts,
          platformMessageId: lastPlatformId,
          ...(platformId
            ? {
                platformMessageIds: sql`${schema.messages.platformMessageIds} || ${JSON.stringify([platformId])}::jsonb`,
              }
            : {}),
        })
        .where(eq(schema.messages.id, message.id))
    }

    for (const [index, part] of parts.entries()) {
      if (!unitsWithinOnePart && index < message.sentParts) continue

      const result = await adapter.send(identity.externalId, part, config, {
        messagingWindowExpiresAt: conversation.messagingWindowExpiresAt,
        ...(language ? { language } : {}),
        // Only the first part can use the token; the rest are pushes.
        ...(index === 0 && claimedToken ? { replyToken: claimedToken } : {}),
        // The same key on every retry of this part, so LINE delivers it once.
        retryKey: retryKeyFor(message.id, index),
        ...(unitsWithinOnePart
          ? {
              startAt: message.sentParts,
              onUnitSent: (unit, platformId) => recordUnit(platformId, unit + 1),
            }
          : {}),
      })
      if (!unitsWithinOnePart) await recordUnit(result.platformMessageId, index + 1)
      else lastPlatformId = result.platformMessageId ?? lastPlatformId
    }

    await db
      .update(schema.messages)
      .set({
        status: 'sent',
        platformMessageId: lastPlatformId,
        error: null,
        // The first send wins: a retry that finds it sent must not move it later.
        sentAt: sql`coalesce(${schema.messages.sentAt}, now())`,
      })
      .where(eq(schema.messages.id, message.id))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    // Possibly delivered: recorded for a person to judge, and deliberately not retried.
    const uncertain = error instanceof UncertainDeliveryError
    /**
     * `failed` means nothing will try again, which is what lets a person resend it without
     * racing an automatic retry. Until the last attempt it stays `queued`, with the reason
     * recorded so the console can say why it is taking a while.
     */
    const final = meta?.finalAttempt ?? true
    await db
      .update(schema.messages)
      .set({ status: uncertain ? 'uncertain' : final ? 'failed' : 'queued', error: reason })
      .where(eq(schema.messages.id, message.id))

    await announce()
    if (uncertain) return
    throw error
  }

  /**
   * Telling the console is not part of delivering.
   *
   * This used to sit inside the try above, so a Redis hiccup after a successful send marked
   * the message failed and threw — and the retry sent the customer the same words again.
   * Delivery state is decided by the platform's answer and nothing else.
   */
  await announce()
}

/** Split only text; other kinds go out as one message. */
function toSendableParts(message: NormalizedMessage, maxLength: number): NormalizedMessage[] {
  if (message.kind !== 'text') return [message]
  const chunks = splitText(message.text, maxLength)
  if (chunks.length <= 1) return [message]
  return chunks.map((text) => ({ kind: 'text' as const, text }))
}

/** Whether this message carries a file, which is the only reason to look up a language. */
function hasAttachments(message: NormalizedMessage): boolean {
  const media = message as NormalizedMessage & { attachments?: unknown[] }
  return Array.isArray(media.attachments) && media.attachments.length > 0
}

/**
 * A UUID naming one part of one message, the same on every retry.
 *
 * LINE wants a UUID for `X-Line-Retry-Key`. The message id is one already; the part index
 * replaces its last four hex digits, so each part of a split message has its own key.
 */
function retryKeyFor(messageId: string, part: number): string {
  return `${messageId.slice(0, -4)}${part.toString(16).padStart(4, '0')}`
}
