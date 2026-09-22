import { boolean, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { user } from './auth'

/**
 * The platform, as opposed to the tenants on it.
 *
 * Nothing here carries `workspace_id`, and that is the point. A workspace admin's authority
 * is inside one tenant; a platform admin's authority is over tenants, so it cannot be a
 * role on a membership without meaning two different things at once. See decision 22 in
 * docs/REQUIREMENTS.md.
 *
 * These tables also have to outlive a tenant. Every tenant-owned table cascades from the
 * organization row, which means a workspace's own `audit_log` is destroyed by the very
 * deletion it would be the record of.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true })

/**
 * Who may manage tenants.
 *
 * A row, not a flag on the user, so that granting it is an event with a grantor and a time
 * rather than a column somebody once set. The seed grants the first one; after that they
 * grant each other, and the last one cannot be removed.
 */
export const platformAdmins = pgTable('platform_admins', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  /** Null means the seed did it, which is the only grant nobody signed for. */
  grantedByUserId: text('granted_by_user_id').references(() => user.id, { onDelete: 'set null' }),
  createdAt: ts('created_at').defaultNow().notNull(),
})

/**
 * What was done to tenants, kept apart from any tenant.
 *
 * The workspace's own `audit_log` cascades with the workspace, so it cannot record the
 * deletion. This can, and it is deliberately free of anything a tenant's customers ever
 * typed: it holds names, slugs and counts.
 */
export const platformAuditLog = pgTable(
  'platform_audit_log',
  {
    id: text('id').primaryKey(),
    actorUserId: text('actor_user_id').references(() => user.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    meta: jsonb('meta').$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: ts('created_at').defaultNow().notNull(),
  },
  (t) => [index('platform_audit_log_created_idx').on(t.createdAt)],
)

/**
 * An erasure in progress, and the record that it finished.
 *
 * Deliberately no foreign key to the workspace: the row has to survive the deletion it is
 * describing. It is written before anything is destroyed and advanced in stages, so a job
 * that runs again after the rows are already gone knows to retry only the media it could
 * not remove. A job that finds no row here deletes nothing at all, which is what stops a
 * stray enqueue from erasing a live tenant.
 */
export const workspaceErasures = pgTable('workspace_erasures', {
  workspaceId: text('workspace_id').primaryKey(),
  /** Kept because the organization row that held them is about to go. */
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  requestedByUserId: text('requested_by_user_id').references(() => user.id, {
    onDelete: 'set null',
  }),
  /**
   * Storage keys still to remove. Filled before the rows are deleted, because afterwards
   * there is nothing left to read them from, and shrunk to whatever failed on each pass.
   */
  mediaKeys: jsonb('media_keys').$type<string[]>().default([]).notNull(),
  rowsDeleted: boolean('rows_deleted').default(false).notNull(),
  mediaRemoved: integer('media_removed').default(0).notNull(),
  mediaFailed: integer('media_failed').default(0).notNull(),
  requestedAt: ts('requested_at').defaultNow().notNull(),
  completedAt: ts('completed_at'),
})
