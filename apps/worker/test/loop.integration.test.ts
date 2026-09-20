import { afterEach, describe, expect, test } from 'bun:test'
import { applyEffects, type ConversationState, transition } from '@ci/core'
import { schema } from '@ci/db'
import {
  createEffectPorts,
  ingestWebhook,
  loadWorkspaceSettings,
  storeMessage,
  toWebhookRequest,
  updateConversation,
} from '@ci/infra'
import { asc, desc, eq } from 'drizzle-orm'
import {
  type MockServer,
  startMockOpenAI,
} from '../../../packages/core/test/helpers/mock-openai-server'
import { processAiTurn } from '../src/processors/ai-turn'
import { processInbound } from '../src/processors/inbound'
import { processSuggestion } from '../src/processors/suggestion'
import { createFixture, drainQueue, type Fixture } from './helpers/fixture'

/**
 * The M1 acceptance test.
 *
 * It drives the real ingestion path and the real processors against real Postgres and
 * Redis, with only the model provider mocked. What it proves is the loop the whole product
 * rests on: the AI answers, a human can take it away, the AI falls silent while they hold
 * it, and the conversation can be handed back with an instruction the AI reads.
 */

const servers: MockServer[] = []
const fixtures: Fixture[] = []

afterEach(async () => {
  for (const s of servers.splice(0)) s.stop()
  for (const f of fixtures.splice(0)) await f.cleanup()
})

function mock(...args: Parameters<typeof startMockOpenAI>): MockServer {
  const server = startMockOpenAI(...args)
  servers.push(server)
  return server
}

async function fixture(...args: Parameters<typeof createFixture>): Promise<Fixture> {
  const f = await createFixture(...args)
  fixtures.push(f)
  return f
}

/** Send a customer message through the same path a real webhook takes. */
async function customerSays(
  f: Fixture,
  text: string,
  options: { externalId?: string; eventId?: string } = {},
): Promise<void> {
  const body = {
    externalId: options.externalId ?? 'sim-customer-1',
    message: { kind: 'text', text },
    eventId: options.eventId ?? `evt-${crypto.randomUUID()}`,
    displayName: 'Nok',
  }

  const outcome = await ingestWebhook(
    f.runtime,
    f.runtime.db,
    f.channelId,
    toWebhookRequest(JSON.stringify(body), {}, {}),
  )
  if (!outcome.ok) throw new Error(`ingest failed: ${outcome.reason}`)

  await drainQueue(f.runtime.queues.inbound)
  const ports = createEffectPorts(f.runtime, f.runtime.logger)
  await processInbound(f.runtime, ports, f.runtime.logger, {
    workspaceId: f.workspaceId,
    channelId: f.channelId,
    inboundEventId: outcome.inboundEventId,
  })
}

/** Run whatever the inbound step queued: an AI turn, a suggestion, or nothing. */
async function runQueuedWork(f: Fixture): Promise<void> {
  const ports = createEffectPorts(f.runtime, f.runtime.logger)

  for (const job of await drainQueue<{
    workspaceId: string
    conversationId: string
    deliver: 'send' | 'draft'
  }>(f.runtime.queues.ai_turn)) {
    await processAiTurn(f.runtime, ports, f.runtime.logger, job)
  }

  for (const job of await drainQueue<{ workspaceId: string; conversationId: string }>(
    f.runtime.queues.suggestion,
  )) {
    await processSuggestion(f.runtime, ports, f.runtime.logger, job)
  }
}

async function onlyConversation(f: Fixture) {
  const rows = await f.runtime.db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.workspaceId, f.workspaceId))
    .orderBy(desc(schema.conversations.createdAt))
    .limit(1)
  const conversation = rows[0]
  if (!conversation) throw new Error('no conversation was created')
  return conversation
}

async function messagesOf(f: Fixture, conversationId: string) {
  return f.runtime.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, conversationId))
    .orderBy(asc(schema.messages.createdAt))
}

async function humanAction(
  f: Fixture,
  conversationId: string,
  event: Parameters<typeof transition>[1],
): Promise<void> {
  const rows = await f.runtime.db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.id, conversationId))
    .limit(1)
  const row = rows[0]
  if (!row) throw new Error('conversation vanished')

  const state: ConversationState = {
    mode: row.mode,
    status: row.status,
    assigneeUserId: row.assigneeUserId,
    waitingHumanSince: row.waitingHumanSince,
    handoffReason: row.handoffReason,
  }

  const settings = await loadWorkspaceSettings(f.runtime.db, f.workspaceId)
  const { patch, effects } = transition(state, event, {
    waitingHumanFallbackMinutes: settings.waitingHumanFallbackMinutes,
  })
  if (Object.keys(patch).length > 0) {
    await updateConversation(f.runtime.db, f.workspaceId, conversationId, patch)
  }
  await applyEffects(
    effects,
    { workspaceId: f.workspaceId, conversationId },
    createEffectPorts(f.runtime, f.runtime.logger),
    f.runtime.logger,
  )
}

describe('the AI and human loop', () => {
  test('a customer message is answered by the AI', async () => {
    const provider = mock([{ kind: 'text', text: 'แพ็กเกจเริ่มต้น 990 บาทต่อเดือนค่ะ' }])
    const f = await fixture({ providerBaseUrl: provider.url })

    await customerSays(f, 'ราคาเท่าไหร่คะ')
    await runQueuedWork(f)

    const conversation = await onlyConversation(f)
    expect(conversation.mode).toBe('ai')

    const messages = await messagesOf(f, conversation.id)
    expect(messages).toHaveLength(2)
    expect(messages[0]?.senderType).toBe('customer')
    expect(messages[0]?.text).toBe('ราคาเท่าไหร่คะ')
    expect(messages[1]?.senderType).toBe('ai')
    expect(messages[1]?.text).toBe('แพ็กเกจเริ่มต้น 990 บาทต่อเดือนค่ะ')

    // The reply was queued for delivery rather than sent inline.
    const outbound = await drainQueue<{ messageId: string }>(f.runtime.queues.outbound)
    expect(outbound.map((j) => j.messageId)).toContain(messages[1]?.id)
  })

  test('an AI reply records a trace with model, tokens and outcome', async () => {
    const provider = mock([{ kind: 'text', text: 'ok' }])
    const f = await fixture({ providerBaseUrl: provider.url })

    await customerSays(f, 'hello')
    await runQueuedWork(f)

    const traces = await f.runtime.db
      .select()
      .from(schema.aiTraces)
      .where(eq(schema.aiTraces.workspaceId, f.workspaceId))
    expect(traces).toHaveLength(1)
    expect(traces[0]?.outcome).toBe('sent')
    expect(traces[0]?.model).toBe('mock-model')
    expect(traces[0]?.tokensIn).toBe(100)
    expect(traces[0]?.usedFallback).toBe(false)
  })

  test('taking over stops the AI: the next message only produces a suggestion', async () => {
    const provider = mock([{ kind: 'text', text: 'a reply' }])
    const f = await fixture({ providerBaseUrl: provider.url })

    await customerSays(f, 'first question')
    await runQueuedWork(f)
    const conversation = await onlyConversation(f)

    await humanAction(f, conversation.id, {
      type: 'human_take_over',
      at: new Date(),
      userId: f.userId,
    })

    const afterTakeOver = await onlyConversation(f)
    expect(afterTakeOver.mode).toBe('human')

    await customerSays(f, 'second question')

    // No AI turn was queued at all; only a suggestion.
    const aiJobs = await drainQueue(f.runtime.queues.ai_turn)
    expect(aiJobs).toHaveLength(0)

    await runQueuedWork(f)

    const messages = await messagesOf(f, conversation.id)
    const aiMessagesAfterTakeOver = messages.filter(
      (m) => m.senderType === 'ai' && m.text !== 'a reply',
    )
    expect(aiMessagesAfterTakeOver).toHaveLength(0)

    const suggestions = await f.runtime.db
      .select()
      .from(schema.suggestions)
      .where(eq(schema.suggestions.conversationId, conversation.id))
    expect(suggestions.length).toBeGreaterThan(0)
    expect(suggestions[0]?.status).toBe('pending')
  })

  test('an AI turn queued before a take-over refuses to send when it runs after', async () => {
    const provider = mock([{ kind: 'text', text: 'too late' }])
    const f = await fixture({ providerBaseUrl: provider.url })

    await customerSays(f, 'question')
    const conversation = await onlyConversation(f)

    // The job is queued while the mode is still `ai`.
    const queued = await drainQueue<{
      workspaceId: string
      conversationId: string
      deliver: 'send' | 'draft'
    }>(f.runtime.queues.ai_turn)
    expect(queued).toHaveLength(1)

    // A human takes over in the meantime.
    await humanAction(f, conversation.id, {
      type: 'human_take_over',
      at: new Date(),
      userId: f.userId,
    })

    const ports = createEffectPorts(f.runtime, f.runtime.logger)
    const job = queued[0]
    if (!job) throw new Error('expected a queued AI turn')
    await processAiTurn(f.runtime, ports, f.runtime.logger, job)

    const messages = await messagesOf(f, conversation.id)
    expect(messages.filter((m) => m.senderType === 'ai')).toHaveLength(0)

    // It converted itself into a suggestion instead of going silent.
    const suggestionJobs = await drainQueue(f.runtime.queues.suggestion)
    expect(suggestionJobs).toHaveLength(1)
  })

  test('a human reply is stored and queued for delivery', async () => {
    const provider = mock([{ kind: 'text', text: 'ai reply' }])
    const f = await fixture({ providerBaseUrl: provider.url })

    await customerSays(f, 'question')
    await runQueuedWork(f)
    const conversation = await onlyConversation(f)

    await humanAction(f, conversation.id, {
      type: 'human_take_over',
      at: new Date(),
      userId: f.userId,
    })

    const settings = await loadWorkspaceSettings(f.runtime.db, f.workspaceId)
    const stored = await storeMessage(f.runtime.db, {
      workspaceId: f.workspaceId,
      conversationId: conversation.id,
      direction: 'outbound',
      senderType: 'human',
      senderUserId: f.userId,
      message: { kind: 'text', text: 'สวัสดีค่ะ เดี๋ยวตรวจสอบให้นะคะ' },
      status: 'queued',
      redaction: settings.redaction,
    })

    const messages = await messagesOf(f, conversation.id)
    const human = messages.find((m) => m.id === stored.id)
    expect(human?.senderType).toBe('human')
    expect(human?.senderUserId).toBe(f.userId)
  })

  test('returning to the AI passes the agent instruction into the next prompt', async () => {
    const provider = mock([
      { kind: 'text', text: 'first' },
      { kind: 'text', text: 'second' },
    ])
    const f = await fixture({ providerBaseUrl: provider.url })

    await customerSays(f, 'question one')
    await runQueuedWork(f)
    const conversation = await onlyConversation(f)

    await humanAction(f, conversation.id, {
      type: 'human_take_over',
      at: new Date(),
      userId: f.userId,
    })
    await humanAction(f, conversation.id, {
      type: 'human_return_to_ai',
      at: new Date(),
      note: 'Refund already issued; confirm the shipping date only.',
    })

    const returned = await onlyConversation(f)
    expect(returned.mode).toBe('ai')

    await customerSays(f, 'question two')
    await runQueuedWork(f)

    // The note reached the model as internal context.
    const lastRequest = provider.requests.at(-1) as {
      messages: { role: string; content: string }[]
    }
    const system = lastRequest.messages.find((m) => m.role === 'system')?.content ?? ''
    expect(system).toContain('Refund already issued; confirm the shipping date only.')
  })

  test('the AI handing off moves the conversation to waiting_human with a note', async () => {
    const provider = mock([
      {
        kind: 'tool_calls',
        toolCalls: [
          {
            name: 'handoff_to_human',
            arguments: { reason: 'customer_requested', note: 'Customer asked for a person.' },
          },
        ],
      },
      { kind: 'text', text: 'ขอโอนสายนะคะ' },
    ])
    const f = await fixture({ providerBaseUrl: provider.url })

    await customerSays(f, 'ขอคุยกับเจ้าหน้าที่')
    await runQueuedWork(f)

    const conversation = await onlyConversation(f)
    expect(conversation.mode).toBe('waiting_human')
    expect(conversation.handoffReason).toBe('customer_requested')

    const notes = await f.runtime.db
      .select()
      .from(schema.internalNotes)
      .where(eq(schema.internalNotes.conversationId, conversation.id))
    expect(notes.map((n) => n.body).join(' ')).toContain('Customer asked for a person.')

    // Nothing was sent to the customer by the AI.
    const messages = await messagesOf(f, conversation.id)
    expect(messages.filter((m) => m.senderType === 'ai')).toHaveLength(0)
  })

  test('card numbers are masked before they reach the database or the model', async () => {
    const provider = mock([{ kind: 'text', text: 'ขอบคุณค่ะ' }])
    const f = await fixture({ providerBaseUrl: provider.url })

    await customerSays(f, 'บัตรของฉันคือ 4242 4242 4242 4242 ค่ะ')
    await runQueuedWork(f)

    const conversation = await onlyConversation(f)
    const messages = await messagesOf(f, conversation.id)
    const inbound = messages[0]

    expect(inbound?.text).toContain('[card ••••4242]')
    expect(inbound?.text).not.toContain('4242 4242 4242 4242')
    expect(JSON.stringify(inbound?.content)).not.toContain('4242 4242 4242 4242')
    expect(inbound?.redactionFindings).toEqual([{ type: 'card_number', count: 1 }])

    // And the model never saw it either.
    const sent = JSON.stringify(provider.requests[0])
    expect(sent).not.toContain('4242 4242 4242 4242')
    expect(sent).toContain('[card ••••4242]')
  })

  test('a provider outage falls over to the secondary instead of going silent', async () => {
    const down = mock([{ kind: 'error', status: 503, message: 'upstream unavailable' }])
    const up = mock([{ kind: 'text', text: 'answered by the fallback' }])
    const f = await fixture({ providerBaseUrl: down.url, fallbackBaseUrl: up.url })

    await customerSays(f, 'hello')
    await runQueuedWork(f)

    const conversation = await onlyConversation(f)
    const messages = await messagesOf(f, conversation.id)
    expect(messages[1]?.text).toBe('answered by the fallback')

    const traces = await f.runtime.db
      .select()
      .from(schema.aiTraces)
      .where(eq(schema.aiTraces.workspaceId, f.workspaceId))
    expect(traces[0]?.usedFallback).toBe(true)
    expect(traces[0]?.providerName).toBe('mock-fallback')
  })

  test('a total provider failure hands off to a human rather than staying silent', async () => {
    const down = mock([{ kind: 'error', status: 500, message: 'boom' }])
    const f = await fixture({ providerBaseUrl: down.url })

    await customerSays(f, 'hello')
    await runQueuedWork(f)

    const conversation = await onlyConversation(f)
    expect(conversation.mode).toBe('waiting_human')
    expect(conversation.handoffReason).toBe('model_error')
  })

  test('a retried webhook does not produce a second customer message', async () => {
    const provider = mock([{ kind: 'text', text: 'ok' }])
    const f = await fixture({ providerBaseUrl: provider.url })

    const body = {
      externalId: 'sim-customer-1',
      message: { kind: 'text', text: 'duplicate me' },
      eventId: 'evt-fixed',
      displayName: 'Nok',
    }
    const request = toWebhookRequest(JSON.stringify(body), {}, {})

    const first = await ingestWebhook(f.runtime, f.runtime.db, f.channelId, request)
    const second = await ingestWebhook(f.runtime, f.runtime.db, f.channelId, request)

    expect(first.ok && first.duplicate).toBe(false)
    expect(second.ok && second.duplicate).toBe(true)

    await drainQueue(f.runtime.queues.inbound)
    const ports = createEffectPorts(f.runtime, f.runtime.logger)
    if (!first.ok) throw new Error('first ingest failed')
    await processInbound(f.runtime, ports, f.runtime.logger, {
      workspaceId: f.workspaceId,
      channelId: f.channelId,
      inboundEventId: first.inboundEventId,
    })

    const conversation = await onlyConversation(f)
    const messages = await messagesOf(f, conversation.id)
    expect(messages.filter((m) => m.senderType === 'customer')).toHaveLength(1)
  })

  test('two customers on one channel get separate conversations and customers', async () => {
    const provider = mock([{ kind: 'text', text: 'ok' }])
    const f = await fixture({ providerBaseUrl: provider.url })

    await customerSays(f, 'hello from A', { externalId: 'customer-a' })
    await customerSays(f, 'hello from B', { externalId: 'customer-b' })

    const conversations = await f.runtime.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.workspaceId, f.workspaceId))
    expect(conversations).toHaveLength(2)

    const customers = await f.runtime.db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.workspaceId, f.workspaceId))
    expect(customers).toHaveLength(2)
  })

  test('a follow-up from the same customer continues the same conversation', async () => {
    const provider = mock([{ kind: 'text', text: 'ok' }])
    const f = await fixture({ providerBaseUrl: provider.url })

    await customerSays(f, 'first')
    await runQueuedWork(f)
    await customerSays(f, 'second')
    await runQueuedWork(f)

    const conversations = await f.runtime.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.workspaceId, f.workspaceId))
    expect(conversations).toHaveLength(1)

    const messages = await messagesOf(f, conversations[0]?.id ?? '')
    expect(messages.filter((m) => m.senderType === 'customer')).toHaveLength(2)
  })

  test('the workspace default mode decides whether the AI answers or drafts', async () => {
    const provider = mock([{ kind: 'text', text: 'a draft for review' }])
    const f = await fixture({
      providerBaseUrl: provider.url,
      settings: { defaultMode: 'ai_supervised' },
    })

    await customerSays(f, 'question')
    await runQueuedWork(f)

    const conversation = await onlyConversation(f)
    const messages = await messagesOf(f, conversation.id)
    // Nothing was sent to the customer.
    expect(messages.filter((m) => m.direction === 'outbound')).toHaveLength(0)

    const suggestions = await f.runtime.db
      .select()
      .from(schema.suggestions)
      .where(eq(schema.suggestions.conversationId, conversation.id))
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]?.messageText).toBe('a draft for review')
  })

  test('every row created is scoped to its workspace', async () => {
    const provider = mock([{ kind: 'text', text: 'ok' }])
    const f = await fixture({ providerBaseUrl: provider.url })

    await customerSays(f, 'hello')
    await runQueuedWork(f)

    for (const table of [
      schema.conversations,
      schema.messages,
      schema.customers,
      schema.channelIdentities,
      schema.aiTraces,
      schema.inboundEvents,
    ]) {
      const rows = await f.runtime.db
        .select({ workspaceId: table.workspaceId })
        .from(table)
        .where(eq(table.workspaceId, f.workspaceId))
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) expect(row.workspaceId).toBe(f.workspaceId)
    }
  })
})
