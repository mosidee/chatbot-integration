import { type Database, newId, schema } from '@ci/db'
import type { FeedbackRating, FeedbackReason, FeedbackTargetType } from '@ci/shared'
import { and, asc, eq, sql } from 'drizzle-orm'

/**
 * Feedback on AI output, and the check that the output is really this customer's.
 *
 * The ownership check lives here rather than in the route on purpose. `targetId` carries
 * no foreign key, so nothing in the database stops a request from rating a message in
 * another workspace's conversation and reading its existence back through the response.
 * Keeping the check beside the write means the test suite covers it; a check in the HTTP
 * layer would be covered by nothing.
 */

export type FeedbackRow = typeof schema.feedback.$inferSelect

type TargetRef = {
  workspaceId: string
  conversationId: string
  targetType: FeedbackTargetType
  targetId: string
}

/**
 * Does this target exist, in this workspace, on this conversation?
 *
 * A message must additionally have been written by the AI. Rating a customer's own words,
 * or a colleague's, is not a thing the product does, and allowing it would quietly poison
 * the dashboard's counts.
 */
async function targetExists(db: Database, ref: TargetRef): Promise<boolean> {
  if (ref.targetType === 'message') {
    const rows = await db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.id, ref.targetId),
          eq(schema.messages.workspaceId, ref.workspaceId),
          eq(schema.messages.conversationId, ref.conversationId),
          eq(schema.messages.senderType, 'ai'),
        ),
      )
    return rows.length > 0
  }

  const rows = await db
    .select({ id: schema.suggestions.id })
    .from(schema.suggestions)
    .where(
      and(
        eq(schema.suggestions.id, ref.targetId),
        eq(schema.suggestions.workspaceId, ref.workspaceId),
        eq(schema.suggestions.conversationId, ref.conversationId),
      ),
    )
  return rows.length > 0
}

/**
 * Record what this person thought, replacing whatever they thought before.
 *
 * Returns null when the target is not theirs to rate, which the caller turns into a 404.
 * Re-rating is an update rather than a second row: the unique index is the rule that one
 * person holds one opinion per thing, and the upsert is how that rule is enforced under a
 * double click or a retried request.
 */
export async function upsertFeedback(
  db: Database,
  input: TargetRef & {
    userId: string
    rating: FeedbackRating
    reason?: FeedbackReason | null
    note?: string | null
  },
): Promise<FeedbackRow | null> {
  if (!(await targetExists(db, input))) return null

  // A thumbs-up has nothing to explain, so it never carries a reason, whatever was sent.
  const reason = input.rating === 'down' ? (input.reason ?? null) : null
  const note = input.note?.trim() ? input.note.trim() : null

  const rows = await db
    .insert(schema.feedback)
    .values({
      id: newId(),
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      targetType: input.targetType,
      targetId: input.targetId,
      userId: input.userId,
      rating: input.rating,
      reason,
      note,
    })
    .onConflictDoUpdate({
      target: [schema.feedback.targetType, schema.feedback.targetId, schema.feedback.userId],
      set: { rating: input.rating, reason, note, updatedAt: sql`now()` },
    })
    .returning()

  return rows[0] ?? null
}

/**
 * Withdraw one's own feedback. Scoped by author as well as workspace: an agent may change
 * their mind, not somebody else's.
 */
export async function deleteFeedback(
  db: Database,
  input: { workspaceId: string; conversationId: string; feedbackId: string; userId: string },
): Promise<boolean> {
  const rows = await db
    .delete(schema.feedback)
    .where(
      and(
        eq(schema.feedback.id, input.feedbackId),
        eq(schema.feedback.workspaceId, input.workspaceId),
        eq(schema.feedback.conversationId, input.conversationId),
        eq(schema.feedback.userId, input.userId),
      ),
    )
    .returning({ id: schema.feedback.id })
  return rows.length > 0
}

/** Every opinion on this conversation, whoever left it. Viewers read what agents wrote. */
export async function listFeedback(
  db: Database,
  workspaceId: string,
  conversationId: string,
): Promise<FeedbackRow[]> {
  return db
    .select()
    .from(schema.feedback)
    .where(
      and(
        eq(schema.feedback.workspaceId, workspaceId),
        eq(schema.feedback.conversationId, conversationId),
      ),
    )
    .orderBy(asc(schema.feedback.createdAt))
}
