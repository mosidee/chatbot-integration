import type { BlobStore, Logger } from '@ci/core'
import { type Database, newId, schema } from '@ci/db'
import { and, eq, inArray, lt } from 'drizzle-orm'

/**
 * Forgetting, on a schedule and on request.
 *
 * Thailand's PDPA gives a person the right to have their data erased and expects a stated
 * retention period to be honoured rather than merely written down. Both are the same
 * operation underneath: delete the rows and delete the media those rows point at.
 *
 * Rows take care of themselves. Every table that hangs off a conversation or a customer
 * cascades, so one delete removes the messages, notes, suggestions, traces, embeddings and
 * summaries with it. Stored media does not cascade, because it is not in the database, so
 * the keys are collected before the rows go and removed afterwards.
 *
 * The order matters. Rows first, then blobs: an orphaned object in storage is a wasted
 * byte, while a row pointing at an object that no longer exists is a broken conversation in
 * front of an agent.
 */

/** Conversations per query, so a large sweep does not build one enormous statement. */
const CHUNK = 200

export type PurgeResult = {
  conversations: number
  media: number
  mediaFailed: number
}

/**
 * Every storage key referenced by the messages of these conversations.
 *
 * Read through the query builder and unpacked here rather than with a jsonb expression in
 * SQL. It loads more than it needs to, and it is the version whose behaviour is obvious to
 * the next person deleting a customer's data, which is not a place for a clever query.
 */
async function mediaKeysOf(db: Database, conversationIds: string[]): Promise<string[]> {
  if (conversationIds.length === 0) return []

  const keys = new Set<string>()
  for (let index = 0; index < conversationIds.length; index += CHUNK) {
    const batch = conversationIds.slice(index, index + CHUNK)
    const rows = await db
      .select({ content: schema.messages.content })
      .from(schema.messages)
      .where(inArray(schema.messages.conversationId, batch))

    for (const row of rows) {
      const content = row.content as { attachments?: { storageKey?: string | null }[] }
      for (const attachment of content.attachments ?? []) {
        if (attachment.storageKey) keys.add(attachment.storageKey)
      }
    }
  }

  return [...keys]
}

async function removeMedia(
  blob: BlobStore,
  keys: string[],
  logger?: Logger,
): Promise<{ removed: number; failed: number }> {
  let removed = 0
  let failed = 0
  for (const key of keys) {
    try {
      await blob.remove(key)
      removed += 1
    } catch (error) {
      // A blob we cannot delete must not abort the erasure. The rows are already gone, and
      // leaving one object behind is better than leaving half the rows.
      failed += 1
      logger?.warn('could not remove stored media', {
        key,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { removed, failed }
}

/** Delete these conversations and everything hanging off them, media included. */
export async function purgeConversations(
  db: Database,
  blob: BlobStore,
  input: { workspaceId: string; conversationIds: string[]; logger?: Logger },
): Promise<PurgeResult> {
  if (input.conversationIds.length === 0) return { conversations: 0, media: 0, mediaFailed: 0 }

  const keys = await mediaKeysOf(db, input.conversationIds)

  const deleted: { id: string }[] = []
  for (let index = 0; index < input.conversationIds.length; index += CHUNK) {
    const batch = input.conversationIds.slice(index, index + CHUNK)
    const removed = await db
      .delete(schema.conversations)
      .where(
        and(
          eq(schema.conversations.workspaceId, input.workspaceId),
          inArray(schema.conversations.id, batch),
        ),
      )
      .returning({ id: schema.conversations.id })
    deleted.push(...removed)
  }

  const media = await removeMedia(blob, keys, input.logger)
  return { conversations: deleted.length, media: media.removed, mediaFailed: media.failed }
}

/**
 * Drop everything in a workspace older than its retention period.
 *
 * Age is measured from the last message rather than the creation date: a conversation that
 * ran for a year is kept until a year after it went quiet, not after it began.
 */
export async function runRetention(
  db: Database,
  blob: BlobStore,
  input: { workspaceId: string; retentionDays: number; now?: Date; logger?: Logger },
): Promise<PurgeResult & { cutoff: Date }> {
  const now = input.now ?? new Date()
  const cutoff = new Date(now.getTime() - input.retentionDays * 24 * 60 * 60 * 1000)

  const stale = await db
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.workspaceId, input.workspaceId),
        lt(schema.conversations.lastMessageAt, cutoff),
      ),
    )

  const result = await purgeConversations(db, blob, {
    workspaceId: input.workspaceId,
    conversationIds: stale.map((row) => row.id),
    ...(input.logger ? { logger: input.logger } : {}),
  })

  return { ...result, cutoff }
}

export type ErasureResult = PurgeResult & { erased: boolean }

/**
 * Erase one customer completely: their conversations, their identities on every channel,
 * their summaries and their media.
 *
 * The audit entry deliberately outlives them. It records that an erasure happened and who
 * asked for it, and carries no personal data, which is what lets you demonstrate the
 * request was honoured without keeping the thing you were asked to delete.
 */
export async function eraseCustomer(
  db: Database,
  blob: BlobStore,
  input: {
    workspaceId: string
    customerId: string
    requestedByUserId?: string | null
    logger?: Logger
  },
): Promise<ErasureResult> {
  const conversations = await db
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.workspaceId, input.workspaceId),
        eq(schema.conversations.customerId, input.customerId),
      ),
    )

  const keys = await mediaKeysOf(
    db,
    conversations.map((row) => row.id),
  )

  const deleted = await db
    .delete(schema.customers)
    .where(
      and(
        eq(schema.customers.workspaceId, input.workspaceId),
        eq(schema.customers.id, input.customerId),
      ),
    )
    .returning({ id: schema.customers.id })

  const media = await removeMedia(blob, keys, input.logger)

  await db.insert(schema.auditLog).values({
    id: newId(),
    workspaceId: input.workspaceId,
    actorUserId: input.requestedByUserId ?? null,
    action: 'customer.erased',
    targetType: 'customer',
    targetId: input.customerId,
    meta: {
      conversations: conversations.length,
      media: media.removed,
      mediaFailed: media.failed,
    },
  })

  return {
    erased: deleted.length > 0,
    conversations: conversations.length,
    media: media.removed,
    mediaFailed: media.failed,
  }
}
