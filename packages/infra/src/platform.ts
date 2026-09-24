import { type Database, type Executor, newId, schema } from '@ci/db'
import type { WorkspaceStatus } from '@ci/shared'
import { count, desc, eq, sql } from 'drizzle-orm'
import type { Outbox } from './outbox'

/**
 * Running the platform: the tenants on it, and what may be done to them.
 *
 * Every function here crosses tenants on purpose, which is why none of them is reachable
 * from a route that resolves a workspace. The guard on the calling routes is membership of
 * `platform_admins`, not a role inside any tenant.
 */

export type TenantSummary = {
  id: string
  name: string
  slug: string
  status: WorkspaceStatus
  memberCount: number
  /** Private or plain-http origins its providers may reach; see `workspaces`. */
  privateEgressOrigins: string[]
  createdAt: Date
}

export async function listTenants(db: Database): Promise<TenantSummary[]> {
  return db
    .select({
      id: schema.organization.id,
      name: schema.organization.name,
      slug: schema.organization.slug,
      status: schema.workspaces.status,
      memberCount: count(schema.member.id),
      privateEgressOrigins: schema.workspaces.privateEgressOrigins,
      createdAt: schema.organization.createdAt,
    })
    .from(schema.organization)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.organization.id))
    .leftJoin(schema.member, eq(schema.member.organizationId, schema.organization.id))
    .groupBy(
      schema.organization.id,
      schema.organization.name,
      schema.organization.slug,
      schema.workspaces.status,
      schema.workspaces.privateEgressOrigins,
      schema.organization.createdAt,
    )
    .orderBy(desc(schema.organization.createdAt))
}

export async function writePlatformAudit(
  executor: Executor,
  input: {
    actorUserId: string | null
    action: string
    targetType?: string
    targetId?: string
    meta?: Record<string, unknown>
  },
): Promise<void> {
  await executor.insert(schema.platformAuditLog).values({
    id: newId(),
    actorUserId: input.actorUserId,
    action: input.action,
    targetType: input.targetType ?? 'tenant',
    targetId: input.targetId ?? null,
    meta: input.meta ?? {},
  })
}

/**
 * Suspend and restore, each refusing unless the workspace is in the state that makes sense.
 *
 * Written as a conditional update rather than a read then a write, so two operators cannot
 * both be told they suspended the same tenant, and so restoring cannot resurrect one that
 * is being deleted.
 */
export async function suspendWorkspace(
  db: Database,
  input: { workspaceId: string; actorUserId: string | null },
): Promise<boolean> {
  const rows = await db
    .update(schema.workspaces)
    .set({ status: 'suspended', updatedAt: new Date() })
    .where(
      sql`${schema.workspaces.id} = ${input.workspaceId} and ${schema.workspaces.status} = 'active'`,
    )
    .returning({ id: schema.workspaces.id })

  if (rows.length === 0) return false
  await writePlatformAudit(db, {
    actorUserId: input.actorUserId,
    action: 'tenant.suspended',
    targetId: input.workspaceId,
  })
  return true
}

export async function unsuspendWorkspace(
  db: Database,
  input: { workspaceId: string; actorUserId: string | null },
): Promise<boolean> {
  const rows = await db
    .update(schema.workspaces)
    .set({ status: 'active', updatedAt: new Date() })
    .where(
      sql`${schema.workspaces.id} = ${input.workspaceId} and ${schema.workspaces.status} = 'suspended'`,
    )
    .returning({ id: schema.workspaces.id })

  if (rows.length === 0) return false
  await writePlatformAudit(db, {
    actorUserId: input.actorUserId,
    action: 'tenant.unsuspended',
    targetId: input.workspaceId,
  })
  return true
}

/**
 * Mark a tenant for erasure and queue the work.
 *
 * The status change and the record of what is about to be destroyed happen together, before
 * anything is destroyed. That ordering is the whole design: the worker refuses to delete a
 * workspace it finds no record for, so a job that arrives from anywhere else does nothing.
 *
 * The status is set first for a second reason. From this moment the tenant is closed — no
 * session, no webhook, no queued job — so nothing new is written while the erasure runs and
 * the list of media keys it collects cannot go stale underneath it.
 */
export async function requestWorkspaceErasure(
  db: Database,
  outbox: Outbox,
  input: { workspaceId: string; actorUserId: string | null },
): Promise<boolean> {
  const queued = await db.transaction(async (tx) => {
    const rows = await tx
      .update(schema.workspaces)
      .set({ status: 'deleting', updatedAt: new Date() })
      .where(
        sql`${schema.workspaces.id} = ${input.workspaceId} and ${schema.workspaces.status} <> 'deleting'`,
      )
      .returning({ id: schema.workspaces.id })
    if (rows.length === 0) return false

    const organization = await tx
      .select({ name: schema.organization.name, slug: schema.organization.slug })
      .from(schema.organization)
      .where(eq(schema.organization.id, input.workspaceId))
      .limit(1)
    const details = organization[0]
    if (!details) return false

    await tx
      .insert(schema.workspaceErasures)
      .values({
        workspaceId: input.workspaceId,
        name: details.name,
        slug: details.slug,
        requestedByUserId: input.actorUserId,
      })
      .onConflictDoNothing()

    await writePlatformAudit(tx, {
      actorUserId: input.actorUserId,
      action: 'tenant.delete_requested',
      targetId: input.workspaceId,
      meta: { slug: details.slug, name: details.name },
    })

    /**
     * Inside the transaction that set the status, which is what makes the request
     * answerable a second time. Enqueued afterwards, a Redis failure left the workspace
     * marked `deleting` with no job coming and no way to ask again: the status said
     * somebody already had.
     */
    await outbox.enqueue(tx, {
      queue: 'workspace_erasure',
      name: 'erase',
      workspaceId: input.workspaceId,
      payload: { workspaceId: input.workspaceId, requestedByUserId: input.actorUserId },
      jobId: `workspace-erasure-${input.workspaceId}`,
    })

    return true
  })

  return queued
}

/** Whether an erasure is on record, which is what the worker asks before it deletes. */
export async function erasureRecord(db: Database, workspaceId: string) {
  const rows = await db
    .select()
    .from(schema.workspaceErasures)
    .where(eq(schema.workspaceErasures.workspaceId, workspaceId))
    .limit(1)
  return rows[0] ?? null
}

export type PlatformAdminRow = {
  userId: string
  email: string
  name: string
  grantedByUserId: string | null
  createdAt: Date
}

export async function listPlatformAdmins(db: Database): Promise<PlatformAdminRow[]> {
  return db
    .select({
      userId: schema.platformAdmins.userId,
      email: schema.user.email,
      name: schema.user.name,
      grantedByUserId: schema.platformAdmins.grantedByUserId,
      createdAt: schema.platformAdmins.createdAt,
    })
    .from(schema.platformAdmins)
    .innerJoin(schema.user, eq(schema.user.id, schema.platformAdmins.userId))
    .orderBy(schema.platformAdmins.createdAt)
}
