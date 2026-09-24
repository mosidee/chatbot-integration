import type { BlobStore, Logger } from '@ci/core'
import { type Database, newId, schema } from '@ci/db'
import { and, eq, inArray, lt } from 'drizzle-orm'
import { isWorkspaceKey } from './media-serving'

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
async function mediaKeysOf(
  db: Database,
  workspaceId: string,
  conversationIds: string[],
): Promise<string[]> {
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
        /**
         * Only this workspace's own objects are ever deleted.
         *
         * The conversations are scoped, but a key inside one of their messages is only as
         * trustworthy as whatever wrote it. `storeMessage` now refuses a foreign key, so
         * this is the second lock on the same door: deletion is irreversible, and a row
         * written before that rule existed must not take another tenant's file with it.
         */
        const key = attachment.storageKey
        if (key && isWorkspaceKey(workspaceId, key)) keys.add(key)
      }
    }
  }

  return [...keys]
}

async function removeMedia(
  blob: BlobStore,
  keys: string[],
  logger?: Logger,
): Promise<{ removed: number; failed: number; failedKeys: string[] }> {
  let removed = 0
  const failedKeys: string[] = []
  for (const key of keys) {
    try {
      await blob.remove(key)
      removed += 1
    } catch (error) {
      // A blob we cannot delete must not abort the erasure. The rows are already gone, and
      // leaving one object behind is better than leaving half the rows.
      //
      // Which ones failed is reported as well as how many, so a caller that intends to try
      // again knows what is left rather than starting from the whole list.
      failedKeys.push(key)
      logger?.warn('could not remove stored media', {
        key,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { removed, failed: failedKeys.length, failedKeys }
}

/** Delete these conversations and everything hanging off them, media included. */
export async function purgeConversations(
  db: Database,
  blob: BlobStore,
  input: { workspaceId: string; conversationIds: string[]; logger?: Logger },
): Promise<PurgeResult> {
  if (input.conversationIds.length === 0) return { conversations: 0, media: 0, mediaFailed: 0 }

  const keys = await mediaKeysOf(db, input.workspaceId, input.conversationIds)

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
    input.workspaceId,
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

export type WorkspaceErasureResult = {
  /** True when there was no record of a request, so nothing was touched. */
  skipped: boolean
  rowsDeleted: boolean
  media: number
  mediaFailed: number
}

/**
 * Erase a whole tenant.
 *
 * Deliberately not one statement, because it cannot be. The rows cascade from the
 * organization row and the stored media does not, so the keys are collected while the rows
 * that name them still exist, and the objects are removed afterwards.
 *
 * Three things make it safe to run twice, which matters because the queue retries:
 *
 *  - It refuses unless a `workspace_erasures` row says the deletion was asked for. A job
 *    that arrives from anywhere else — a stray enqueue, a replayed message — deletes nothing.
 *  - The collected keys are written to that row before the rows go. After the tenant is
 *    gone there is nothing left to read them from, so a retry that finds the rows already
 *    deleted still knows exactly which objects it has yet to remove.
 *  - Keys that were removed are dropped from the list, so a retry works on the remainder
 *    rather than on the whole set.
 *
 * The record outlives the tenant: it has no foreign key, and the audit entry it produces
 * goes to `platform_audit_log`, because the workspace's own audit log cascades away with
 * the very deletion it would be the record of.
 */
export async function eraseWorkspace(
  db: Database,
  blob: BlobStore,
  input: { workspaceId: string; logger?: Logger },
): Promise<WorkspaceErasureResult> {
  const records = await db
    .select()
    .from(schema.workspaceErasures)
    .where(eq(schema.workspaceErasures.workspaceId, input.workspaceId))
    .limit(1)
  const record = records[0]

  if (!record) {
    input.logger?.warn('refusing to erase a workspace that was never marked for erasure', {
      workspaceId: input.workspaceId,
    })
    return { skipped: true, rowsDeleted: false, media: 0, mediaFailed: 0 }
  }

  let mediaKeys = record.mediaKeys
  let rowsDeleted = record.rowsDeleted

  if (!rowsDeleted) {
    const workspace = await db
      .select({ status: schema.workspaces.status })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, input.workspaceId))
      .limit(1)

    // Gone already: a previous attempt deleted the rows and failed before saying so.
    if (workspace.length === 0) {
      rowsDeleted = true
    } else {
      if (workspace[0]?.status !== 'deleting') {
        input.logger?.warn('refusing to erase a workspace that is not marked deleting', {
          workspaceId: input.workspaceId,
          status: workspace[0]?.status,
        })
        return { skipped: true, rowsDeleted: false, media: 0, mediaFailed: 0 }
      }

      const conversations = await db
        .select({ id: schema.conversations.id })
        .from(schema.conversations)
        .where(eq(schema.conversations.workspaceId, input.workspaceId))

      const fromMessages = await mediaKeysOf(
        db,
        input.workspaceId,
        conversations.map((row) => row.id),
      )

      // Knowledge files are the other half, and `mediaKeysOf` does not know about them: it
      // reads message attachments. A tenant's uploaded documents would otherwise be left
      // in storage for ever, with nothing left in the database pointing at them.
      const sources = await db
        .select({ storageKey: schema.knowledgeSources.storageKey })
        .from(schema.knowledgeSources)
        .where(eq(schema.knowledgeSources.workspaceId, input.workspaceId))

      mediaKeys = [
        ...new Set([
          ...fromMessages,
          // Keyed `<workspaceId>/knowledge/<id>-<name>` by the upload route, so the same
          // prefix rule applies to them as to message attachments.
          ...sources.flatMap((row) =>
            row.storageKey && isWorkspaceKey(input.workspaceId, row.storageKey)
              ? [row.storageKey]
              : [],
          ),
        ]),
      ]

      await db
        .update(schema.workspaceErasures)
        .set({ mediaKeys })
        .where(eq(schema.workspaceErasures.workspaceId, input.workspaceId))

      // One delete. The organization cascades to the workspace, and the workspace cascades
      // to every tenant-owned table.
      await db.delete(schema.organization).where(eq(schema.organization.id, input.workspaceId))

      rowsDeleted = true
      await db
        .update(schema.workspaceErasures)
        .set({ rowsDeleted: true })
        .where(eq(schema.workspaceErasures.workspaceId, input.workspaceId))

      input.logger?.info('workspace rows deleted', {
        workspaceId: input.workspaceId,
        conversations: conversations.length,
        media: mediaKeys.length,
      })
    }
  }

  const outcome = await removeMedia(blob, mediaKeys, input.logger)
  const failedKeys = outcome.failedKeys
  const done = failedKeys.length === 0
  await db
    .update(schema.workspaceErasures)
    .set({
      mediaKeys: failedKeys,
      mediaRemoved: record.mediaRemoved + outcome.removed,
      mediaFailed: failedKeys.length,
      ...(done ? { completedAt: new Date() } : {}),
    })
    .where(eq(schema.workspaceErasures.workspaceId, input.workspaceId))

  if (done) {
    await db.insert(schema.platformAuditLog).values({
      id: newId(),
      actorUserId: record.requestedByUserId,
      action: 'tenant.erased',
      targetType: 'tenant',
      targetId: input.workspaceId,
      meta: {
        slug: record.slug,
        name: record.name,
        media: record.mediaRemoved + outcome.removed,
      },
    })
  }

  return {
    skipped: false,
    rowsDeleted,
    media: outcome.removed,
    mediaFailed: failedKeys.length,
  }
}
