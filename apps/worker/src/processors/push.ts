import type { EffectPorts, Logger } from '@ci/core'
import {
  type PushJob,
  type Runtime,
  sendPush,
  vapidKeys,
  vapidSubject,
  workspaceIsWorkable,
} from '@ci/infra'

/**
 * A notification to agents' devices (ADR 0010). What to say and to whom is decided in
 * `sendPush`, when it runs, against the conversation as it is now.
 */
export async function processPush(
  runtime: Runtime,
  _ports: EffectPorts,
  logger: Logger,
  job: PushJob,
): Promise<void> {
  const vapid = vapidKeys(runtime.env)
  // Queued while the keys were set and run after they were removed: nothing to sign with.
  if (!vapid) return

  // Nobody in a suspended workspace can act on it; they are locked out too.
  if (!(await workspaceIsWorkable(runtime.db, job.workspaceId, logger, 'push'))) return

  const outcome = await sendPush(
    { db: runtime.db, vapid, subject: vapidSubject(runtime.env), logger },
    job,
  )
  logger.info('push', { conversationId: job.conversationId, reason: job.reason, ...outcome })
}
