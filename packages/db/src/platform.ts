import { eq } from 'drizzle-orm'
import type { Database } from './client'
import * as schema from './schema'

/**
 * Who may manage tenants.
 *
 * Kept in `packages/db` rather than infra because the seed grants the first one and cannot
 * reach infra. The API asks `isPlatformAdmin` on every request to a platform route; it is a
 * primary-key lookup, which is cheaper than any way of caching it would be.
 */

/** Idempotent: re-running the seed must not fail, and a second grant is not an error. */
export async function grantPlatformAdmin(
  db: Database,
  input: { userId: string; grantedByUserId?: string | null },
): Promise<void> {
  await db
    .insert(schema.platformAdmins)
    .values({
      userId: input.userId,
      grantedByUserId: input.grantedByUserId ?? null,
    })
    .onConflictDoNothing()
}

export async function isPlatformAdmin(db: Database, userId: string): Promise<boolean> {
  const rows = await db
    .select({ userId: schema.platformAdmins.userId })
    .from(schema.platformAdmins)
    .where(eq(schema.platformAdmins.userId, userId))
    .limit(1)
  return rows.length > 0
}
