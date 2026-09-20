import { and, eq, type SQL } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'

/**
 * Tenancy guard.
 *
 * Every tenant-owned query must be scoped by workspace. Use this helper instead of
 * hand-writing the `eq(table.workspaceId, id)` term so the intent is explicit and a
 * missing scope is visible in review.
 *
 *   db.select().from(conversations).where(scoped(conversations.workspaceId, wsId, eq(conversations.id, id)))
 */
export function scoped(
  workspaceColumn: PgColumn,
  workspaceId: string,
  ...extra: (SQL | undefined)[]
): SQL {
  const terms = [eq(workspaceColumn, workspaceId), ...extra.filter(Boolean)] as SQL[]
  // `and` returns undefined only for an empty list, which cannot happen here.
  return and(...terms) as SQL
}
