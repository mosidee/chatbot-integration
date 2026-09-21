import type { AiTask, HandoffReason, Language } from '@ci/shared'

/** A provider profile with its secrets already decrypted by the caller. */
export type ProviderProfile = {
  id: string
  name: string
  baseUrl: string
  apiKey: string | null
  headers: Record<string, string>
  /** Models without function calling take the answer-only path. */
  supportsTools: boolean
  supportsVision: boolean
}

export type SlotTarget = {
  provider: ProviderProfile
  model: string
}

/** One configured task slot: a primary target and an optional fallback. */
export type SlotConfig = {
  task: AiTask
  primary: SlotTarget | null
  fallback: SlotTarget | null
  params: {
    temperature?: number
    maxOutputTokens?: number
    topP?: number
    /**
     * Retries per provider before moving to the fallback. Kept low on purpose: a customer
     * is waiting on a webhook, so failing over quickly beats retrying a dead provider.
     */
    maxRetries?: number
    /**
     * Whether to ask an embedding model for a specific vector size. Defaults to true.
     *
     * Turn it off for a gateway or model that rejects the `dimensions` field outright, or
     * that is already native to the size the store expects and treats the parameter as an
     * error. The returned size is still checked, so a model that then answers with the
     * wrong size fails loudly rather than filling the index with vectors it cannot compare.
     */
    sendDimensions?: boolean
    [key: string]: unknown
  }
}

export type PriceTable = Record<string, { inputPerMillion: number; outputPerMillion: number }>

export type RetrievedChunk = {
  id: string
  sourceId: string
  sourceTitle: string
  text: string
  score: number
  language: Language | null
}

export type ConversationTurn = {
  role: 'customer' | 'ai' | 'human' | 'system'
  text: string
  at: Date
}

/**
 * An image passed to the vision model as bytes.
 *
 * Deliberately not a URL: the provider would have to fetch it, which requires our object
 * storage to be publicly reachable from their network, and the AI SDK blocks private and
 * loopback hosts as an SSRF precaution. The worker reads the object and passes the bytes.
 */
export type ImageInput = {
  data: Uint8Array<ArrayBuffer>
  mime: string
}

export type CustomerContext = {
  displayName: string | null
  primaryLanguage: Language | null
  summary: string | null
  fields: Record<string, string>
}

export type WorkspaceContext = {
  persona: string
  defaultLanguage: Language
}

/** Everything one AI turn needs, gathered by the worker before core is called. */
export type AgentTurnInput = {
  workspace: WorkspaceContext
  customer: CustomerContext
  /** Oldest first. Already redacted. */
  recentMessages: ConversationTurn[]
  /** Agent notes, including any instruction left when handing back to the AI. */
  internalNotes: { body: string; at: Date }[]
  /** Knowledge retrieved for this turn, pre-fetched by the worker before core is called. */
  retrieved: RetrievedChunk[]
  /** Images on the newest customer message, already read from object storage. */
  images: ImageInput[]
}

export type TraceRecord = {
  task: AiTask
  providerId: string | null
  providerName: string | null
  model: string | null
  usedFallback: boolean
  prompt: unknown
  toolCalls: unknown
  retrieved: unknown
  tokensIn: number | null
  tokensOut: number | null
  latencyMs: number
  costEstimate: number | null
  outcome: 'sent' | 'draft' | 'handoff' | 'error'
  error: string | null
}

export type HandoffIntent = {
  reason: HandoffReason
  note: string | null
}

export type AgentTurnResult = {
  /** Plain reply text. Empty when the AI handed off without answering. */
  text: string
  handoff: HandoffIntent | null
  /** Field updates the AI requested via tools, for the worker to apply. */
  customerFieldUpdates: Record<string, string>
  tagsToAdd: string[]
  trace: TraceRecord
}

export class NoSlotConfiguredError extends Error {
  constructor(task: AiTask) {
    super(`No provider configured for the "${task}" slot`)
    this.name = 'NoSlotConfiguredError'
  }
}
