import type { EffectPorts, Logger } from '@ci/core'
import { schema } from '@ci/db'
import {
  type CustomerErasureJob,
  eraseCustomer,
  loadWorkspaceSettings,
  type RetentionJob,
  type Runtime,
  runRetention,
} from '@ci/infra'

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
    const workspaces = await db.select({ id: schema.workspaces.id }).from(schema.workspaces)
    for (const workspace of workspaces) {
      await queues.retention.add('retention', { workspaceId: workspace.id })
    }
    logger.info('retention sweep planned', { workspaces: workspaces.length })
    return
  }

  const settings = await loadWorkspaceSettings(db, job.workspaceId)
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
