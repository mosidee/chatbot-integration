import type { ConversationMode, ConversationStatus, HandoffReason, Language } from '@ci/shared'

/**
 * The conversation state machine.
 *
 * A pure function: it never touches the database, the queue or the clock. The worker
 * applies the returned patch and carries out the returned effects. That keeps the
 * product's central rules testable in isolation and impossible to bypass accidentally.
 *
 * The invariant that matters most: **while the mode is `human`, no effect may ever send
 * a message to the customer.** A human owns the conversation; the AI may only suggest.
 */

export type ConversationState = {
  mode: ConversationMode
  status: ConversationStatus
  assigneeUserId: string | null
  waitingHumanSince: Date | null
  handoffReason: HandoffReason | null
}

export type ConversationEvent =
  /** An inbound message from the customer arrived and has been stored. */
  | { type: 'customer_message'; at: Date; isMedia?: boolean }
  /** The AI decided it cannot or should not continue. */
  | { type: 'ai_handoff'; at: Date; reason: HandoffReason; note: string | null }
  /** A human clicked "take over". */
  | { type: 'human_take_over'; at: Date; userId: string }
  /** A human handed the conversation back, optionally leaving the AI an instruction. */
  | { type: 'human_return_to_ai'; at: Date; note: string | null }
  /** A human sent a message to the customer. */
  | { type: 'human_message'; at: Date; userId: string }
  | { type: 'assign'; at: Date; userId: string | null }
  | { type: 'set_mode'; at: Date; mode: ConversationMode }
  | { type: 'set_status'; at: Date; status: ConversationStatus }
  /** Nobody picked up a `waiting_human` conversation within the configured window. */
  | { type: 'waiting_human_timeout'; at: Date }

export type Effect =
  /**
   * Run an AI turn.
   * `deliver: 'send'` sends the reply to the customer; `deliver: 'draft'` stores it as a
   * pending draft for a human to approve. Never emitted while the mode is `human`.
   */
  | { type: 'run_ai_turn'; deliver: 'send' | 'draft' }
  /** Produce a suggested reply for the human sidebar. Never sent to the customer. */
  | { type: 'run_suggestion' }
  /** Send the configured acknowledgement text to the customer. */
  | { type: 'send_acknowledgement'; language: Language | null }
  /** Write an internal note visible to agents only. */
  | { type: 'add_internal_note'; body: string }
  /** Tell connected agents something needs attention. */
  | { type: 'notify_agents'; reason: 'handoff' | 'draft_ready' | 'timeout' }
  /** Schedule the waiting-human fallback check. */
  | { type: 'schedule_waiting_human_timeout'; minutes: number }
  /** Cancel a previously scheduled fallback check. */
  | { type: 'cancel_waiting_human_timeout' }
  /** Fold the conversation into the customer's rolling summary and index it for recall. */
  | { type: 'enqueue_summary' }
  /**
   * Record that the AI stopped answering, and why.
   *
   * `at` travels with the effect rather than being taken when it runs, so a retried job
   * replaying an already-computed effect list writes the same instant and the row conflicts
   * with itself instead of counting the same handoff twice. A genuinely repeated turn
   * carries a new instant and is counted again, which is right: it handed off again.
   */
  | { type: 'record_handoff'; reason: HandoffReason; at: Date }

export type TransitionOptions = {
  /** Minutes before a `waiting_human` conversation gets an AI fallback. Null disables it. */
  waitingHumanFallbackMinutes: number | null
  /** Media kinds the AI cannot handle trigger a handoff instead of a reply. */
  handoffOnUnsupportedMedia: boolean
}

export type TransitionResult = {
  patch: Partial<ConversationState> & { lastActivityAt?: Date }
  effects: Effect[]
}

const DEFAULT_OPTIONS: TransitionOptions = {
  waitingHumanFallbackMinutes: null,
  handoffOnUnsupportedMedia: true,
}

/** True when the AI is allowed to produce a reply that reaches the customer. */
export function aiMaySend(mode: ConversationMode): boolean {
  return mode === 'ai'
}

export function transition(
  state: ConversationState,
  event: ConversationEvent,
  options: Partial<TransitionOptions> = {},
): TransitionResult {
  const opts = { ...DEFAULT_OPTIONS, ...options }

  switch (event.type) {
    case 'customer_message':
      return onCustomerMessage(state, event, opts)

    case 'ai_handoff': {
      // Handoff only means anything while the AI owns the conversation.
      if (state.mode === 'human') {
        return { patch: {}, effects: [] }
      }
      const effects: Effect[] = [
        { type: 'record_handoff', reason: event.reason, at: event.at },
        {
          type: 'add_internal_note',
          body: event.note ?? `AI handed off. Reason: ${event.reason}.`,
        },
        { type: 'notify_agents', reason: 'handoff' },
      ]
      if (opts.waitingHumanFallbackMinutes !== null) {
        effects.push({
          type: 'schedule_waiting_human_timeout',
          minutes: opts.waitingHumanFallbackMinutes,
        })
      }
      return {
        patch: {
          mode: 'waiting_human',
          handoffReason: event.reason,
          waitingHumanSince: event.at,
        },
        effects,
      }
    }

    case 'human_take_over':
      return {
        patch: {
          mode: 'human',
          assigneeUserId: event.userId,
          waitingHumanSince: null,
        },
        effects: [{ type: 'cancel_waiting_human_timeout' }],
      }

    case 'human_return_to_ai': {
      const effects: Effect[] = [{ type: 'cancel_waiting_human_timeout' }]
      if (event.note) {
        // The note becomes context the AI reads on its next turn.
        effects.push({ type: 'add_internal_note', body: event.note })
      }
      return {
        patch: {
          mode: 'ai',
          waitingHumanSince: null,
          handoffReason: null,
        },
        effects,
      }
    }

    case 'human_message':
      // A human replying implicitly takes ownership; otherwise the AI could answer next.
      return {
        patch: {
          mode: 'human',
          assigneeUserId: state.assigneeUserId ?? event.userId,
          waitingHumanSince: null,
          status: state.status === 'resolved' ? 'open' : state.status,
        },
        effects: [{ type: 'cancel_waiting_human_timeout' }],
      }

    case 'assign':
      return { patch: { assigneeUserId: event.userId }, effects: [] }

    case 'set_mode': {
      const effects: Effect[] =
        event.mode === 'waiting_human' && opts.waitingHumanFallbackMinutes !== null
          ? [
              {
                type: 'schedule_waiting_human_timeout',
                minutes: opts.waitingHumanFallbackMinutes,
              },
            ]
          : [{ type: 'cancel_waiting_human_timeout' }]
      return {
        patch: {
          mode: event.mode,
          waitingHumanSince: event.mode === 'waiting_human' ? event.at : null,
          handoffReason: event.mode === 'ai' ? null : state.handoffReason,
        },
        effects,
      }
    }

    case 'set_status':
      return {
        patch: { status: event.status },
        effects:
          event.status === 'resolved'
            ? [{ type: 'cancel_waiting_human_timeout' }, { type: 'enqueue_summary' }]
            : [],
      }

    case 'waiting_human_timeout': {
      // Still nobody home: let the AI acknowledge rather than leave the customer silent.
      if (state.mode !== 'waiting_human') return { patch: {}, effects: [] }
      return {
        patch: {},
        effects: [
          { type: 'send_acknowledgement', language: null },
          { type: 'notify_agents', reason: 'timeout' },
        ],
      }
    }
  }
}

function onCustomerMessage(
  state: ConversationState,
  event: Extract<ConversationEvent, { type: 'customer_message' }>,
  opts: TransitionOptions,
): TransitionResult {
  /**
   * A customer message never arrives at a resolved conversation.
   *
   * `resolveConversation` reopens one before the message is stored, because deciding what
   * mode a conversation starts in is its job and beginning again is the same decision. This
   * used to carry a `status: 'open'` patch of its own, which could not run and quietly said
   * the opposite of what the repository did.
   *
   * An agent writing into a resolved conversation does reopen it; see `human_message`.
   */

  switch (state.mode) {
    case 'ai': {
      if (event.isMedia && opts.handoffOnUnsupportedMedia) {
        return {
          patch: {
            mode: 'waiting_human',
            handoffReason: 'unsupported_media',
            waitingHumanSince: event.at,
          },
          effects: [
            { type: 'record_handoff', reason: 'unsupported_media', at: event.at },
            {
              type: 'add_internal_note',
              body: 'Customer sent media the AI cannot interpret. Handed off.',
            },
            { type: 'notify_agents', reason: 'handoff' },
          ],
        }
      }
      return { patch: {}, effects: [{ type: 'run_ai_turn', deliver: 'send' }] }
    }

    case 'ai_supervised':
      return { patch: {}, effects: [{ type: 'run_ai_turn', deliver: 'draft' }] }

    case 'human':
      // The AI may only suggest here. This is the invariant the product depends on.
      return { patch: {}, effects: [{ type: 'run_suggestion' }] }

    case 'waiting_human':
      // Already queued for a human: produce a suggestion so whoever picks it up has a head start.
      return { patch: {}, effects: [{ type: 'run_suggestion' }] }
  }
}
