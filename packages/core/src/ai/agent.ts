import { generateText, stepCountIs } from 'ai'
import { estimateCost } from './cost'
import { buildMessages, buildSystemPrompt } from './prompt'
import { runWithFallback } from './registry'
import { createInternalTools, createScratchpad, type ToolContext } from './tools'
import type { AgentTurnInput, AgentTurnResult, PriceTable, SlotConfig, TraceRecord } from './types'
import { describeImages } from './vision'

export type RunAgentTurnOptions = {
  input: AgentTurnInput
  /** `agent_chat` when answering, `suggestion_for_human` when drafting for an agent. */
  chatSlot: SlotConfig
  visionSlot: SlotConfig | null
  prices: PriceTable
  /** 'answer' sends to the customer; 'suggest' produces a draft for a human. */
  mode: 'answer' | 'suggest'
  /** How many tool-calling rounds the model may take before it must answer. */
  maxSteps?: number
  /** Overrides the slot's retry count. Tests set 0 to fail over immediately. */
  maxRetries?: number
  /**
   * Retrieval capabilities. Each is optional: a tool is only offered to the model when its
   * capability is supplied, so a workspace with no knowledge base does not advertise a
   * search that could only come back empty.
   */
  searchKnowledge?: ToolContext['searchKnowledge']
  searchPastConversations?: ToolContext['searchPastConversations']
}

/**
 * Run one AI turn.
 *
 * Failure is a handoff, never silence: if every provider for the slot fails, the turn
 * returns a `model_error` handoff so a human picks the conversation up.
 */
export async function runAgentTurn(options: RunAgentTurnOptions): Promise<AgentTurnResult> {
  const { input, chatSlot, visionSlot, prices, mode } = options
  const startedAt = Date.now()
  const scratchpad = createScratchpad()

  let visionSummary: string | null = null
  let visionCost = 0
  try {
    if (visionSlot && input.images.length > 0) {
      const vision = await describeImages(visionSlot, input.images, {
        maxRetries: options.maxRetries ?? visionSlot.params.maxRetries ?? 1,
      })
      if (vision) {
        visionSummary = vision.summary
        visionCost =
          estimateCost(
            prices,
            vision.providerName,
            vision.model,
            vision.tokensIn,
            vision.tokensOut,
          ) ?? 0
      }
    }
  } catch (error) {
    // A vision failure must not sink the whole turn; the agent answers without the image.
    visionSummary = `(the customer sent an image, but it could not be read: ${errorMessage(error)})`
  }

  const system = buildSystemPrompt(input, mode)
  const messages = buildMessages(input.recentMessages, visionSummary)

  try {
    const attempt = await runWithFallback(chatSlot, async (target, model) => {
      // Models without function calling take the answer-only path: knowledge is already
      // in the system prompt, so they can still answer, just not act.
      const tools = target.provider.supportsTools
        ? createInternalTools({
            customer: input.customer,
            scratchpad,
            searchKnowledge: options.searchKnowledge,
            searchPastConversations: options.searchPastConversations,
          })
        : undefined

      return generateText({
        model,
        system,
        messages,
        tools,
        stopWhen: stepCountIs(options.maxSteps ?? 4),
        temperature: chatSlot.params.temperature ?? 0.3,
        // Reasoning models count their thinking against this budget, so a cap sized for a
        // short answer can be exhausted before a single visible word is produced. Observed
        // on a live conversation: 800 tokens spent, nothing returned.
        maxOutputTokens: chatSlot.params.maxOutputTokens ?? 2048,
        maxRetries: options.maxRetries ?? chatSlot.params.maxRetries ?? 1,
      })
    })

    const { result, target, usedFallback } = attempt
    const tokensIn = result.usage?.inputTokens ?? null
    const tokensOut = result.usage?.outputTokens ?? null
    const chatCost = estimateCost(prices, target.provider.name, target.model, tokensIn, tokensOut)

    const handoff = scratchpad.handoff
    const text = result.text.trim()

    const trace: TraceRecord = {
      task: chatSlot.task,
      providerId: target.provider.id,
      providerName: target.provider.name,
      model: target.model,
      usedFallback,
      prompt: { system, messages },
      toolCalls: result.steps?.flatMap((s) => s.toolCalls ?? []) ?? [],
      // Pre-fetched chunks plus anything the model looked up itself, so the trace shows
      // every piece of knowledge that could have shaped the answer.
      retrieved: [
        ...input.retrieved,
        ...scratchpad.retrieved.filter((r) => !input.retrieved.some((p) => p.id === r.id)),
      ],
      tokensIn,
      tokensOut,
      latencyMs: Date.now() - startedAt,
      costEstimate: chatCost === null && visionCost === 0 ? null : (chatCost ?? 0) + visionCost,
      // An empty answer is recorded as an error, not as a send. A reasoning model can
      // spend its whole output budget thinking and emit nothing, and a trace claiming
      // "sent" for a turn the customer never saw makes that impossible to find.
      outcome: handoff ? 'handoff' : text === '' ? 'error' : mode === 'suggest' ? 'draft' : 'sent',
      error:
        text === '' && !handoff
          ? `The model returned no text. It used ${tokensOut ?? 0} output tokens and stopped because of "${result.finishReason}".`
          : null,
    }

    return {
      text,
      handoff,
      customerFieldUpdates: scratchpad.customerFieldUpdates,
      tagsToAdd: scratchpad.tagsToAdd,
      trace,
    }
  } catch (error) {
    const message = errorMessage(error)
    return {
      text: '',
      handoff: { reason: 'model_error', note: `The AI could not reply: ${message}` },
      customerFieldUpdates: {},
      tagsToAdd: [],
      trace: {
        task: chatSlot.task,
        providerId: chatSlot.primary?.provider.id ?? null,
        providerName: chatSlot.primary?.provider.name ?? null,
        model: chatSlot.primary?.model ?? null,
        usedFallback: false,
        prompt: { system, messages },
        toolCalls: [],
        retrieved: input.retrieved,
        tokensIn: null,
        tokensOut: null,
        latencyMs: Date.now() - startedAt,
        costEstimate: null,
        outcome: 'error',
        error: message,
      },
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
