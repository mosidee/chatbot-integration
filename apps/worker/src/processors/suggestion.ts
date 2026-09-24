import { type AgentTurnInput, type EffectPorts, type Logger, runAgentTurn } from '@ci/core'
import { newId, schema } from '@ci/db'
import type { JobMeta, Runtime, SuggestionJob } from '@ci/infra'
import {
  boundIdentityFor,
  createTurnRetrieval,
  createWorkspaceToolSources,
  loadAiConfig,
  loadToolDefinitions,
  loadTurnContext,
  recordTrace,
  resolveExternalRetrieval,
  usableSlot,
  workspaceHasKnowledge,
  workspaceIsWorkable,
  workspaceProviderFetch,
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
  meta?: JobMeta,
): Promise<void> {
  const { db, env, publisher } = runtime

  const context = await loadTurnContext(db, job.workspaceId, job.conversationId)
  if (!context) return

  const workspace = await workspaceIsWorkable(db, job.workspaceId, logger, 'suggestion')
  if (!workspace) return
  const settings = workspace.settings
  const providerFetch = await workspaceProviderFetch(runtime, job.workspaceId)
  const aiConfig = await loadAiConfig(
    db,
    job.workspaceId,
    env.APP_SECRET_KEY,
    settings.modelPrices,
    providerFetch,
  )

  // Falls back to the chat slot so suggestions work before anyone configures a cheaper one.
  const slot = usableSlot(aiConfig, 'suggestion_for_human') ?? usableSlot(aiConfig, 'agent_chat')
  if (!slot) {
    logger.info('no provider configured for suggestions', { workspaceId: job.workspaceId })
    return
  }

  const { conversation, customer, notes, recentMessages } = context

  // The agent's draft is grounded in the same knowledge the AI would have used, so what a
  // human sends and what the AI would have sent cannot quietly diverge.
  const embedSlot = usableSlot(aiConfig, 'embed')
  const retrieval = createTurnRetrieval(db, {
    workspaceId: job.workspaceId,
    customerId: conversation.customerId,
    conversationId: job.conversationId,
    // Recall may reach this conversation's own earlier episodes, just not what is on screen.
    activeWindowStart: recentMessages[0]?.createdAt ?? null,
    language: customer.primaryLanguage ?? settings.defaultLanguage,
    channelType: context.channel.type,
    embedSlot,
    rerankSlot: usableSlot(aiConfig, 'rerank'),
    externalRetrieval: await resolveExternalRetrieval(
      settings.externalRetrieval,
      env.APP_SECRET_KEY,
      providerFetch,
    ),
    hasKnowledge: await workspaceHasKnowledge(db, job.workspaceId),
  })

  const newestCustomerText = [...recentMessages]
    .reverse()
    .find((m) => m.senderType === 'customer')?.text
  const prefetched =
    retrieval.enabled.knowledge && newestCustomerText
      ? await retrieval.prefetch(newestCustomerText).catch(() => [])
      : []

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
    retrieved: prefetched,
    images: [],
  }

  // A draft may look things up, but `mode: 'suggest'` withholds every writing tool: a
  // draft nobody has read yet must not change anything in the tenant's system.
  const toolDefinitions = await loadToolDefinitions(db, job.workspaceId, env.APP_SECRET_KEY)

  const result = await runAgentTurn({
    input,
    chatSlot: { ...slot, task: 'suggestion_for_human' },
    visionSlot: null,
    prices: aiConfig.prices,
    mode: 'suggest',
    bound: boundIdentityFor(context, settings),
    turnKey: meta?.jobId ?? `suggestion-${job.conversationId}`,
    logger,
    toolSources: createWorkspaceToolSources(toolDefinitions, runtime),
    ...(retrieval.enabled.knowledge ? { searchKnowledge: retrieval.searchKnowledge } : {}),
    ...(retrieval.enabled.pastConversations
      ? { searchPastConversations: retrieval.searchPastConversations }
      : {}),
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
