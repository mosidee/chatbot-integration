import { applyEffects, type EffectPorts, type Logger, transition } from '@ci/core'
import { schema } from '@ci/db'
import type { Runtime, WaitingHumanTimeoutJob } from '@ci/infra'
import { and, eq } from 'drizzle-orm'
import { loadWorkspaceSettings } from '../repo'

/**
 * Nobody picked up a handed-off conversation in time.
 *
 * The mode is re-checked because the timer may have fired just after an agent took over;
 * the state machine then returns no effects and the customer is not interrupted.
 */
export async function processWaitingHumanTimeout(
  runtime: Runtime,
  ports: EffectPorts,
  logger: Logger,
  job: WaitingHumanTimeoutJob,
): Promise<void> {
  const { db } = runtime

  const rows = await db
    .select()
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.id, job.conversationId),
        eq(schema.conversations.workspaceId, job.workspaceId),
      ),
    )
    .limit(1)

  const conversation = rows[0]
  if (!conversation) return

  const settings = await loadWorkspaceSettings(db, job.workspaceId)

  const { effects } = transition(
    {
      mode: conversation.mode,
      status: conversation.status,
      assigneeUserId: conversation.assigneeUserId,
      waitingHumanSince: conversation.waitingHumanSince,
      handoffReason: conversation.handoffReason,
    },
    { type: 'waiting_human_timeout', at: new Date() },
    { waitingHumanFallbackMinutes: settings.waitingHumanFallbackMinutes },
  )

  if (effects.length === 0) {
    logger.info('waiting-human timeout ignored; already taken over', {
      conversationId: job.conversationId,
      mode: conversation.mode,
    })
    return
  }

  await applyEffects(
    effects,
    { workspaceId: job.workspaceId, conversationId: job.conversationId },
    ports,
    logger,
  )
}
