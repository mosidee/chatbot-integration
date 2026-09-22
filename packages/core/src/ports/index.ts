import type { HandoffReason, Language, NormalizedMessage } from '@ci/shared'

/**
 * Ports: the capabilities core needs from the outside world.
 *
 * Core defines the interfaces; `apps/worker` and `apps/api` supply implementations backed
 * by Drizzle, BullMQ, Redis and object storage. This keeps every domain rule testable with
 * fakes and keeps runtime-specific code out of the package the worker depends on.
 */

/** Identifies the conversation an effect applies to. */
export type EffectContext = {
  workspaceId: string
  conversationId: string
  /**
   * The customer message this work answers, where there is one.
   *
   * Carried so the queue can name a job after it. A retry of the same turn is then the same
   * job rather than a second answer, and the processor can tell that an earlier attempt
   * already replied. A plain string, because `packages/core` describes what the domain
   * needs and knows nothing about queues.
   */
  triggerMessageId?: string
  /** An explicit key where no message prompted the work, such as a completed identity proof. */
  turnKey?: string
}

export type NotifyReason = 'handoff' | 'draft_ready' | 'timeout'

export type EffectPorts = {
  /** Queue an AI turn. `deliver` decides whether the reply is sent or stored as a draft. */
  enqueueAiTurn(ctx: EffectContext, deliver: 'send' | 'draft'): Promise<void>
  /** Queue a suggested reply for the human sidebar. Never reaches the customer. */
  enqueueSuggestion(ctx: EffectContext): Promise<void>
  /** Send the workspace's acknowledgement text to the customer. */
  sendAcknowledgement(ctx: EffectContext, language: Language | null): Promise<void>
  /** Write a note visible to agents only. */
  addInternalNote(ctx: EffectContext, body: string): Promise<void>
  /** Best-effort realtime nudge to connected agents. Failures must not fail the job. */
  notifyAgents(ctx: EffectContext, reason: NotifyReason): Promise<void>
  scheduleWaitingHumanTimeout(ctx: EffectContext, minutes: number): Promise<void>
  cancelWaitingHumanTimeout(ctx: EffectContext): Promise<void>
  /** Queue a summary rewrite. The implementation resolves the customer from the conversation. */
  enqueueSummary(ctx: EffectContext): Promise<void>
  /** Record that the AI handed off, for reporting. Must ignore a repeat of the same instant. */
  recordHandoff(ctx: EffectContext, reason: HandoffReason, at: Date): Promise<void>
}

/** Object storage, used to read media before handing it to a vision model. */
export type BlobStore = {
  /**
   * Bytes are typed as ArrayBuffer-backed rather than the wider ArrayBufferLike, because
   * Response, Blob and Web Crypto all reject a possibly-shared buffer.
   */
  get(key: string): Promise<{ data: Uint8Array<ArrayBuffer>; mime: string }>
  put(key: string, data: Uint8Array<ArrayBuffer>, mime: string): Promise<void>
  /**
   * Erase one object. Silent when it is already gone, because retention and a customer's
   * request to be erased both re-run after a partial failure and neither should fail on
   * work already done.
   */
  remove(key: string): Promise<void>
  /** A URL an agent's browser can open. Not given to model providers; see ADR 0001. */
  urlFor(key: string): string
}

/** Realtime fan-out, backed by Redis pub/sub so any replica count works. */
export type Publisher = {
  publish(workspaceId: string, event: unknown): Promise<void>
}

/** Injectable clock so time-dependent rules are testable. */
export type Clock = {
  now(): Date
}

export const systemClock: Clock = { now: () => new Date() }

/** Structured logging, so core can report without choosing a logger. */
export type Logger = {
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

/** Sending a message out through whichever channel the conversation belongs to. */
export type Outbox = {
  send(
    ctx: EffectContext,
    message: NormalizedMessage,
    meta: { senderType: 'ai' | 'human' | 'system'; senderUserId: string | null },
  ): Promise<void>
}

export type HandoffApplier = {
  apply(ctx: EffectContext, reason: HandoffReason, note: string | null): Promise<void>
}
