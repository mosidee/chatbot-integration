import { type JobsOptions, Queue } from 'bullmq'
import type { Redis } from 'ioredis'

/**
 * Queue definitions.
 *
 * Webhook handlers must return quickly — LINE and Meta retry or disable endpoints that
 * respond slowly — so every handler persists the raw event, enqueues, and returns. All
 * real work happens here.
 */

export const QUEUE_NAMES = {
  inbound: 'inbound',
  aiTurn: 'ai_turn',
  suggestion: 'suggestion',
  outbound: 'outbound',
  waitingHuman: 'waiting_human',
  summarize: 'summarize',
  knowledgeIngest: 'knowledge_ingest',
  retention: 'retention',
  customerErasure: 'customer_erasure',
} as const

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES]

/**
 * What the queue knows about the attempt, as opposed to the work.
 *
 * The BullMQ job id is stable across a retry of the same job, which is what makes it usable
 * as an idempotency key for anything a processor sends outside. A value minted inside the
 * processor would differ on every retry, which is the same as sending no key at all.
 */
export type JobMeta = {
  jobId: string
}

export type InboundJob = {
  workspaceId: string
  channelId: string
  inboundEventId: string
}

export type AiTurnJob = {
  workspaceId: string
  conversationId: string
  deliver: 'send' | 'draft'
}

export type SuggestionJob = {
  workspaceId: string
  conversationId: string
}

export type OutboundJob = {
  workspaceId: string
  conversationId: string
  messageId: string
}

export type WaitingHumanTimeoutJob = {
  workspaceId: string
  conversationId: string
}

/** Omit the workspace to sweep every one of them. */
export type RetentionJob = { workspaceId?: string | null }

/**
 * Erasing one customer on request, which Thailand's PDPA gives them a right to. Kept as a
 * job rather than done in the request because it deletes stored media as well as rows, and
 * a half-finished erasure is worse than a slow one.
 */
export type CustomerErasureJob = {
  workspaceId: string
  customerId: string
  requestedByUserId: string | null
}

export type KnowledgeIngestJob = {
  workspaceId: string
  sourceId: string
}

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86400 },
}

export type Queues = {
  [K in QueueName]: Queue
}

/**
 * `prefix` namespaces every key in Redis. Production leaves it at the default; tests set a
 * unique one so parallel fixtures sharing a Redis instance cannot drain each other's jobs.
 */
export function createQueues(connection: Redis, prefix?: string): Queues {
  const make = (name: QueueName) =>
    new Queue(name, {
      connection,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
      ...(prefix ? { prefix } : {}),
    })

  return {
    inbound: make(QUEUE_NAMES.inbound),
    ai_turn: make(QUEUE_NAMES.aiTurn),
    suggestion: make(QUEUE_NAMES.suggestion),
    outbound: make(QUEUE_NAMES.outbound),
    waiting_human: make(QUEUE_NAMES.waitingHuman),
    knowledge_ingest: make(QUEUE_NAMES.knowledgeIngest),
    summarize: make(QUEUE_NAMES.summarize),
    retention: make(QUEUE_NAMES.retention),
    customer_erasure: make(QUEUE_NAMES.customerErasure),
  }
}

/**
 * Deterministic job id for the waiting-human fallback, so scheduling twice replaces the
 * timer rather than firing twice, and cancelling can find it without bookkeeping.
 *
 * No colons. BullMQ rejects a custom id containing ':' unless it splits into exactly three
 * parts, a compatibility carve-out for repeatable jobs. A two-part id like
 * `waiting-human:<id>` throws at enqueue time.
 */
export function waitingHumanJobId(conversationId: string): string {
  return `waiting-human-${conversationId}`
}

/** See waitingHumanJobId for why this avoids colons. */
export function summaryJobId(conversationId: string): string {
  return `summary-${conversationId}`
}

export async function closeQueues(queues: Queues): Promise<void> {
  await Promise.all(Object.values(queues).map((q) => q.close()))
}
