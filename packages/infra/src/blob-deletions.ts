import type { BlobStore, Logger } from '@ci/core'
import { type Database, type Executor, newId, schema } from '@ci/db'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { isWorkspaceKey } from './media-serving'

/**
 * Deleting stored files so that a failure is remembered.
 *
 * The rows that point at a file and the file itself live in two systems with no transaction
 * between them. So the key is written to `blob_deletions` in the same transaction as the
 * delete that orphans it, the object is removed afterwards, and the row goes only when the
 * object is confirmed gone. A removal that fails stays queued for the next drain.
 */

/** Promise the removal of these objects, inside the caller's transaction. */
export async function queueBlobDeletions(
  executor: Executor,
  workspaceId: string,
  keys: string[],
  reason: string,
): Promise<void> {
  const own = [...new Set(keys)].filter((key) => isWorkspaceKey(workspaceId, key))
  if (own.length === 0) return
  await executor
    .insert(schema.blobDeletions)
    .values(own.map((storageKey) => ({ id: newId(), workspaceId, storageKey, reason })))
    .onConflictDoNothing()
}

export type DrainResult = { removed: number; failed: number; failedKeys: string[] }

/**
 * Remove queued objects, and forget each one only once it is gone.
 *
 * Narrowed to `keys` right after a delete, so the caller can report what it removed; with
 * none, it takes the oldest `limit` for the workspace, which is the nightly retry.
 */
export async function drainBlobDeletions(
  db: Database,
  blob: BlobStore,
  input: { workspaceId: string; keys?: string[]; limit?: number; logger?: Logger },
): Promise<DrainResult> {
  const pending = await db
    .select({ id: schema.blobDeletions.id, storageKey: schema.blobDeletions.storageKey })
    .from(schema.blobDeletions)
    .where(
      and(
        eq(schema.blobDeletions.workspaceId, input.workspaceId),
        ...(input.keys ? [inArray(schema.blobDeletions.storageKey, input.keys)] : []),
      ),
    )
    .orderBy(asc(schema.blobDeletions.createdAt))
    .limit(input.keys ? Math.max(input.keys.length, 1) : (input.limit ?? 500))

  let removed = 0
  const failedKeys: string[] = []
  for (const row of pending) {
    try {
      await blob.remove(row.storageKey)
      await db.delete(schema.blobDeletions).where(eq(schema.blobDeletions.id, row.id))
      removed += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failedKeys.push(row.storageKey)
      await db
        .update(schema.blobDeletions)
        .set({ attempts: sql`${schema.blobDeletions.attempts} + 1`, lastError: message })
        .where(eq(schema.blobDeletions.id, row.id))
      input.logger?.warn('could not remove stored media; it stays queued', {
        key: row.storageKey,
        error: message,
      })
    }
  }
  return { removed, failed: failedKeys.length, failedKeys }
}

/** How long an upload may sit unattached before it counts as abandoned. */
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000

/**
 * Queue the removal of agent uploads that never became part of a message.
 *
 * An agent picks a file and then changes their mind; the upload happened the moment they
 * picked it. Uploads sit at the top of the workspace's prefix (inbound media and knowledge
 * have their own folders), so only those are considered, and only once they are a day old,
 * so one being attached right now is never taken.
 */
export async function queueAbandonedUploads(
  db: Database,
  blob: BlobStore,
  input: { workspaceId: string; now?: Date },
): Promise<number> {
  if (!blob.list) return 0
  const cutoff = (input.now ?? new Date()).getTime() - ABANDONED_AFTER_MS
  const listed = await blob.list(`${input.workspaceId}/`)
  const candidates = listed
    .filter((object) => object.modifiedAt.getTime() < cutoff)
    .map((object) => object.key)
    .filter((key) => key.split('/').length === 2)
  if (candidates.length === 0) return 0

  const referenced = await db.execute<{ key: string }>(sql`
    SELECT DISTINCT attachment->>'storageKey' AS key
    FROM messages, jsonb_array_elements(coalesce(content->'attachments', '[]'::jsonb)) AS attachment
    WHERE messages.workspace_id = ${input.workspaceId}
      AND attachment->>'storageKey' IN (${sql.join(
        candidates.map((key) => sql`${key}`),
        sql`, `,
      )})
  `)
  const used = new Set([...referenced].map((row) => row.key))
  const abandoned = candidates.filter((key) => !used.has(key))
  await queueBlobDeletions(db, input.workspaceId, abandoned, 'abandoned_upload')
  return abandoned.length
}
