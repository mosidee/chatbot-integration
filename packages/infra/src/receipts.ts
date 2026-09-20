import { type Database, schema } from '@ci/db'
import { and, desc, eq, inArray, lte } from 'drizzle-orm'

/**
 * Delivery and read receipts.
 *
 * Messenger reports these as a watermark rather than per message: "everything sent to this
 * conversation up to this instant has been delivered", or read. So a receipt is applied to
 * every outbound message at or before that time rather than to one id.
 *
 * Receipts only ever move forward. They arrive out of order often enough that applying one
 * blindly would flip a message that was read back to merely delivered, and the tick in the
 * console would go backwards while an agent watched it.
 */

/** Weakest to strongest. A receipt may only raise a message's status. */
const RANK = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 0 } as const

export type Receipt = 'delivered' | 'read'

export async function applyReceipt(
  db: Database,
  input: {
    workspaceId: string
    conversationId: string
    receipt: Receipt
    /** Milliseconds since the epoch. Everything sent at or before this is covered. */
    watermark: number
  },
): Promise<number> {
  if (!Number.isFinite(input.watermark) || input.watermark <= 0) return 0

  const weaker = (Object.keys(RANK) as (keyof typeof RANK)[]).filter(
    (status) => status !== 'failed' && RANK[status] < RANK[input.receipt],
  )

  const updated = await db
    .update(schema.messages)
    .set({ status: input.receipt })
    .where(
      and(
        eq(schema.messages.workspaceId, input.workspaceId),
        eq(schema.messages.conversationId, input.conversationId),
        eq(schema.messages.direction, 'outbound'),
        lte(schema.messages.createdAt, new Date(input.watermark)),
        // Never downgrade, and never overwrite a failure with a receipt that cannot apply
        // to a message that was never sent.
        inArray(schema.messages.status, weaker),
      ),
    )
    .returning({ id: schema.messages.id })

  return updated.length
}

/**
 * The conversation a receipt refers to, or null.
 *
 * Deliberately a lookup and never a create. A receipt says something about messages already
 * sent, so if there is no identity or no conversation there is nothing it can describe.
 * Resolving one the usual way opened an empty conversation every time a receipt arrived
 * after its conversation had been resolved, which is exactly when they do arrive.
 */
export async function conversationForReceipt(
  db: Database,
  input: { channelId: string; externalId: string },
): Promise<string | null> {
  const [identity] = await db
    .select({ id: schema.channelIdentities.id })
    .from(schema.channelIdentities)
    .where(
      and(
        eq(schema.channelIdentities.channelId, input.channelId),
        eq(schema.channelIdentities.externalId, input.externalId),
      ),
    )
    .limit(1)
  if (!identity) return null

  // The most recent one, open or resolved: a receipt can land after a conversation closes
  // and the messages it covers are still in there.
  const [conversation] = await db
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(eq(schema.conversations.channelIdentityId, identity.id))
    .orderBy(desc(schema.conversations.createdAt))
    .limit(1)

  return conversation?.id ?? null
}
