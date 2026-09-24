import { generateText, stepCountIs } from 'ai'
import type { Logger } from '../ports'
import { type RedactionOptions, redactText } from '../redaction/redact'
import { estimateCost } from './cost'
import { attemptSignal, DEFAULT_ATTEMPT_MS } from './deadline'
import { toPlainText } from './plain-text'
import { buildMessages, buildSystemPrompt } from './prompt'
import { stripReasoning } from './reasoning'
import { runWithFallback } from './registry'
import { type BoundIdentity, mergeToolSources, type ToolSource } from './tool-source'
import { createScratchpad, internalToolSource, type ToolContext } from './tools'
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
  /** The values the system binds into a tool call. See `BoundIdentity`. */
  bound: BoundIdentity
  /**
   * Tenant tool sources, merged after the internal ones. Empty for a workspace that has
   * defined none, which is every workspace until an admin adds one.
   */
  toolSources?: ToolSource[]
  /** Stable across a retry of the same job; becomes the idempotency key of any write. */
  turnKey: string
  identityVerificationAvailable?: boolean
  logger?: Logger
  /** The whole turn's deadline. Each model attempt also has its own; see `deadline.ts`. */
  signal?: AbortSignal
  /**
   * The workspace's redaction rules, applied to what the vision model read off an image
   * before it reaches the chat model or the trace. A photographed card is text only once
   * it has been described, and the customer's own messages were masked long before.
   */
  redaction?: RedactionOptions
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

  let visionSummary: string | null = null
  let visionCost = 0
  try {
    if (visionSlot && input.images.length > 0) {
      const vision = await describeImages(visionSlot, input.images, {
        maxRetries: options.maxRetries ?? visionSlot.params.maxRetries ?? 1,
        ...(options.signal ? { signal: options.signal } : {}),
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
  const messages = buildMessages(
    input.recentMessages,
    visionSummary === null ? null : redactText(visionSummary, options.redaction).text,
  )

  try {
    const attempt = await runWithFallback(chatSlot, async (target, model) => {
      /**
       * Each attempt starts from a clean scratchpad.
       *
       * One shared across attempts let a primary that queued a write, set a field or asked
       * for a handoff and then failed pass all of that to a fallback that never asked for
       * it. Only the attempt that produced the answer contributes what the turn does.
       */
      const scratchpad = createScratchpad()
      // Models without function calling take the answer-only path: knowledge is already
      // in the system prompt, so they can still answer, just not act.
      const tools = target.provider.supportsTools
        ? mergeToolSources(
            [internalToolSource, ...(options.toolSources ?? [])],
            {
              customer: input.customer,
              scratchpad,
              bound: options.bound,
              mode,
              turnKey: options.turnKey,
              identityVerificationAvailable: options.identityVerificationAvailable ?? false,
              searchKnowledge: options.searchKnowledge,
              searchPastConversations: options.searchPastConversations,
            },
            options.logger,
          )
        : undefined

      const generated = await generateText({
        model,
        system,
        messages,
        tools,
        abortSignal: attemptSignal(
          (chatSlot.params.timeoutMs as number | undefined) ?? DEFAULT_ATTEMPT_MS.chat,
          options.signal,
        ),
        stopWhen: stepCountIs(options.maxSteps ?? 4),
        temperature: chatSlot.params.temperature ?? 0.3,
        // Reasoning models count their thinking against this budget, so a cap sized for a
        // short answer can be exhausted before a single visible word is produced. Observed
        // on a live conversation: 800 tokens spent, nothing returned.
        maxOutputTokens: chatSlot.params.maxOutputTokens ?? 2048,
        maxRetries: options.maxRetries ?? chatSlot.params.maxRetries ?? 1,
      })
      return { generated, scratchpad }
    })

    const { target, usedFallback } = attempt
    const { generated: result, scratchpad } = attempt.result
    const tokensIn = result.usage?.inputTokens ?? null
    const tokensOut = result.usage?.outputTokens ?? null
    const chatCost = estimateCost(prices, target.provider.name, target.model, tokensIn, tokensOut)

    // A tenant tool that failed ends the turn with a person, even though the model will
    // have written something. Told "the lookup failed", a model reliably answers from its
    // own imagination instead, and an invented subscription date is worse than a wait.
    const handoff =
      scratchpad.handoff ??
      (scratchpad.toolErrors.length > 0
        ? {
            reason: 'tool_error' as const,
            note: `A tool the AI needed did not answer: ${scratchpad.toolErrors
              .map((e) => `${e.tool} ${e.message}`)
              .join('; ')}`,
          }
        : null)
    /**
     * What the customer will actually read.
     *
     * Two things the model's raw output is not. Some gateways leave a reasoning model's
     * thinking inside the message content, which is not an answer at all. And a model
     * writes markdown by habit, which every channel this product speaks renders as
     * literal asterisks and hashes.
     */
    const text = toPlainText(stripReasoning(result.text))

    const trace: TraceRecord = {
      task: chatSlot.task,
      providerId: target.provider.id,
      providerName: target.provider.name,
      model: target.model,
      usedFallback,
      prompt: { system, messages },
      toolCalls: collectToolCalls(result.steps),
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
      pendingWrites: scratchpad.pendingWrites,
      verificationRequested: scratchpad.verificationRequested,
      trace,
    }
  } catch (error) {
    const message = errorMessage(error)
    return {
      text: '',
      handoff: { reason: 'model_error', note: `The AI could not reply: ${message}` },
      customerFieldUpdates: {},
      tagsToAdd: [],
      // A turn that never produced an answer must not fire writes it asked for along the way.
      pendingWrites: [],
      verificationRequested: false,
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

type TraceToolCall = { toolName: string; input: unknown; output: unknown }

/**
 * Pair each call with what it answered, for the trace panel.
 *
 * Handles both shapes: a statically-typed internal tool and a `dynamicTool`, whose parts
 * carry `dynamic: true` with `input` and `output` typed as unknown. Reading only the
 * static shape would leave the console blank for exactly the tenant tools this milestone
 * added.
 */
function collectToolCalls(steps: { toolCalls?: unknown[]; toolResults?: unknown[] }[] | undefined) {
  const calls: TraceToolCall[] = []
  for (const step of steps ?? []) {
    const results = (step.toolResults ?? []) as {
      toolCallId?: string
      output?: unknown
      result?: unknown
    }[]
    for (const raw of (step.toolCalls ?? []) as {
      toolCallId?: string
      toolName?: string
      input?: unknown
      args?: unknown
    }[]) {
      const match = results.find((r) => r.toolCallId === raw.toolCallId)
      calls.push({
        toolName: raw.toolName ?? 'unknown',
        input: raw.input ?? raw.args ?? null,
        output: match ? (match.output ?? match.result ?? null) : null,
      })
    }
  }
  return calls
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
