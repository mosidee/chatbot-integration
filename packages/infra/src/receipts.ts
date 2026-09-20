import { type Database, schema } from '@ci/db'
import { and, eq, inArray, lte } from 'drizzle-orm'

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
