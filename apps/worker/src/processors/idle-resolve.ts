import type { EffectPorts, Logger } from '@ci/core'
import { schema } from '@ci/db'
import {
  type IdleResolveJob,
  type Runtime,
  resolveIdleConversations,
  workspaceIsWorkable,
} from '@ci/infra'
import { eq } from 'drizzle-orm'

/** How often the scheduler plans a pass, and so the granularity of every job id below. */
export const IDLE_RESOLVE_EVERY_MINUTES = 15

/**
 * Closing conversations the customer stopped replying to. See `resolveIdleConversations`.
 *
 * A job with no workspace is the scheduled pass: it fans out one job per workspace, the way
 * retention does, so one tenant's failure cannot stop the others.
 */
export async function processIdleResolve(
  runtime: Runtime,
  _ports: EffectPorts,
  logger: Logger,
  job: IdleResolveJob,
): Promise<void> {
  const { db, outbox } = runtime

  if (!job.workspaceId) {
    const workspaces = await db
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.status, 'active'))

    // One pass per workspace per interval, so a worker restarting at the wrong moment does
    // not give a tenant two.
    const slot = Math.floor(Date.now() / (IDLE_RESOLVE_EVERY_MINUTES * 60_000))
    for (const workspace of workspaces) {
      await outbox.enqueue(db, {
        queue: 'idle_resolve',
        name: 'idle_resolve',
        workspaceId: workspace.id,
        payload: { workspaceId: workspace.id },
        jobId: `idle-resolve-${workspace.id}-${slot}`,
      })
    }
    return
  }

  const workspace = await workspaceIsWorkable(db, job.workspaceId, logger, 'idle_resolve')
  if (!workspace) return

  const hours = workspace.settings.autoResolveAfterHours
  if (hours === null) return

  const result = await resolveIdleConversations(runtime, logger, {
    workspaceId: job.workspaceId,
    hours,
  })

  // Only when something happened: this runs every quarter hour per tenant, and a line for
  // every empty pass would bury the ones that closed a conversation.
  if (result.resolved > 0) {
    logger.info('idle conversations resolved', {
      workspaceId: job.workspaceId,
      hours,
      resolved: result.resolved,
      cutoff: result.cutoff.toISOString(),
    })
  }
}
