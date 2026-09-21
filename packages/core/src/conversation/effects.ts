import type { EffectContext, EffectPorts, Logger } from '../ports'
import { silentLogger } from '../ports'
import type { Effect } from './state-machine'

/**
 * Carry out the effects the state machine returned.
 *
 * Effects run in order, because order is meaningful: an internal note explaining a handoff
 * must exist before agents are notified about it.
 *
 * Failure policy: `notify_agents` is best effort, since a dropped realtime nudge is a
 * cosmetic problem and the agent's inbox still refreshes. Every other effect propagates,
 * so the queue retries the job. Effect implementations must therefore tolerate a replay:
 * the handoff log and the timer and summary jobs are keyed so a repeat is a no-op, while an
 * internal note replayed after a crash is written twice, which is visible and harmless.
 */
export async function applyEffects(
  effects: Effect[],
  ctx: EffectContext,
  ports: EffectPorts,
  logger: Logger = silentLogger,
): Promise<void> {
  for (const effect of effects) {
    switch (effect.type) {
      case 'run_ai_turn':
        await ports.enqueueAiTurn(ctx, effect.deliver)
        break

      case 'run_suggestion':
        await ports.enqueueSuggestion(ctx)
        break

      case 'send_acknowledgement':
        await ports.sendAcknowledgement(ctx, effect.language)
        break

      case 'record_handoff':
        await ports.recordHandoff(ctx, effect.reason, effect.at)
        break

      case 'add_internal_note':
        await ports.addInternalNote(ctx, effect.body)
        break

      case 'notify_agents':
        try {
          await ports.notifyAgents(ctx, effect.reason)
        } catch (error) {
          logger.warn('realtime notify failed', {
            conversationId: ctx.conversationId,
            reason: effect.reason,
            error: error instanceof Error ? error.message : String(error),
          })
        }
        break

      case 'schedule_waiting_human_timeout':
        await ports.scheduleWaitingHumanTimeout(ctx, effect.minutes)
        break

      case 'cancel_waiting_human_timeout':
        await ports.cancelWaitingHumanTimeout(ctx)
        break

      case 'enqueue_summary':
        await ports.enqueueSummary(ctx)
        break
    }
  }
}
