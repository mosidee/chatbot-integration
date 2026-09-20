import { describe, expect, test } from 'bun:test'
import type { ConversationMode, ConversationStatus } from '@ci/shared'
import {
  aiMaySend,
  type ConversationEvent,
  type ConversationState,
  type Effect,
  transition,
} from '../src/conversation/state-machine'

const AT = new Date('2026-09-20T10:00:00Z')

function state(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    mode: 'ai',
    status: 'open',
    assigneeUserId: null,
    waitingHumanSince: null,
    handoffReason: null,
    ...overrides,
  }
}

const types = (effects: Effect[]) => effects.map((e) => e.type)

describe('customer message routing', () => {
  test('ai mode runs an AI turn that is sent', () => {
    const { effects } = transition(state({ mode: 'ai' }), { type: 'customer_message', at: AT })
    expect(effects).toEqual([{ type: 'run_ai_turn', deliver: 'send' }])
  })

  test('ai_supervised mode runs an AI turn that is only drafted', () => {
    const { effects } = transition(state({ mode: 'ai_supervised' }), {
      type: 'customer_message',
      at: AT,
    })
    expect(effects).toEqual([{ type: 'run_ai_turn', deliver: 'draft' }])
  })

  test('human mode only produces a suggestion', () => {
    const { effects } = transition(state({ mode: 'human' }), { type: 'customer_message', at: AT })
    expect(effects).toEqual([{ type: 'run_suggestion' }])
  })

  test('waiting_human mode produces a suggestion for whoever picks it up', () => {
    const { effects } = transition(state({ mode: 'waiting_human' }), {
      type: 'customer_message',
      at: AT,
    })
    expect(effects).toEqual([{ type: 'run_suggestion' }])
  })

  test('a resolved conversation reopens when the customer writes again', () => {
    const { patch } = transition(state({ mode: 'ai', status: 'resolved' }), {
      type: 'customer_message',
      at: AT,
    })
    expect(patch.status).toBe('open')
  })

  test('unsupported media hands off instead of answering', () => {
    const { patch, effects } = transition(
      state({ mode: 'ai' }),
      { type: 'customer_message', at: AT, isMedia: true },
      { handoffOnUnsupportedMedia: true },
    )
    expect(patch.mode).toBe('waiting_human')
    expect(patch.handoffReason).toBe('unsupported_media')
    expect(types(effects)).toContain('notify_agents')
  })

  test('media is answered normally when handoff is disabled (vision configured)', () => {
    const { effects } = transition(
      state({ mode: 'ai' }),
      { type: 'customer_message', at: AT, isMedia: true },
      { handoffOnUnsupportedMedia: false },
    )
    expect(effects).toEqual([{ type: 'run_ai_turn', deliver: 'send' }])
  })
})

describe('handoff', () => {
  test('moves to waiting_human, notes the reason and notifies agents', () => {
    const { patch, effects } = transition(state({ mode: 'ai' }), {
      type: 'ai_handoff',
      at: AT,
      reason: 'low_confidence',
      note: null,
    })
    expect(patch.mode).toBe('waiting_human')
    expect(patch.handoffReason).toBe('low_confidence')
    expect(patch.waitingHumanSince).toBe(AT)
    expect(types(effects)).toEqual(['add_internal_note', 'notify_agents'])
  })

  test('schedules the fallback timer when configured', () => {
    const { effects } = transition(
      state({ mode: 'ai' }),
      { type: 'ai_handoff', at: AT, reason: 'ai_requested', note: null },
      { waitingHumanFallbackMinutes: 15 },
    )
    expect(effects).toContainEqual({ type: 'schedule_waiting_human_timeout', minutes: 15 })
  })

  test('is ignored when a human already owns the conversation', () => {
    const result = transition(state({ mode: 'human' }), {
      type: 'ai_handoff',
      at: AT,
      reason: 'model_error',
      note: null,
    })
    expect(result.patch).toEqual({})
    expect(result.effects).toEqual([])
  })

  test('uses the AI-supplied note when present', () => {
    const { effects } = transition(state({ mode: 'ai' }), {
      type: 'ai_handoff',
      at: AT,
      reason: 'customer_requested',
      note: 'Customer asked for a human about refund #882.',
    })
    expect(effects[0]).toEqual({
      type: 'add_internal_note',
      body: 'Customer asked for a human about refund #882.',
    })
  })
})

describe('human control', () => {
  test('take over assigns the agent and cancels the timer', () => {
    const { patch, effects } = transition(state({ mode: 'waiting_human' }), {
      type: 'human_take_over',
      at: AT,
      userId: 'user-1',
    })
    expect(patch.mode).toBe('human')
    expect(patch.assigneeUserId).toBe('user-1')
    expect(patch.waitingHumanSince).toBeNull()
    expect(effects).toEqual([{ type: 'cancel_waiting_human_timeout' }])
  })

  test('take over works from any mode', () => {
    for (const mode of ['ai', 'ai_supervised', 'human', 'waiting_human'] as ConversationMode[]) {
      const { patch } = transition(state({ mode }), {
        type: 'human_take_over',
        at: AT,
        userId: 'u',
      })
      expect(patch.mode).toBe('human')
    }
  })

  test('returning to AI clears the handoff reason', () => {
    const { patch, effects } = transition(
      state({ mode: 'human', handoffReason: 'low_confidence' }),
      { type: 'human_return_to_ai', at: AT, note: null },
    )
    expect(patch.mode).toBe('ai')
    expect(patch.handoffReason).toBeNull()
    expect(effects).toEqual([{ type: 'cancel_waiting_human_timeout' }])
  })

  test('an instruction note is recorded for the AI to read', () => {
    const { effects } = transition(state({ mode: 'human' }), {
      type: 'human_return_to_ai',
      at: AT,
      note: 'Refund already issued; just confirm the shipping date.',
    })
    expect(effects).toContainEqual({
      type: 'add_internal_note',
      body: 'Refund already issued; just confirm the shipping date.',
    })
  })

  test('a human reply takes ownership of an AI conversation', () => {
    const { patch } = transition(state({ mode: 'ai' }), {
      type: 'human_message',
      at: AT,
      userId: 'user-9',
    })
    expect(patch.mode).toBe('human')
    expect(patch.assigneeUserId).toBe('user-9')
  })

  test('a human reply reopens a resolved conversation', () => {
    const { patch } = transition(state({ mode: 'human', status: 'resolved' }), {
      type: 'human_message',
      at: AT,
      userId: 'u',
    })
    expect(patch.status).toBe('open')
  })
})

describe('mode and status changes', () => {
  test('setting mode to waiting_human schedules the fallback', () => {
    const { effects } = transition(
      state({ mode: 'ai' }),
      { type: 'set_mode', at: AT, mode: 'waiting_human' },
      { waitingHumanFallbackMinutes: 5 },
    )
    expect(effects).toContainEqual({ type: 'schedule_waiting_human_timeout', minutes: 5 })
  })

  test('setting mode back to ai clears the handoff reason', () => {
    const { patch } = transition(state({ mode: 'waiting_human', handoffReason: 'tool_error' }), {
      type: 'set_mode',
      at: AT,
      mode: 'ai',
    })
    expect(patch.handoffReason).toBeNull()
  })

  test('resolving cancels the fallback timer', () => {
    const { effects } = transition(state({ mode: 'waiting_human' }), {
      type: 'set_status',
      at: AT,
      status: 'resolved',
    })
    expect(effects).toEqual([{ type: 'cancel_waiting_human_timeout' }])
  })

  test('assignment does not change the mode', () => {
    const { patch } = transition(state({ mode: 'ai' }), { type: 'assign', at: AT, userId: 'u' })
    expect(patch.mode).toBeUndefined()
    expect(patch.assigneeUserId).toBe('u')
  })
})

describe('waiting-human timeout', () => {
  test('acknowledges the customer and notifies agents', () => {
    const { effects } = transition(state({ mode: 'waiting_human' }), {
      type: 'waiting_human_timeout',
      at: AT,
    })
    expect(types(effects)).toEqual(['send_acknowledgement', 'notify_agents'])
  })

  test('is ignored once somebody has taken over', () => {
    const result = transition(state({ mode: 'human' }), { type: 'waiting_human_timeout', at: AT })
    expect(result.effects).toEqual([])
  })
})

describe('the central invariant: the AI never sends while a human owns the conversation', () => {
  const modes: ConversationMode[] = ['ai', 'ai_supervised', 'human', 'waiting_human']
  const statuses: ConversationStatus[] = ['open', 'snoozed', 'resolved']
  const events: ConversationEvent[] = [
    { type: 'customer_message', at: AT },
    { type: 'customer_message', at: AT, isMedia: true },
    { type: 'ai_handoff', at: AT, reason: 'low_confidence', note: null },
    { type: 'human_take_over', at: AT, userId: 'u' },
    { type: 'human_return_to_ai', at: AT, note: 'note' },
    { type: 'human_message', at: AT, userId: 'u' },
    { type: 'assign', at: AT, userId: 'u' },
    { type: 'set_status', at: AT, status: 'resolved' },
    { type: 'waiting_human_timeout', at: AT },
  ]

  test('no effect reaching the customer is emitted from human mode', () => {
    for (const status of statuses) {
      for (const event of events) {
        const { effects } = transition(state({ mode: 'human', status }), event, {
          waitingHumanFallbackMinutes: 10,
        })
        for (const effect of effects) {
          expect(effect.type).not.toBe('send_acknowledgement')
          if (effect.type === 'run_ai_turn') {
            throw new Error(`run_ai_turn emitted from human mode on ${event.type}`)
          }
        }
      }
    }
  })

  test('aiMaySend is true only for ai mode', () => {
    expect(modes.filter(aiMaySend)).toEqual(['ai'])
  })

  test('every mode and event pair produces a defined result', () => {
    for (const mode of modes) {
      for (const status of statuses) {
        for (const event of events) {
          const result = transition(state({ mode, status }), event)
          expect(result).toBeDefined()
          expect(Array.isArray(result.effects)).toBe(true)
        }
      }
    }
  })
})
