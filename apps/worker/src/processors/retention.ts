import type { EffectPorts, Logger } from '@ci/core'
import { schema } from '@ci/db'
import {
  type CustomerErasureJob,
  eraseCustomer,
  eraseWorkspace,
  type RetentionJob,
  type Runtime,
  runRetention,
  type WorkspaceErasureJob,
  workspaceIsWorkable,
} from '@ci/infra'
import { eq } from 'drizzle-orm'

/**
 * Honouring the retention period, and honouring a request to be erased.
 *
 * A job with no workspace is the nightly sweep: it fans out one job per workspace rather
 * than deleting everything in one transaction, so a workspace whose media store is
 * unreachable cannot stop every other workspace from being cleaned.
 */
export async function processRetention(
  runtime: Runtime,
  _ports: EffectPorts,
  logger: Logger,
  job: RetentionJob,
): Promise<void> {
  const { db, blob, queues } = runtime

  if (!job.workspaceId) {
    // Active ones only. A suspended tenant's data is kept exactly as it was until somebody
    // decides otherwise, and one that is being deleted is about to lose all of it anyway.
    const workspaces = await db
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.status, 'active'))
    for (const workspace of workspaces) {
      await queues.retention.add('retention', { workspaceId: workspace.id })
    }
    logger.info('retention sweep planned', { workspaces: workspaces.length })
    return
  }

  const workspace = await workspaceIsWorkable(db, job.workspaceId, logger, 'retention')
  if (!workspace) return
  const settings = workspace.settings
  const result = await runRetention(db, blob, {
    workspaceId: job.workspaceId,
    retentionDays: settings.retentionDays,
    logger,
  })

  // Logged even when nothing matched: "retention ran and found nothing" is the evidence
  // that the schedule is alive, which is the question asked during an audit.
  logger.info('retention applied', {
    workspaceId: job.workspaceId,
    retentionDays: settings.retentionDays,
    cutoff: result.cutoff.toISOString(),
    conversations: result.conversations,
    media: result.media,
    mediaFailed: result.mediaFailed,
  })
}

export async function processCustomerErasure(
  runtime: Runtime,
  _ports: EffectPorts,
  logger: Logger,
  job: CustomerErasureJob,
): Promise<void> {
  const result = await eraseCustomer(runtime.db, runtime.blob, {
    workspaceId: job.workspaceId,
    customerId: job.customerId,
    requestedByUserId: job.requestedByUserId,
    logger,
  })

  logger.info('customer erased', {
    workspaceId: job.workspaceId,
    customerId: job.customerId,
    found: result.erased,
    conversations: result.conversations,
    media: result.media,
    mediaFailed: result.mediaFailed,
  })
}

/**
 * Erase a whole tenant, once a platform admin has asked for it.
 *
 * The safety is in `eraseWorkspace`, not here: it refuses unless a `workspace_erasures` row
 * says the deletion was requested, so a job arriving from anywhere else does nothing. This
 * only reports what happened, and lets a failure surface so the queue retries the media
 * that is left rather than the whole erasure.
 */
export async function processWorkspaceErasure(
  runtime: Runtime,
  _ports: EffectPorts,
  logger: Logger,
  job: WorkspaceErasureJob,
): Promise<void> {
  const result = await eraseWorkspace(runtime.db, runtime.blob, {
    workspaceId: job.workspaceId,
    logger,
  })

  if (result.skipped) {
    logger.warn('workspace erasure skipped', { workspaceId: job.workspaceId })
    return
  }

  logger.info('workspace erased', {
    workspaceId: job.workspaceId,
    rowsDeleted: result.rowsDeleted,
    media: result.media,
    mediaFailed: result.mediaFailed,
  })

  if (result.mediaFailed > 0) {
    // Thrown so BullMQ retries. The rows are already gone and the record now lists only the
    // objects still there, so the retry is cheap and does not repeat itself.
    throw new Error(
      `${result.mediaFailed} stored object(s) could not be removed for workspace ${job.workspaceId}`,
    )
  }
}
