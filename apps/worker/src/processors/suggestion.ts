import { type AgentTurnInput, type EffectPorts, type Logger, runAgentTurn } from '@ci/core'
import { newId, schema } from '@ci/db'
import type { Runtime, SuggestionJob } from '@ci/infra'
import {
  loadAiConfig,
  loadTurnContext,
  loadWorkspaceSettings,
  recordTrace,
  usableSlot,
} from '@ci/infra'

/**
 * Draft a reply for the human sidebar.
 *
 * Nothing this produces can reach the customer: the result is stored as a suggestion an
 * agent may insert, edit or discard. This is what the AI does while a human owns the
 * conversation.
 */
export async function processSuggestion(
  runtime: Runtime,
  _ports: EffectPorts,
  logger: Logger,
  job: SuggestionJob,
): Promise<void> {
  const { db, env, publisher } = runtime

  const context = await loadTurnContext(db, job.workspaceId, job.conversationId)
  if (!context) return

  const settings = await loadWorkspaceSettings(db, job.workspaceId)
  const aiConfig = await loadAiConfig(db, job.workspaceId, env.APP_SECRET_KEY, settings.modelPrices)

  // Falls back to the chat slot so suggestions work before anyone configures a cheaper one.
  const slot = usableSlot(aiConfig, 'suggestion_for_human') ?? usableSlot(aiConfig, 'agent_chat')
  if (!slot) {
    logger.info('no provider configured for suggestions', { workspaceId: job.workspaceId })
    return
  }

  const { customer, notes, recentMessages } = context

  const input: AgentTurnInput = {
    workspace: { persona: settings.persona, defaultLanguage: settings.defaultLanguage },
    customer: {
      displayName: customer.displayName,
      primaryLanguage: customer.primaryLanguage,
      summary: customer.summary,
      fields: customer.fields,
    },
    recentMessages: recentMessages.map((m) => ({
      role:
        m.senderType === 'customer'
          ? ('customer' as const)
          : m.senderType === 'human'
            ? ('human' as const)
            : m.senderType === 'system'
              ? ('system' as const)
              : ('ai' as const),
      text: m.text,
      at: m.createdAt,
    })),
    internalNotes: notes.map((n) => ({ body: n.body, at: n.createdAt })),
    retrieved: [],
    images: [],
  }

  const result = await runAgentTurn({
    input,
    chatSlot: { ...slot, task: 'suggestion_for_human' },
    visionSlot: null,
    prices: aiConfig.prices,
    mode: 'suggest',
  })

  const traceId = await recordTrace(db, job.workspaceId, job.conversationId, result.trace)
  if (!result.text) return

  const suggestionId = newId()
  await db.insert(schema.suggestions).values({
    id: suggestionId,
    workspaceId: job.workspaceId,
    conversationId: job.conversationId,
    messageText: result.text,
    chunks: result.trace.retrieved,
    aiTraceId: traceId,
    status: 'pending',
  })

  await publisher.publish(job.workspaceId, {
    type: 'suggestion.created',
    conversationId: job.conversationId,
    suggestionId,
  })
}
