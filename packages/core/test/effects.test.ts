import { describe, expect, test } from 'bun:test'
import { applyEffects } from '../src/conversation/effects'
import type { Effect } from '../src/conversation/state-machine'
import { transition } from '../src/conversation/state-machine'
import type { EffectContext, EffectPorts, Logger } from '../src/ports'

const ctx: EffectContext = { workspaceId: 'ws-1', conversationId: 'conv-1' }

type Call = { port: string; args: unknown[] }

function fakePorts(failing: Partial<Record<keyof EffectPorts, Error>> = {}) {
  const calls: Call[] = []
  const record =
    (port: keyof EffectPorts) =>
    async (...args: unknown[]) => {
      calls.push({ port, args: args.slice(1) })
      const failure = failing[port]
      if (failure) throw failure
    }

  const ports = {
    enqueueAiTurn: record('enqueueAiTurn'),
    enqueueSuggestion: record('enqueueSuggestion'),
    sendAcknowledgement: record('sendAcknowledgement'),
    addInternalNote: record('addInternalNote'),
    notifyAgents: record('notifyAgents'),
    scheduleWaitingHumanTimeout: record('scheduleWaitingHumanTimeout'),
    cancelWaitingHumanTimeout: record('cancelWaitingHumanTimeout'),
    enqueueSummary: record('enqueueSummary'),
    recordHandoff: record('recordHandoff'),
  } as unknown as EffectPorts

  return { ports, calls }
}

function collectingLogger() {
  const warnings: { message: string; meta?: Record<string, unknown> }[] = []
  const logger: Logger = {
    info: () => {},
    warn: (message, meta) => warnings.push({ message, meta }),
    error: () => {},
  }
  return { logger, warnings }
}

describe('applyEffects', () => {
  test('routes each effect to its port', async () => {
    const { ports, calls } = fakePorts()
    const effects: Effect[] = [
      { type: 'run_ai_turn', deliver: 'send' },
      { type: 'run_suggestion' },
      { type: 'record_handoff', reason: 'low_confidence', at: new Date('2026-09-01T10:00:00Z') },
      { type: 'add_internal_note', body: 'note body' },
      { type: 'notify_agents', reason: 'handoff', at: new Date(0) },
      { type: 'schedule_waiting_human_timeout', minutes: 15 },
      { type: 'cancel_waiting_human_timeout' },
      { type: 'enqueue_summary' },
      {
        type: 'send_acknowledgement',
        kind: 'handoff',
        language: 'th',
        at: new Date('2026-09-01T10:00:00Z'),
      },
    ]

    await applyEffects(effects, ctx, ports)

    expect(calls.map((c) => c.port)).toEqual([
      'enqueueAiTurn',
      'enqueueSuggestion',
      'recordHandoff',
      'addInternalNote',
      'notifyAgents',
      'scheduleWaitingHumanTimeout',
      'cancelWaitingHumanTimeout',
      'enqueueSummary',
      'sendAcknowledgement',
    ])
  })

  test('passes effect payloads through', async () => {
    const { ports, calls } = fakePorts()
    await applyEffects(
      [
        { type: 'run_ai_turn', deliver: 'draft' },
        { type: 'add_internal_note', body: 'refund issued' },
        { type: 'schedule_waiting_human_timeout', minutes: 5 },
        {
          type: 'send_acknowledgement',
          kind: 'still_waiting',
          language: 'en',
          at: new Date('2026-09-01T10:05:00Z'),
        },
      ],
      ctx,
      ports,
    )

    expect(calls[0]?.args).toEqual(['draft'])
    expect(calls[1]?.args).toEqual(['refund issued'])
    expect(calls[2]?.args).toEqual([5])
    expect(calls[3]?.args).toEqual([
      { kind: 'still_waiting', language: 'en', at: new Date('2026-09-01T10:05:00Z') },
    ])
  })

  test('runs effects in order so a note exists before agents are notified', async () => {
    const { ports, calls } = fakePorts()
    const { effects } = transition(
      {
        mode: 'ai',
        status: 'open',
        assigneeUserId: null,
        waitingHumanSince: null,
        handoffReason: null,
      },
      { type: 'ai_handoff', at: new Date(), reason: 'low_confidence', note: 'needs a person' },
    )

    await applyEffects(effects, ctx, ports)

    const order = calls.map((c) => c.port)
    expect(order.indexOf('addInternalNote')).toBeLessThan(order.indexOf('notifyAgents'))
  })

  test('a realtime notify failure is logged, not thrown', async () => {
    const { ports, calls } = fakePorts({ notifyAgents: new Error('redis down') })
    const { logger, warnings } = collectingLogger()

    await applyEffects(
      [
        { type: 'notify_agents', reason: 'handoff', at: new Date(0) },
        { type: 'add_internal_note', body: 'still runs' },
      ],
      ctx,
      ports,
      logger,
    )

    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toBe('realtime notify failed')
    // The following effect still ran.
    expect(calls.map((c) => c.port)).toContain('addInternalNote')
  })

  test('a durable effect failure propagates so the queue retries', async () => {
    const { ports } = fakePorts({ addInternalNote: new Error('db down') })
    await expect(
      applyEffects([{ type: 'add_internal_note', body: 'x' }], ctx, ports),
    ).rejects.toThrow('db down')
  })

  test('stops at the failing effect rather than continuing blindly', async () => {
    const { ports, calls } = fakePorts({ enqueueAiTurn: new Error('queue down') })
    await expect(
      applyEffects(
        [
          { type: 'run_ai_turn', deliver: 'send' },
          { type: 'add_internal_note', body: 'should not run' },
        ],
        ctx,
        ports,
      ),
    ).rejects.toThrow('queue down')
    expect(calls.map((c) => c.port)).toEqual(['enqueueAiTurn'])
  })

  test('an empty effect list is a no-op', async () => {
    const { ports, calls } = fakePorts()
    await applyEffects([], ctx, ports)
    expect(calls).toHaveLength(0)
  })

  test('a human-mode customer message reaches only the suggestion and notify ports', async () => {
    const { ports, calls } = fakePorts()
    const { effects } = transition(
      {
        mode: 'human',
        status: 'open',
        assigneeUserId: 'u1',
        waitingHumanSince: null,
        handoffReason: null,
      },
      { type: 'customer_message', at: new Date() },
    )

    await applyEffects(effects, ctx, ports)

    expect(calls.map((c) => c.port)).toEqual(['enqueueSuggestion', 'notifyAgents'])
    expect(calls.map((c) => c.port)).not.toContain('enqueueAiTurn')
    expect(calls.map((c) => c.port)).not.toContain('sendAcknowledgement')
  })
})
