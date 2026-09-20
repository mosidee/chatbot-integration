import { generateText, stepCountIs } from 'ai'
import { estimateCost } from './cost'
import { buildMessages, buildSystemPrompt } from './prompt'
import { runWithFallback } from './registry'
import { createInternalTools, createScratchpad } from './tools'
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
        ? createInternalTools({ customer: input.customer, scratchpad })
        : undefined

      return generateText({
        model,
        system,
        messages,
        tools,
        stopWhen: stepCountIs(options.maxSteps ?? 4),
        temperature: chatSlot.params.temperature ?? 0.3,
        maxOutputTokens: chatSlot.params.maxOutputTokens ?? 800,
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
      retrieved: input.retrieved,
      tokensIn,
      tokensOut,
      latencyMs: Date.now() - startedAt,
      costEstimate: chatCost === null && visionCost === 0 ? null : (chatCost ?? 0) + visionCost,
      outcome: handoff ? 'handoff' : mode === 'suggest' ? 'draft' : 'sent',
      error: null,
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
