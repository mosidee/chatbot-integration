import { type Database, schema } from '@ci/db'
import { and, eq, type SQL, sql } from 'drizzle-orm'

/**
 * The review queue: conversations the AI handled with nobody watching.
 *
 * An unsupervised AI is the part of this product that most needs checking, and the only
 * conversations worth a person's time are the ones no person has already seen. So the
 * queue is what is left after three subtractions: a human ever spoke here, the AI handed
 * off (someone was fetched, whether or not they answered), or the conversation has already
 * been reviewed since the AI last said anything.
 *
 * Two consequences worth stating rather than rediscovering:
 *
 * A conversation a human ever touched never comes back, even if the AI then runs it alone
 * for a month. That is deliberate — a human who replied here has seen how the AI behaves —
 * and it is what "answered end to end" means.
 *
 * `ai_supervised` conversations never enter at all. A draft is sent by a person, under
 * their own `sender_type`, so the conversation carries a human message from the first
 * reply. Nothing was unsupervised about it.
 *
 * Status is deliberately not consulted: a resolved conversation the AI handled alone is
 * exactly the kind that closes without anyone noticing it went wrong.
 */

/**
 * A boolean SQL fragment correlated on the `conversations` row of the enclosing query.
 *
 * "The newest AI message is newer than `reviewed_at`" needs no aggregate: it is the same
 * question as "some AI message is newer than `reviewed_at`", which an index can answer by
 * stopping at the first hit.
 */
export function inReviewQueue(): SQL {
  const c = schema.conversations
  return sql`(
    ${c.handoffReason} IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM ${schema.messages} m
      WHERE m.conversation_id = ${c.id} AND m.sender_type = 'human'
    )
    AND EXISTS (
      SELECT 1 FROM ${schema.messages} m
      WHERE m.conversation_id = ${c.id}
        AND m.sender_type = 'ai'
        AND (${c.reviewedAt} IS NULL OR m.created_at > ${c.reviewedAt})
    )
  )`
}

/** How many conversations are waiting to be reviewed, over all time. */
export async function countReviewQueue(db: Database, workspaceId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.conversations)
    .where(and(eq(schema.conversations.workspaceId, workspaceId), inReviewQueue()))
  return rows[0]?.count ?? 0
}

/** Whether this one conversation is in the queue, for the sidebar's "mark reviewed" button. */
export async function isInReviewQueue(
  db: Database,
  workspaceId: string,
  conversationId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.workspaceId, workspaceId),
        eq(schema.conversations.id, conversationId),
        inReviewQueue(),
      ),
    )
  return rows.length > 0
}

/**
 * Record that someone has looked at this conversation. Returns null if there was no such
 * conversation in this workspace.
 *
 * The timestamp comes from the database, not from the caller: it is compared against
 * `messages.created_at`, which `defaultNow()` writes on the database clock. An application
 * clock a second fast would mark AI replies reviewed before they were written.
 */
export async function markReviewed(
  db: Database,
  workspaceId: string,
  conversationId: string,
  userId: string,
): Promise<Date | null> {
  const rows = await db
    .update(schema.conversations)
    .set({ reviewedAt: sql`now()`, reviewedByUserId: userId, updatedAt: sql`now()` })
    .where(
      and(
        eq(schema.conversations.workspaceId, workspaceId),
        eq(schema.conversations.id, conversationId),
      ),
    )
    .returning({ reviewedAt: schema.conversations.reviewedAt })
  return rows[0]?.reviewedAt ?? null
}
