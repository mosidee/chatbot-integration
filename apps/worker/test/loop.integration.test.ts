import { afterEach, describe, expect, test } from 'bun:test'
import { signBodyBase64 } from '@ci/channels'
import { applyEffects, type ConversationState, transition } from '@ci/core'
import { newId, schema } from '@ci/db'
import {
  acceptMergeSuggestion,
  applyReceipt,
  consumeVerificationCode,
  conversationForReceipt,
  countPendingMerges,
  countReviewQueue,
  createEffectPorts,
  createEntry,
  createSource,
  eraseCustomer,
  findVerificationCode,
  indexEntry,
  ingestInternal,
  ingestWebhook,
  listMergeSuggestions,
  loadDashboard,
  loadWorkspaceSettings,
  markReviewed,
  markSuggestionSent,
  recordVerifiedIdentity,
  relayOnce,
  resolveIdleConversations,
  runRetention,
  sendVerificationLink,
  storeMessage,
  updateConversation,
  upsertFeedback,
  waitingHumanJobId,
} from '@ci/infra'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import {
  type MockServer,
  startMockOpenAI,
} from '../../../packages/core/test/helpers/mock-openai-server'
import { handOffAfterFailure, processAiTurn } from '../src/processors/ai-turn'
import { processIdleResolve } from '../src/processors/idle-resolve'
import { processInbound } from '../src/processors/inbound'
import { processOutbound } from '../src/processors/outbound'
import { processSuggestion } from '../src/processors/suggestion'
import { processSummarize } from '../src/processors/summarize'
import { processWaitingHumanTimeout } from '../src/processors/waiting-human'
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

/**
 * Move whatever has been promised into the queue.
 *
 * Work is written to the outbox inside the transaction that made it necessary; the running
 * worker relays it on a timer and a notification. A test looking straight at BullMQ has to
 * do the same, or it sees an empty queue and concludes nothing was asked for.
 */
async function relay(f: Fixture): Promise<void> {
  await relayOnce(f.runtime.db, f.queues)
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

  // The simulator's own path: a test channel is not reachable through the public webhook
  // route, which serves only adapters that can verify a platform signature.
  const outcome = await ingestInternal(f.runtime, f.runtime.db, {
    channelId: f.channelId,
    expectedType: 'test',
    body,
  })
  if (!outcome.ok) throw new Error(`ingest failed: ${outcome.reason}`)

  await drainQueue(f, f.queues.inbound)
  const ports = createEffectPorts(f.runtime, f.runtime.logger)
  await processInbound(f.runtime, ports, f.runtime.logger, {
    workspaceId: f.workspaceId,
    channelId: f.channelId,
    inboundEventId: outcome.inboundEventId,
  })
}

/** The effect ports, as every processor gets them. */
function portsFor(f: Fixture) {
  return createEffectPorts(f.runtime, f.runtime.logger)
}

/** Run whatever the inbound step queued: an AI turn, a suggestion, or nothing. */
async function runQueuedWork(f: Fixture): Promise<void> {
  const ports = createEffectPorts(f.runtime, f.runtime.logger)

  for (const job of await drainQueue<{
    workspaceId: string
    conversationId: string
    deliver: 'send' | 'draft'
  }>(f, f.queues.ai_turn)) {
    await processAiTurn(f.runtime, ports, f.runtime.logger, job)
  }

  for (const job of await drainQueue<{ workspaceId: string; conversationId: string }>(
    f,
    f.queues.suggestion,
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
    expect(messages[1]?.text ?? '').toBe('แพ็กเกจเริ่มต้น 990 บาทต่อเดือนค่ะ')

    // The reply was queued for delivery rather than sent inline.
    const outbound = await drainQueue<{ messageId: string }>(f, f.queues.outbound)
    expect(outbound.map((j) => j.messageId)).toContain(messages[1]?.id ?? '')
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
    const aiJobs = await drainQueue(f, f.queues.ai_turn)
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
    }>(f, f.queues.ai_turn)
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
    const suggestionJobs = await drainQueue(f, f.queues.suggestion)
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

  test('an empty answer hands off instead of leaving the customer in silence', async () => {
    // Seen on a live LINE conversation: a reasoning model spent its whole output budget
    // thinking and returned nothing. The turn ended quietly, the customer was never
    // answered, and no colleague was told there was anything to answer.
    const mute = mock([{ kind: 'text', text: '' }])
    const f = await fixture({ providerBaseUrl: mute.url })

    await customerSays(f, 'ช่วยดูรูปนี้ให้หน่อยค่ะ')
    await runQueuedWork(f)

    const conversation = await onlyConversation(f)
    expect(conversation.mode).toBe('waiting_human')
    expect(conversation.handoffReason).toBe('model_error')

    // And a colleague can see why, rather than finding an unanswered conversation.
    const notes = await f.runtime.db
      .select()
      .from(schema.internalNotes)
      .where(eq(schema.internalNotes.conversationId, conversation.id))
    expect(notes.map((n) => n.body).join(' ')).toContain('nothing at all')

    // Nothing was sent to the customer, which is the one thing that must stay true.
    const messages = await messagesOf(f, conversation.id)
    expect(messages.filter((m) => m.senderType === 'ai')).toHaveLength(0)
  })

  test('delivery and read receipts raise message status and never lower it', async () => {
    // Messenger reports these as a watermark over the conversation, not per message, and
    // the two often arrive out of order. Applying one blindly would flip a message that was
    // read back to merely delivered, and the tick in the console would go backwards.
    const provider = mock([{ kind: 'text', text: 'สวัสดีค่ะ' }])
    const f = await fixture({ providerBaseUrl: provider.url })

    await customerSays(f, 'สวัสดีครับ')
    await runQueuedWork(f)

    const conversation = await onlyConversation(f)
    const outbound = (await messagesOf(f, conversation.id)).filter(
      (m) => m.direction === 'outbound',
    )
    expect(outbound.length).toBeGreaterThan(0)
    const first = outbound[0]
    if (!first) throw new Error('expected an outbound message')
    const sentAt = first.createdAt

    const statusNow = async () => {
      const rows = await messagesOf(f, conversation.id)
      return rows.find((m) => m.id === first.id)?.status
    }

    const after = new Date(sentAt.getTime() + 1000).getTime()

    expect(
      await applyReceipt(f.runtime.db, {
        workspaceId: f.workspaceId,
        conversationId: conversation.id,
        receipt: 'delivered',
        watermark: after,
      }),
    ).toBe(outbound.length)
    expect(await statusNow()).toBe('delivered')

    await applyReceipt(f.runtime.db, {
      workspaceId: f.workspaceId,
      conversationId: conversation.id,
      receipt: 'read',
      watermark: after,
    })
    expect(await statusNow()).toBe('read')

    // The late duplicate. It must change nothing.
    const touched = await applyReceipt(f.runtime.db, {
      workspaceId: f.workspaceId,
      conversationId: conversation.id,
      receipt: 'delivered',
      watermark: after,
    })
    expect(touched).toBe(0)
    expect(await statusNow()).toBe('read')
  })

  test('a receipt does not reach a message sent after its watermark', async () => {
    const provider = mock([{ kind: 'text', text: 'ok' }])
    const f = await fixture({ providerBaseUrl: provider.url })

    await customerSays(f, 'hello')
    await runQueuedWork(f)

    const conversation = await onlyConversation(f)
    const outbound = (await messagesOf(f, conversation.id)).filter(
      (m) => m.direction === 'outbound',
    )
    const first = outbound[0]
    if (!first) throw new Error('expected an outbound message')
    const before = first.createdAt.getTime() - 1000

    const touched = await applyReceipt(f.runtime.db, {
      workspaceId: f.workspaceId,
      conversationId: conversation.id,
      receipt: 'read',
      watermark: before,
    })

    expect(touched).toBe(0)
  })

  test('a customer message is never marked delivered by a receipt', async () => {
    // Receipts are about what we sent. Applying one to an inbound message would put a tick
    // on the customer's own words.
    const provider = mock([{ kind: 'text', text: 'ok' }])
    const f = await fixture({ providerBaseUrl: provider.url })

    await customerSays(f, 'hello')
    await runQueuedWork(f)

    const conversation = await onlyConversation(f)
    await applyReceipt(f.runtime.db, {
      workspaceId: f.workspaceId,
      conversationId: conversation.id,
      receipt: 'read',
      watermark: Date.now() + 60_000,
    })

    const inbound = (await messagesOf(f, conversation.id)).filter((m) => m.direction === 'inbound')
    expect(inbound.every((m) => m.status !== 'read')).toBe(true)
  })

  test('a receipt for an unknown customer opens no conversation', async () => {
    // Receipts arrive after a conversation is resolved, which is precisely when resolving
    // one the usual way would create a fresh, empty conversation. Seen in production on the
    // first day Messenger was connected.
    const provider = mock([{ kind: 'text', text: 'ok' }])
    const f = await fixture({ providerBaseUrl: provider.url })

    expect(
      await conversationForReceipt(f.runtime.db, {
        channelId: f.channelId,
        externalId: 'nobody-has-ever-written',
      }),
    ).toBeNull()

    const conversations = await f.runtime.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.workspaceId, f.workspaceId))
    expect(conversations).toHaveLength(0)
  })

  test('a receipt still reaches a conversation that has been resolved', async () => {
    const provider = mock([{ kind: 'text', text: 'ok' }])
    const f = await fixture({ providerBaseUrl: provider.url })

    await customerSays(f, 'hello')
    await runQueuedWork(f)

    const conversation = await onlyConversation(f)
    await updateConversation(f.runtime.db, f.workspaceId, conversation.id, { status: 'resolved' })

    const found = await conversationForReceipt(f.runtime.db, {
      channelId: f.channelId,
      externalId: 'sim-customer-1',
    })
    expect(found).toBe(conversation.id)

    const touched = await applyReceipt(f.runtime.db, {
      workspaceId: f.workspaceId,
      conversationId: found as string,
      receipt: 'read',
      watermark: Date.now() + 60_000,
    })
    expect(touched).toBeGreaterThan(0)
  })

  test('retention deletes what is past the period and keeps what is not', async () => {
    const provider = mock([{ kind: 'text', text: 'ok' }])
    const f = await fixture({ providerBaseUrl: provider.url })

    await customerSays(f, 'old', { externalId: 'sim-old' })
    await customerSays(f, 'recent', { externalId: 'sim-recent' })
    await runQueuedWork(f)

    const all = await f.runtime.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.workspaceId, f.workspaceId))
    expect(all).toHaveLength(2)

    // Age one of them by moving its last message into the past, which is what retention
    // measures: a long conversation is kept until it goes quiet, not from when it began.
    const old = all[0]
    if (!old) throw new Error('expected a conversation')
    const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000)
    await f.runtime.db
      .update(schema.conversations)
      .set({ lastMessageAt: longAgo })
      .where(eq(schema.conversations.id, old.id))

    const result = await runRetention(f.runtime.db, f.runtime.blob, {
      workspaceId: f.workspaceId,
      retentionDays: 365,
    })

    expect(result.conversations).toBe(1)
    const left = await f.runtime.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.workspaceId, f.workspaceId))
    expect(left).toHaveLength(1)
    expect(left[0]?.id).not.toBe(old.id)

    // The messages went with it, rather than being left pointing at nothing.
    const orphans = await messagesOf(f, old.id)
    expect(orphans).toHaveLength(0)
  })

  test('erasing a customer removes their conversations, identity and media', async () => {
    const provider = mock([{ kind: 'text', text: 'ok' }])
    const f = await fixture({ providerBaseUrl: provider.url })

    await customerSays(f, 'hello', { externalId: 'sim-erase-me' })
    await customerSays(f, 'hello', { externalId: 'sim-keep-me' })
    await runQueuedWork(f)

    // Give one message a stored attachment, so the media path is exercised rather than
    // assumed. Deleting rows is easy; the object store is where an erasure leaks.
    const key = `${f.workspaceId}/inbound/erase-test.png`
    await f.runtime.blob.put(key, new Uint8Array(new ArrayBuffer(4)), 'image/png')

    const [identity] = await f.runtime.db
      .select()
      .from(schema.channelIdentities)
      .where(eq(schema.channelIdentities.externalId, 'sim-erase-me'))
      .limit(1)
    if (!identity) throw new Error('expected an identity')

    const [conversation] = await f.runtime.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.channelIdentityId, identity.id))
      .limit(1)
    if (!conversation) throw new Error('expected a conversation')

    await storeMessage(f.runtime.db, {
      workspaceId: f.workspaceId,
      conversationId: conversation.id,
      direction: 'inbound',
      senderType: 'customer',
      message: {
        kind: 'image',
        text: null,
        attachments: [
          {
            storageKey: key,
            sourceUrl: null,
            mime: 'image/png',
            sizeBytes: 4,
            fileName: 'erase-test.png',
            width: null,
            height: null,
            durationMs: null,
          },
        ],
      },
      redaction: { cardNumbers: true, thaiNationalId: true },
    })

    const result = await eraseCustomer(f.runtime.db, f.runtime.blob, {
      workspaceId: f.workspaceId,
      customerId: identity.customerId as string,
      requestedByUserId: null,
    })

    expect(result.erased).toBe(true)
    expect(result.media).toBe(1)
    await expect(f.runtime.blob.get(key)).rejects.toThrow()

    // The identity goes too, or the next message from them would rebuild the customer.
    const identities = await f.runtime.db
      .select()
      .from(schema.channelIdentities)
      .where(eq(schema.channelIdentities.externalId, 'sim-erase-me'))
    expect(identities).toHaveLength(0)

    // And the other customer is untouched.
    const survivors = await f.runtime.db
      .select()
      .from(schema.channelIdentities)
      .where(eq(schema.channelIdentities.externalId, 'sim-keep-me'))
    expect(survivors).toHaveLength(1)
  })

  test('an erasure leaves an audit entry carrying no personal data', async () => {
    // The record that the request was honoured has to outlive the person, which is only
    // useful if it holds nothing you were asked to delete.
    const provider = mock([{ kind: 'text', text: 'ok' }])
    const f = await fixture({ providerBaseUrl: provider.url })

    await customerSays(f, 'สวัสดีค่ะ ฉันชื่อนก')
    await runQueuedWork(f)

    const conversation = await onlyConversation(f)
    await eraseCustomer(f.runtime.db, f.runtime.blob, {
      workspaceId: f.workspaceId,
      customerId: conversation.customerId,
      requestedByUserId: null,
    })

    const entries = await f.runtime.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.workspaceId, f.workspaceId))

    expect(entries).toHaveLength(1)
    expect(entries[0]?.action).toBe('customer.erased')
    expect(entries[0]?.targetId).toBe(conversation.customerId)
    expect(JSON.stringify(entries[0]?.meta)).not.toContain('นก')
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
    const send = () =>
      ingestInternal(f.runtime, f.runtime.db, {
        channelId: f.channelId,
        expectedType: 'test' as const,
        body,
      })

    const first = await send()
    const second = await send()

    expect(first.ok && first.duplicate).toBe(false)
    expect(second.ok && second.duplicate).toBe(true)

    await drainQueue(f, f.queues.inbound)
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

describe('grounded answers', () => {
  test('knowledge is retrieved and reaches the model before it answers', async () => {
    const provider = mock([{ kind: 'text', text: 'แพ็กเกจเริ่มต้น 990 บาทต่อเดือนค่ะ' }])
    const f = await fixture({
      providerBaseUrl: provider.url,
      embedBaseUrl: `${provider.url}/v1`,
    })

    // A knowledge entry the customer's question should pull in.
    const sourceId = await createSource(f.runtime.db, {
      workspaceId: f.workspaceId,
      kind: 'qa',
      title: 'Pricing',
    })
    const entryId = await createEntry(f.runtime.db, {
      workspaceId: f.workspaceId,
      sourceId,
      language: 'th',
      question: 'แพ็กเกจราคาเท่าไหร่',
      body: 'แพ็กเกจเริ่มต้นของ salon-saas ราคา 990 บาทต่อเดือน รวมการจองคิวออนไลน์',
    })
    await indexEntry(f.runtime.db, entryId, f.embedSlot())

    await customerSays(f, 'ราคาเท่าไหร่คะ')
    await runQueuedWork(f)

    // The chat request carried the knowledge, so the answer is grounded rather than guessed.
    const chatRequest = provider.requests.find((r) => {
      const body = r as { messages?: { role: string; content: unknown }[] }
      return body.messages?.some((m) => m.role === 'system')
    }) as { messages: { role: string; content: string }[] }
    const system = chatRequest.messages.find((m) => m.role === 'system')?.content ?? ''
    expect(system).toContain('990')
    expect(system).toContain('Knowledge base entries retrieved')

    // And the trace records what was retrieved, so the answer can be audited.
    const traces = await f.runtime.db
      .select()
      .from(schema.aiTraces)
      .where(eq(schema.aiTraces.workspaceId, f.workspaceId))
    const retrieved = traces[0]?.retrieved as { text: string }[] | null
    expect(retrieved?.length ?? 0).toBeGreaterThan(0)
    expect(JSON.stringify(retrieved)).toContain('990')
  })

  test('with no knowledge the model is told to hand off rather than guess', async () => {
    const provider = mock([{ kind: 'text', text: 'ok' }])
    const f = await fixture({
      providerBaseUrl: provider.url,
      embedBaseUrl: `${provider.url}/v1`,
    })

    await customerSays(f, 'มีโปรโมชั่นอะไรบ้างคะ')
    await runQueuedWork(f)

    const chatRequest = provider.requests.at(-1) as {
      messages: { role: string; content: string }[]
    }
    const system = chatRequest.messages.find((m) => m.role === 'system')?.content ?? ''
    expect(system).toContain('No knowledge base entries were retrieved')
  })
})

describe('customer memory', () => {
  test('resolving a conversation rewrites the summary and indexes it for recall', async () => {
    const provider = mock([
      { kind: 'text', text: 'ยินดีให้บริการค่ะ' },
      {
        kind: 'json',
        value: {
          summary: 'เจ้าของร้านทำผมในเชียงใหม่ สนใจแพ็กเกจเริ่มต้นและถามเรื่องการจองคิว',
          facts: { city: 'Chiang Mai', interest: 'starter plan' },
          openIssues: ['ยังไม่ได้ตัดสินใจสมัคร'],
        },
      },
    ])
    const f = await fixture({
      providerBaseUrl: provider.url,
      embedBaseUrl: `${provider.url}/v1`,
    })

    await customerSays(f, 'สนใจแพ็กเกจเริ่มต้น ร้านอยู่เชียงใหม่ค่ะ')
    await runQueuedWork(f)
    const conversation = await onlyConversation(f)

    // Resolving is what folds the conversation into the customer's memory.
    await humanAction(f, conversation.id, {
      type: 'set_status',
      at: new Date(),
      status: 'resolved',
    })

    const ports = createEffectPorts(f.runtime, f.runtime.logger)
    for (const job of await drainQueue<{
      workspaceId: string
      customerId: string
      conversationId: string
    }>(f, f.queues.summarize)) {
      await processSummarize(f.runtime, ports, f.runtime.logger, job)
    }

    const customers = await f.runtime.db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.workspaceId, f.workspaceId))

    expect(customers[0]?.summary).toContain('เชียงใหม่')
    expect(customers[0]?.summary).toContain('ยังไม่ได้ตัดสินใจสมัคร')
    /**
     * Into `notes`, not `fields`. A city is something the model noticed, not one of the
     * five identifiers merge matching compares, and mixing the two put a paragraph about
     * somebody's plan in the same list as their phone number.
     */
    expect(customers[0]?.notes).toMatchObject({ city: 'Chiang Mai' })
    expect(customers[0]?.fields).toEqual({})
    expect(customers[0]?.summaryUpdatedAt).not.toBeNull()

    // The history keeps what it said before, so a wrong summary can be traced.
    const history = await f.runtime.db
      .select()
      .from(schema.customerSummaries)
      .where(eq(schema.customerSummaries.workspaceId, f.workspaceId))
    expect(history).toHaveLength(1)

    // And the conversation is retrievable as this customer's own history.
    const indexed = await f.runtime.db
      .select()
      .from(schema.conversationEmbeddings)
      .where(eq(schema.conversationEmbeddings.workspaceId, f.workspaceId))
    expect(indexed.length).toBeGreaterThan(0)
    expect(indexed[0]?.customerId).toBe(customers[0]?.id)
  })

  test('a failed summary leaves the previous one intact', async () => {
    const provider = mock([
      { kind: 'text', text: 'ok' },
      { kind: 'error', status: 500, message: 'summariser down' },
    ])
    const f = await fixture({ providerBaseUrl: provider.url })

    await customerSays(f, 'hello')
    await runQueuedWork(f)
    const conversation = await onlyConversation(f)

    await f.runtime.db
      .update(schema.customers)
      .set({ summary: 'An earlier summary worth keeping.' })
      .where(eq(schema.customers.workspaceId, f.workspaceId))

    await humanAction(f, conversation.id, {
      type: 'set_status',
      at: new Date(),
      status: 'resolved',
    })

    const ports = createEffectPorts(f.runtime, f.runtime.logger)
    for (const job of await drainQueue<{
      workspaceId: string
      customerId: string
      conversationId: string
    }>(f, f.queues.summarize)) {
      await processSummarize(f.runtime, ports, f.runtime.logger, job)
    }

    const customers = await f.runtime.db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.workspaceId, f.workspaceId))
    expect(customers[0]?.summary).toBe('An earlier summary worth keeping.')

    // The failure is still recorded, so it is visible rather than silent.
    const traces = await f.runtime.db
      .select()
      .from(schema.aiTraces)
      .where(eq(schema.aiTraces.workspaceId, f.workspaceId))
    expect(traces.some((t) => t.task === 'summarize' && t.outcome === 'error')).toBe(true)
  })
})

describe('the waiting-human fallback timer', () => {
  test('a handoff schedules the timer when the workspace configures one', async () => {
    // This path was never exercised before: the default fixture disables the timer, so a
    // job id BullMQ rejected went unnoticed until a workspace turned the feature on.
    const provider = mock([
      {
        kind: 'tool_calls',
        toolCalls: [
          { name: 'handoff_to_human', arguments: { reason: 'low_confidence', note: 'unsure' } },
        ],
      },
      { kind: 'text', text: 'ขอโอนสายนะคะ' },
    ])
    const f = await fixture({
      providerBaseUrl: provider.url,
      settings: { waitingHumanFallbackMinutes: 15 },
    })

    await customerSays(f, 'คำถามยากค่ะ')
    await runQueuedWork(f)

    const conversation = await onlyConversation(f)
    expect(conversation.mode).toBe('waiting_human')

    await relay(f)
    const scheduled = await f.queues.waiting_human.getJob(waitingHumanJobId(conversation.id))
    expect(scheduled).toBeTruthy()
    expect(scheduled?.data).toMatchObject({ conversationId: conversation.id })
  })

  test('taking over cancels the timer so the customer is not interrupted', async () => {
    const provider = mock([
      {
        kind: 'tool_calls',
        toolCalls: [
          { name: 'handoff_to_human', arguments: { reason: 'low_confidence', note: 'unsure' } },
        ],
      },
      { kind: 'text', text: 'ขอโอนสายนะคะ' },
    ])
    const f = await fixture({
      providerBaseUrl: provider.url,
      settings: { waitingHumanFallbackMinutes: 15 },
    })

    await customerSays(f, 'คำถามยากค่ะ')
    await runQueuedWork(f)
    const conversation = await onlyConversation(f)

    await humanAction(f, conversation.id, {
      type: 'human_take_over',
      at: new Date(),
      userId: f.userId,
    })

    // The cancellation is a promise like any other, so it reaches BullMQ the same way.
    await relay(f)
    const scheduled = await f.queues.waiting_human.getJob(waitingHumanJobId(conversation.id))
    expect(scheduled).toBeUndefined()
  })

  test('the timer acknowledges the customer when nobody has picked up', async () => {
    const provider = mock([{ kind: 'text', text: 'ok' }])
    const f = await fixture({
      providerBaseUrl: provider.url,
      settings: { waitingHumanFallbackMinutes: 1 },
    })

    await customerSays(f, 'question')
    await runQueuedWork(f)
    const conversation = await onlyConversation(f)

    await humanAction(f, conversation.id, {
      type: 'set_mode',
      at: new Date(),
      mode: 'waiting_human',
    })

    const ports = createEffectPorts(f.runtime, f.runtime.logger)
    await processWaitingHumanTimeout(f.runtime, ports, f.runtime.logger, {
      workspaceId: f.workspaceId,
      conversationId: conversation.id,
    })

    const messages = await messagesOf(f, conversation.id)
    const ack = messages.find((m) => m.senderType === 'system')
    // The apology, not the handoff sentence: this customer has been waiting a while and
    // being told a second time that somebody is coming reads like nobody is.
    expect(ack?.text).toBe('ขออภัยที่ให้รอค่ะ')
  })
})

/**
 * Closing conversations the customer stopped replying to.
 *
 * The rule, in the order these tests take it: the AI is answering, our side spoke last,
 * and the customer has been quiet for the workspace's hours. Everything else stays open,
 * because in every other case somebody is still owed something.
 */
describe('closing a conversation the customer walked away from', () => {
  const HOURS = 24
  /** A moment comfortably past the cutoff, so nothing here has to wait a day. */
  const later = () => new Date(Date.now() + (HOURS + 1) * 60 * 60 * 1000)

  async function answeredByAi(f: Fixture) {
    await customerSays(f, 'ราคาเท่าไหร่คะ')
    await runQueuedWork(f)
    return onlyConversation(f)
  }

  const statusOf = async (f: Fixture, id: string) => {
    const rows = await f.runtime.db
      .select({ status: schema.conversations.status })
      .from(schema.conversations)
      .where(eq(schema.conversations.id, id))
    return rows[0]?.status
  }

  test('an AI conversation the customer went quiet on is resolved, and remembered', async () => {
    const f = await fixture({
      providerBaseUrl: mock([{ kind: 'text', text: 'เริ่มต้นที่ 99 บาทค่ะ' }]).url,
    })
    const conversation = await answeredByAi(f)

    const result = await resolveIdleConversations(f.runtime, f.runtime.logger, {
      workspaceId: f.workspaceId,
      hours: HOURS,
      now: later(),
    })

    expect(result.resolved).toBe(1)
    expect(await statusOf(f, conversation.id)).toBe('resolved')

    // Said in the thread, so nobody mistakes it for a conversation a person closed.
    const notes = await f.runtime.db
      .select({ body: schema.internalNotes.body })
      .from(schema.internalNotes)
      .where(eq(schema.internalNotes.conversationId, conversation.id))
    expect(notes.some((note) => note.body.includes('Resolved automatically'))).toBe(true)

    // The reason this exists at all: resolving is what asks for the summary.
    await relay(f)
    expect(await f.queues.summarize.getJob(`summary-${conversation.id}`)).toBeTruthy()
  })

  test('nothing is closed before the customer has been quiet long enough', async () => {
    const f = await fixture({ providerBaseUrl: mock([{ kind: 'text', text: 'ok' }]).url })
    const conversation = await answeredByAi(f)

    const result = await resolveIdleConversations(f.runtime, f.runtime.logger, {
      workspaceId: f.workspaceId,
      hours: HOURS,
    })
    expect(result.resolved).toBe(0)
    expect(await statusOf(f, conversation.id)).toBe('open')
  })

  test('a customer who spoke last is the one waiting, and is left open', async () => {
    const f = await fixture({ providerBaseUrl: mock([{ kind: 'text', text: 'ok' }]).url })
    const conversation = await answeredByAi(f)
    // The customer writes, and nothing has answered them yet.
    await storeMessage(f.runtime.db, {
      workspaceId: f.workspaceId,
      conversationId: conversation.id,
      direction: 'inbound',
      senderType: 'customer',
      message: { kind: 'text', text: 'แล้วรายปีล่ะคะ' },
      redaction: { cardNumbers: true, thaiNationalId: true },
    })

    await resolveIdleConversations(f.runtime, f.runtime.logger, {
      workspaceId: f.workspaceId,
      hours: HOURS,
      now: later(),
    })
    expect(await statusOf(f, conversation.id)).toBe('open')
  })

  test('a conversation waiting for a person is never closed on its own', async () => {
    const f = await fixture({ providerBaseUrl: mock([{ kind: 'text', text: 'ok' }]).url })
    const conversation = await answeredByAi(f)
    await humanAction(f, conversation.id, {
      type: 'ai_handoff',
      at: new Date(),
      reason: 'customer_requested',
      note: null,
    })

    await resolveIdleConversations(f.runtime, f.runtime.logger, {
      workspaceId: f.workspaceId,
      hours: HOURS,
      now: later(),
    })
    expect(await statusOf(f, conversation.id)).toBe('open')
  })

  test('a conversation a colleague owns is theirs to close', async () => {
    const f = await fixture({ providerBaseUrl: mock([{ kind: 'text', text: 'ok' }]).url })
    const conversation = await answeredByAi(f)
    await humanAction(f, conversation.id, {
      type: 'human_take_over',
      at: new Date(),
      userId: f.userId,
    })

    await resolveIdleConversations(f.runtime, f.runtime.logger, {
      workspaceId: f.workspaceId,
      hours: HOURS,
      now: later(),
    })
    expect(await statusOf(f, conversation.id)).toBe('open')
  })

  test('one a colleague answered and handed back to the AI does qualify', async () => {
    // The common hand-back: the colleague replies, returns it to the AI, and the AI says
    // nothing more because nobody wrote. Their reply is the last message, and it counts.
    const f = await fixture({ providerBaseUrl: mock([{ kind: 'text', text: 'ok' }]).url })
    const conversation = await answeredByAi(f)
    await humanAction(f, conversation.id, {
      type: 'human_take_over',
      at: new Date(),
      userId: f.userId,
    })
    await storeMessage(f.runtime.db, {
      workspaceId: f.workspaceId,
      conversationId: conversation.id,
      direction: 'outbound',
      senderType: 'human',
      senderUserId: f.userId,
      message: { kind: 'text', text: 'เรียบร้อยแล้วครับ' },
      redaction: { cardNumbers: true, thaiNationalId: true },
    })
    await humanAction(f, conversation.id, {
      type: 'human_return_to_ai',
      at: new Date(),
      note: null,
    })

    const result = await resolveIdleConversations(f.runtime, f.runtime.logger, {
      workspaceId: f.workspaceId,
      hours: HOURS,
      now: later(),
    })
    expect(result.resolved).toBe(1)
    expect(await statusOf(f, conversation.id)).toBe('resolved')
  })

  test('a supervised conversation qualifies as well', async () => {
    // A person approves each reply, so what went out last is a colleague's message. Leaving
    // these out meant a supervised workspace never had a customer summarised.
    const f = await fixture({ providerBaseUrl: mock([{ kind: 'text', text: 'ok' }]).url })
    const conversation = await answeredByAi(f)
    await f.runtime.db
      .update(schema.conversations)
      .set({ mode: 'ai_supervised' })
      .where(eq(schema.conversations.id, conversation.id))
    await storeMessage(f.runtime.db, {
      workspaceId: f.workspaceId,
      conversationId: conversation.id,
      direction: 'outbound',
      senderType: 'human',
      senderUserId: f.userId,
      message: { kind: 'text', text: 'ร่างที่อนุมัติแล้วค่ะ' },
      redaction: { cardNumbers: true, thaiNationalId: true },
    })

    const result = await resolveIdleConversations(f.runtime, f.runtime.logger, {
      workspaceId: f.workspaceId,
      hours: HOURS,
      now: later(),
    })
    expect(result.resolved).toBe(1)
    expect(await statusOf(f, conversation.id)).toBe('resolved')
  })

  test('a customer told a person is coming is not closed because nobody came', async () => {
    // The last thing they read is the acknowledgement. Handing back to the AI without a
    // word leaves that promise standing, so the conversation stays open.
    const f = await fixture({ providerBaseUrl: mock([{ kind: 'text', text: 'ok' }]).url })
    const conversation = await answeredByAi(f)
    await storeMessage(f.runtime.db, {
      workspaceId: f.workspaceId,
      conversationId: conversation.id,
      direction: 'outbound',
      senderType: 'system',
      message: { kind: 'text', text: 'รอสักครู่นะคะ' },
      redaction: { cardNumbers: true, thaiNationalId: true },
    })

    await resolveIdleConversations(f.runtime, f.runtime.logger, {
      workspaceId: f.workspaceId,
      hours: HOURS,
      now: later(),
    })
    expect(await statusOf(f, conversation.id)).toBe('open')
  })

  test('another workspace is left alone', async () => {
    const f = await fixture({ providerBaseUrl: mock([{ kind: 'text', text: 'ok' }]).url })
    const conversation = await answeredByAi(f)
    const other = await fixture({ providerBaseUrl: mock([{ kind: 'text', text: 'ok' }]).url })

    await resolveIdleConversations(other.runtime, other.runtime.logger, {
      workspaceId: other.workspaceId,
      hours: HOURS,
      now: later(),
    })
    expect(await statusOf(f, conversation.id)).toBe('open')
  })

  test('switched off, the processor closes nothing', async () => {
    const f = await fixture({
      providerBaseUrl: mock([{ kind: 'text', text: 'ok' }]).url,
      settings: { autoResolveAfterHours: null },
    })
    const conversation = await answeredByAi(f)
    // Backdate our reply, so the only thing standing between it and a close is the setting.
    await f.runtime.db
      .update(schema.messages)
      // Shifted rather than set, so the order the messages were written in survives.
      .set({ createdAt: sql`${schema.messages.createdAt} - interval '48 hours'` })
      .where(eq(schema.messages.conversationId, conversation.id))

    await processIdleResolve(
      f.runtime,
      createEffectPorts(f.runtime, f.runtime.logger),
      f.runtime.logger,
      {
        workspaceId: f.workspaceId,
      },
    )
    expect(await statusOf(f, conversation.id)).toBe('open')
  })

  test('switched on, the processor closes what qualifies', async () => {
    const f = await fixture({
      providerBaseUrl: mock([{ kind: 'text', text: 'ok' }]).url,
      settings: { autoResolveAfterHours: HOURS },
    })
    const conversation = await answeredByAi(f)
    await f.runtime.db
      .update(schema.messages)
      // Shifted rather than set, so the order the messages were written in survives.
      .set({ createdAt: sql`${schema.messages.createdAt} - interval '48 hours'` })
      .where(eq(schema.messages.conversationId, conversation.id))

    await processIdleResolve(
      f.runtime,
      createEffectPorts(f.runtime, f.runtime.logger),
      f.runtime.logger,
      {
        workspaceId: f.workspaceId,
      },
    )
    expect(await statusOf(f, conversation.id)).toBe('resolved')
  })

  test('a customer who writes again finds the conversation open again', async () => {
    const f = await fixture({
      providerBaseUrl: mock([
        { kind: 'text', text: 'ok' },
        { kind: 'text', text: 'ok' },
      ]).url,
    })
    const conversation = await answeredByAi(f)
    await resolveIdleConversations(f.runtime, f.runtime.logger, {
      workspaceId: f.workspaceId,
      hours: HOURS,
      now: later(),
    })
    expect(await statusOf(f, conversation.id)).toBe('resolved')

    await customerSays(f, 'กลับมาถามอีกครั้งค่ะ')
    await runQueuedWork(f)
    expect(await statusOf(f, conversation.id)).toBe('open')
  })
})

describe('LINE reply tokens', () => {
  const LINE_SECRET = 'line-channel-secret'
  const LINE_USER = 'U0123456789abcdef0123456789abcdef'

  /** Deliver a signed LINE webhook the way the platform would. */
  async function lineSays(f: Fixture, text: string, replyToken: string) {
    const body = JSON.stringify({
      destination: 'U99999999999999999999999999999999',
      events: [
        {
          type: 'message',
          mode: 'active',
          timestamp: Date.now(),
          webhookEventId: `01TEST${crypto.randomUUID()}`,
          deliveryContext: { isRedelivery: false },
          source: { type: 'user', userId: LINE_USER },
          replyToken,
          message: { type: 'text', id: String(Date.now()), text, quoteToken: 'q' },
        },
      ],
    })

    const outcome = await ingestWebhook(f.runtime, f.runtime.db, f.lineChannelId as string, {
      rawBody: body,
      headers: { 'x-line-signature': await signBodyBase64(body, LINE_SECRET) },
      query: {},
    })
    if (!outcome.ok) throw new Error(`ingest failed: ${outcome.reason}`)

    await drainQueue(f, f.queues.inbound)
    await processInbound(
      f.runtime,
      createEffectPorts(f.runtime, f.runtime.logger),
      f.runtime.logger,
      {
        workspaceId: f.workspaceId,
        channelId: f.lineChannelId as string,
        inboundEventId: outcome.inboundEventId,
      },
    )
  }

  async function lineConversation(f: Fixture) {
    const rows = await f.runtime.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.channelId, f.lineChannelId as string))
      .limit(1)
    const row = rows[0]
    if (!row) throw new Error('no LINE conversation')
    return row
  }

  test('a signed webhook creates a conversation and stores the reply token', async () => {
    const provider = mock([{ kind: 'text', text: 'ok' }])
    const f = await fixture({
      providerBaseUrl: provider.url,
      lineChannel: { channelSecret: LINE_SECRET, channelAccessToken: 'bad-token' },
    })

    await lineSays(f, 'ราคาเท่าไหร่คะ', 'reply-token-fresh')

    const conversation = await lineConversation(f)
    expect(conversation.replyToken).toBe('reply-token-fresh')
    expect(conversation.replyTokenExpiresAt).not.toBeNull()
    // Stored with a conservative expiry, well under LINE's stated minute.
    const ttl = (conversation.replyTokenExpiresAt as Date).getTime() - Date.now()
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(60_000)

    const messages = await messagesOf(f, conversation.id)
    expect(messages[0]?.text).toBe('ราคาเท่าไหร่คะ')
  })

  test('a rejected webhook signature creates nothing at all', async () => {
    const provider = mock([{ kind: 'text', text: 'ok' }])
    const f = await fixture({
      providerBaseUrl: provider.url,
      lineChannel: { channelSecret: LINE_SECRET, channelAccessToken: 'bad-token' },
    })

    const body = JSON.stringify({ destination: 'U9', events: [] })
    const outcome = await ingestWebhook(f.runtime, f.runtime.db, f.lineChannelId as string, {
      rawBody: body,
      headers: { 'x-line-signature': await signBodyBase64(body, 'the-wrong-secret') },
      query: {},
    })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('invalid_signature')

    const events = await f.runtime.db
      .select()
      .from(schema.inboundEvents)
      .where(eq(schema.inboundEvents.workspaceId, f.workspaceId))
    expect(events).toHaveLength(0)
  })

  test('the token is cleared even when the send fails, so a retry cannot reuse it', async () => {
    // This is the bug the clearing order guards against: a reply token is spent the moment
    // it is presented, so clearing it only on success would leave the retry to present a
    // token LINE has already rejected.
    const provider = mock([{ kind: 'text', text: 'แพ็กเกจเริ่มต้น 990 บาทค่ะ' }])
    const f = await fixture({
      providerBaseUrl: provider.url,
      lineChannel: { channelSecret: LINE_SECRET, channelAccessToken: 'bad-token' },
    })

    await lineSays(f, 'ราคาเท่าไหร่คะ', 'reply-token-doomed')
    const conversation = await lineConversation(f)
    expect(conversation.replyToken).toBe('reply-token-doomed')

    const ports = createEffectPorts(f.runtime, f.runtime.logger)
    for (const job of await drainQueue<{
      workspaceId: string
      conversationId: string
      deliver: 'send' | 'draft'
    }>(f, f.queues.ai_turn)) {
      await processAiTurn(f.runtime, ports, f.runtime.logger, job)
    }

    // The send will fail: the access token is not a real one.
    for (const job of await drainQueue<{
      workspaceId: string
      conversationId: string
      messageId: string
    }>(f, f.queues.outbound)) {
      await processOutbound(f.runtime, ports, f.runtime.logger, job).catch(() => {})
    }

    const after = await lineConversation(f)
    expect(after.replyToken).toBeNull()
    expect(after.replyTokenExpiresAt).toBeNull()

    // And the failure is recorded on the message rather than lost.
    const messages = await messagesOf(f, conversation.id)
    const aiMessage = messages.find((m) => m.senderType === 'ai')
    expect(aiMessage?.status).toBe('failed')
    expect(aiMessage?.error).toBeTruthy()
  })

  test('an expired token is not presented at all', async () => {
    const provider = mock([{ kind: 'text', text: 'ตอบกลับค่ะ' }])
    const f = await fixture({
      providerBaseUrl: provider.url,
      lineChannel: { channelSecret: LINE_SECRET, channelAccessToken: 'bad-token' },
    })

    await lineSays(f, 'คำถามค่ะ', 'reply-token-stale')
    const conversation = await lineConversation(f)

    // Age the token past its expiry, as a slow queue would.
    await f.runtime.db
      .update(schema.conversations)
      .set({ replyTokenExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.conversations.id, conversation.id))

    const ports = createEffectPorts(f.runtime, f.runtime.logger)
    for (const job of await drainQueue<{
      workspaceId: string
      conversationId: string
      deliver: 'send' | 'draft'
    }>(f, f.queues.ai_turn)) {
      await processAiTurn(f.runtime, ports, f.runtime.logger, job)
    }
    for (const job of await drainQueue<{
      workspaceId: string
      conversationId: string
      messageId: string
    }>(f, f.queues.outbound)) {
      await processOutbound(f.runtime, ports, f.runtime.logger, job).catch(() => {})
    }

    // Left in place rather than cleared: it was never presented, and it is already useless.
    const after = await lineConversation(f)
    expect(after.replyToken).toBe('reply-token-stale')
  })
})

/**
 * The review queue, driven by the real loop.
 *
 * The infra tests prove the predicate against hand-written rows. These prove the rows the
 * product actually writes land on the right side of it: an AI that answered alone is
 * queued, a conversation a person touched never is, and reviewing is only good until the
 * AI speaks again.
 */
describe('the review queue', () => {
  test('an AI answer with nobody watching is queued, and reviewing clears it', async () => {
    const provider = mock([{ kind: 'text', text: 'คำตอบแรกค่ะ' }])
    const f = await fixture({ providerBaseUrl: provider.url })

    await customerSays(f, 'คำถามแรก')
    await runQueuedWork(f)
    const conversation = await onlyConversation(f)

    expect(await countReviewQueue(f.runtime.db, f.workspaceId)).toBe(1)

    const reviewedAt = await markReviewed(f.runtime.db, f.workspaceId, conversation.id, f.userId)
    expect(reviewedAt).not.toBeNull()
    expect(await countReviewQueue(f.runtime.db, f.workspaceId)).toBe(0)
  })

  test('rating the AI’s reply is itself a review', async () => {
    const provider = mock([{ kind: 'text', text: 'คำตอบที่ผิดค่ะ' }])
    const f = await fixture({ providerBaseUrl: provider.url })

    await customerSays(f, 'คำถาม')
    await runQueuedWork(f)
    const conversation = await onlyConversation(f)
    const aiMessage = (await messagesOf(f, conversation.id)).find((m) => m.senderType === 'ai')

    const row = await upsertFeedback(f.runtime.db, {
      workspaceId: f.workspaceId,
      conversationId: conversation.id,
      targetType: 'message',
      targetId: aiMessage?.id ?? '',
      userId: f.userId,
      rating: 'down',
      reason: 'missing_knowledge',
    })
    expect(row).not.toBeNull()

    await markReviewed(f.runtime.db, f.workspaceId, conversation.id, f.userId)
    expect(await countReviewQueue(f.runtime.db, f.workspaceId)).toBe(0)
  })

  test('the AI answering again after a review puts it back', async () => {
    const provider = mock([
      { kind: 'text', text: 'คำตอบแรกค่ะ' },
      { kind: 'text', text: 'คำตอบที่สองค่ะ' },
    ])
    const f = await fixture({ providerBaseUrl: provider.url })

    await customerSays(f, 'คำถามแรก')
    await runQueuedWork(f)
    const conversation = await onlyConversation(f)
    await markReviewed(f.runtime.db, f.workspaceId, conversation.id, f.userId)
    expect(await countReviewQueue(f.runtime.db, f.workspaceId)).toBe(0)

    await customerSays(f, 'คำถามที่สอง', { eventId: 'evt-second' })
    await runQueuedWork(f)

    expect(await countReviewQueue(f.runtime.db, f.workspaceId)).toBe(1)
  })

  test('a conversation a person answered in is never queued', async () => {
    const provider = mock([{ kind: 'text', text: 'คำตอบค่ะ' }])
    const f = await fixture({ providerBaseUrl: provider.url })

    await customerSays(f, 'คำถาม')
    await runQueuedWork(f)
    const conversation = await onlyConversation(f)

    await humanAction(f, conversation.id, {
      type: 'human_take_over',
      at: new Date(),
      userId: f.userId,
    })
    const settings = await loadWorkspaceSettings(f.runtime.db, f.workspaceId)
    await storeMessage(f.runtime.db, {
      workspaceId: f.workspaceId,
      conversationId: conversation.id,
      direction: 'outbound',
      senderType: 'human',
      senderUserId: f.userId,
      message: { kind: 'text', text: 'ขอโทษค่ะ เดี๋ยวช่วยดูให้' },
      status: 'sent',
      redaction: settings.redaction,
    })

    expect(await countReviewQueue(f.runtime.db, f.workspaceId)).toBe(0)
  })

  test('a draft an agent sent is linked to the message it became', async () => {
    const provider = mock([
      { kind: 'text', text: 'ข้อความแรก' },
      { kind: 'text', text: 'ร่างคำตอบ' },
    ])
    const f = await fixture({ providerBaseUrl: provider.url })

    await customerSays(f, 'คำถามแรก')
    await runQueuedWork(f)
    const conversation = await onlyConversation(f)

    await humanAction(f, conversation.id, {
      type: 'human_take_over',
      at: new Date(),
      userId: f.userId,
    })
    await customerSays(f, 'คำถามที่สอง', { eventId: 'evt-draft' })
    await runQueuedWork(f)

    const suggestions = await f.runtime.db
      .select()
      .from(schema.suggestions)
      .where(eq(schema.suggestions.conversationId, conversation.id))
    const suggestion = suggestions[0]
    expect(suggestion).toBeDefined()

    // The agent edited the draft before sending it, which is the interesting case.
    const settings = await loadWorkspaceSettings(f.runtime.db, f.workspaceId)
    const sent = await storeMessage(f.runtime.db, {
      workspaceId: f.workspaceId,
      conversationId: conversation.id,
      direction: 'outbound',
      senderType: 'human',
      senderUserId: f.userId,
      message: { kind: 'text', text: `${suggestion?.messageText ?? ''} เพิ่มเติมนิดหนึ่งค่ะ` },
      status: 'sent',
      redaction: settings.redaction,
    })

    expect(
      await markSuggestionSent(
        f.runtime.db,
        f.workspaceId,
        conversation.id,
        suggestion?.id ?? '',
        sent.id,
      ),
    ).toBe(true)

    const [after] = await f.runtime.db
      .select()
      .from(schema.suggestions)
      .where(eq(schema.suggestions.id, suggestion?.id ?? ''))
    expect(after?.status).toBe('sent')
    expect(after?.sentMessageId).toBe(sent.id)
    // Comparing the two texts is what says the agent rewrote it; no column records that.
    expect(after?.messageText).not.toBe(sent.text)
  })

  test('another workspace cannot mark this one’s draft sent', async () => {
    const provider = mock([{ kind: 'text', text: 'คำตอบค่ะ' }])
    const mine = await fixture({ providerBaseUrl: provider.url })
    const theirs = await fixture({ providerBaseUrl: provider.url })

    await customerSays(mine, 'คำถาม')
    await runQueuedWork(mine)
    const conversation = await onlyConversation(mine)
    const suggestionId = newId()
    await mine.runtime.db.insert(schema.suggestions).values({
      id: suggestionId,
      workspaceId: mine.workspaceId,
      conversationId: conversation.id,
      messageText: 'a draft',
    })

    expect(
      await markSuggestionSent(
        theirs.runtime.db,
        theirs.workspaceId,
        conversation.id,
        suggestionId,
        newId(),
      ),
    ).toBe(false)
  })
})

/**
 * Merge suggestions arising from the real loop.
 *
 * The infra tests prove the matching and the merge itself against hand-written rows. These
 * prove the part only the running product can show: that a customer volunteering their
 * phone number on a second channel is noticed, proposed, and never acted on by itself.
 */
describe('merge suggestions', () => {
  /**
   * A reply script for two turns, each recording a phone number.
   *
   * Each turn costs the mock two replies: the tool call, then the answer written once the
   * tool has returned. The server repeats its last reply forever, so a script that is too
   * short silently turns the second turn into a plain answer that records nothing.
   */
  const givesPhones = (first: string, second: string): Parameters<typeof mock>[0] => [
    {
      kind: 'tool_calls',
      toolCalls: [{ name: 'set_customer_field', arguments: { key: 'phone', value: first } }],
    },
    { kind: 'text', text: 'รับทราบค่ะ' },
    {
      kind: 'tool_calls',
      toolCalls: [{ name: 'set_customer_field', arguments: { key: 'phone', value: second } }],
    },
    { kind: 'text', text: 'รับทราบค่ะ' },
  ]

  test('the same number from two identities is proposed, not merged', async () => {
    // Written two ways on two channels, as the same person naturally would.
    const provider = mock(givesPhones('081-234-5678', '+66812345678'))
    const f = await fixture({ providerBaseUrl: provider.url })

    await customerSays(f, 'เบอร์ผมคือ 081-234-5678', { externalId: 'person-line' })
    await runQueuedWork(f)

    await customerSays(f, 'เบอร์เดิมนะคะ +66812345678', {
      externalId: 'person-widget',
      eventId: 'evt-second-channel',
    })
    await runQueuedWork(f)

    const customers = await f.runtime.db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.workspaceId, f.workspaceId))
    // Still two people as far as the database is concerned. Nothing merged itself.
    expect(customers).toHaveLength(2)

    expect(await countPendingMerges(f.runtime.db, f.workspaceId)).toBe(1)
  })

  test('accepting one joins the two histories under the older record', async () => {
    const provider = mock(givesPhones('0812345678', '0812345678'))
    const f = await fixture({ providerBaseUrl: provider.url })

    await customerSays(f, 'เบอร์ 0812345678', { externalId: 'person-line' })
    await runQueuedWork(f)
    await customerSays(f, 'เบอร์ 0812345678', {
      externalId: 'person-widget',
      eventId: 'evt-other',
    })
    await runQueuedWork(f)

    const before = await f.runtime.db
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(eq(schema.conversations.workspaceId, f.workspaceId))
    expect(before).toHaveLength(2)

    const customers = await f.runtime.db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.workspaceId, f.workspaceId))
    const older = customers.map((c) => c.id).sort()[0] ?? ''
    const [suggestion] = await listMergeSuggestions(f.runtime.db, f.workspaceId, older)
    expect(suggestion).toBeDefined()

    const merged = await acceptMergeSuggestion(
      f.runtime.db,
      f.workspaceId,
      suggestion?.id ?? '',
      f.userId,
    )
    expect(merged?.survivorId).toBe(older)

    // Both conversations survive, now belonging to one person on two channels.
    const after = await f.runtime.db
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(eq(schema.conversations.customerId, older))
    expect(after).toHaveLength(2)

    const identities = await f.runtime.db
      .select({ id: schema.channelIdentities.id })
      .from(schema.channelIdentities)
      .where(eq(schema.channelIdentities.customerId, older))
    expect(identities).toHaveLength(2)
  })

  test('repeating a number we already hold proposes nothing new', async () => {
    const provider = mock(givesPhones('0812345678', '0812345678'))
    const f = await fixture({ providerBaseUrl: provider.url })

    await customerSays(f, 'เบอร์ 0812345678', { externalId: 'person-line' })
    await runQueuedWork(f)
    // The same identity, so the same customer: nothing to merge with.
    await customerSays(f, 'เบอร์เดิม 0812345678', {
      externalId: 'person-line',
      eventId: 'evt-again',
    })
    await runQueuedWork(f)

    expect(await countPendingMerges(f.runtime.db, f.workspaceId)).toBe(0)
  })
})

/**
 * Handoffs, recorded as history rather than as current state.
 *
 * `conversations.handoff_reason` says why a conversation is waiting right now, and is
 * cleared the moment somebody hands it back. That is right for the inbox and useless for
 * reporting: the dashboard's list of what the AI could not handle emptied itself as agents
 * worked through their queue. These pin the log that replaced it.
 */
describe('the handoff log', () => {
  const handoffs = async (f: Fixture) =>
    f.runtime.db
      .select()
      .from(schema.handoffEvents)
      .where(eq(schema.handoffEvents.workspaceId, f.workspaceId))

  test('the reason outlives the conversation going back to the AI', async () => {
    const provider = mock([
      {
        kind: 'tool_calls',
        toolCalls: [
          {
            name: 'handoff_to_human',
            arguments: { reason: 'customer_requested', note: 'Asked for a person.' },
          },
        ],
      },
      { kind: 'text', text: 'ขอโอนสายนะคะ' },
    ])
    const f = await fixture({ providerBaseUrl: provider.url })

    await customerSays(f, 'ขอคุยกับเจ้าหน้าที่')
    await runQueuedWork(f)
    const conversation = await onlyConversation(f)

    const recorded = await handoffs(f)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.reason).toBe('customer_requested')

    // An agent picks it up and hands it back, which clears the column on the conversation.
    await humanAction(f, conversation.id, {
      type: 'human_take_over',
      at: new Date(),
      userId: f.userId,
    })
    await humanAction(f, conversation.id, {
      type: 'human_return_to_ai',
      at: new Date(),
      note: null,
    })

    const after = await onlyConversation(f)
    expect(after.handoffReason).toBeNull()
    // The history does not care.
    expect(await handoffs(f)).toHaveLength(1)
  })

  test('replaying the same handoff records it once', async () => {
    const f = await fixture({ providerBaseUrl: mock([{ kind: 'text', text: 'hi' }]).url })
    await customerSays(f, 'สวัสดี')
    await runQueuedWork(f)
    const conversation = await onlyConversation(f)

    // The instant travels with the effect, so a retried job writes the row it already wrote.
    const at = new Date()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await humanAction(f, conversation.id, {
        type: 'ai_handoff',
        at,
        reason: 'low_confidence',
        note: null,
      })
      // The second pass is ignored by the state machine once the mode has moved, so drive
      // the effect directly, which is what a queue retry replays.
      await applyEffects(
        [{ type: 'record_handoff', reason: 'low_confidence', at }],
        { workspaceId: f.workspaceId, conversationId: conversation.id },
        createEffectPorts(f.runtime, f.runtime.logger),
        f.runtime.logger,
      )
    }

    expect(await handoffs(f)).toHaveLength(1)
  })

  test('a second, genuinely later handoff is counted again', async () => {
    const f = await fixture({ providerBaseUrl: mock([{ kind: 'text', text: 'hi' }]).url })
    await customerSays(f, 'สวัสดี')
    await runQueuedWork(f)
    const conversation = await onlyConversation(f)
    const ports = createEffectPorts(f.runtime, f.runtime.logger)
    const ctx = { workspaceId: f.workspaceId, conversationId: conversation.id }

    await applyEffects(
      [{ type: 'record_handoff', reason: 'low_confidence', at: new Date('2026-09-01T10:00:00Z') }],
      ctx,
      ports,
      f.runtime.logger,
    )
    await applyEffects(
      [{ type: 'record_handoff', reason: 'tool_error', at: new Date('2026-09-02T10:00:00Z') }],
      ctx,
      ports,
      f.runtime.logger,
    )

    expect(await handoffs(f)).toHaveLength(2)
  })

  test('the dashboard reports a handoff an agent has already dealt with', async () => {
    const provider = mock([
      {
        kind: 'tool_calls',
        toolCalls: [
          {
            name: 'handoff_to_human',
            arguments: { reason: 'low_confidence', note: 'Not covered by the knowledge base.' },
          },
        ],
      },
      { kind: 'text', text: 'ขอโอนสายนะคะ' },
    ])
    const f = await fixture({ providerBaseUrl: provider.url })

    await customerSays(f, 'คำถามยากค่ะ')
    await runQueuedWork(f)
    const conversation = await onlyConversation(f)
    await humanAction(f, conversation.id, {
      type: 'human_return_to_ai',
      at: new Date(),
      note: null,
    })

    const dashboard = await loadDashboard(f.runtime.db, { workspaceId: f.workspaceId, days: 7 })
    expect(dashboard.handoffReasons).toContainEqual({ reason: 'low_confidence', conversations: 1 })
    expect(dashboard.totals.handoffs).toBe(1)
  })
})

/**
 * What the customer hears when the AI gives up.
 *
 * "The AI never goes silent" was enforced from the inside — a turn always ended in a reply
 * or a handoff — but a handoff told agents and said nothing to the person who had asked
 * the question. From where they sat the thread simply stopped.
 */
describe('a handoff reaches the customer', () => {
  const systemMessages = async (f: Fixture, conversationId: string) =>
    (await messagesOf(f, conversationId)).filter((m) => m.senderType === 'system')

  test('the customer is told a person is coming', async () => {
    const provider = mock([
      {
        kind: 'tool_calls',
        toolCalls: [
          {
            name: 'handoff_to_human',
            arguments: { reason: 'customer_requested', note: 'Asked for a person.' },
          },
        ],
      },
      { kind: 'text', text: 'ขอโอนสายนะคะ' },
    ])
    const f = await fixture({ providerBaseUrl: provider.url })

    await customerSays(f, 'ขอคุยกับเจ้าหน้าที่ค่ะ')
    await runQueuedWork(f)
    const conversation = await onlyConversation(f)

    const said = await systemMessages(f, conversation.id)
    expect(said).toHaveLength(1)
    expect(said[0]?.text).toBe('รอสักครู่นะคะ')
    // Queued for delivery, not merely written down: a message nobody was told to send is
    // the same silence with a database row attached.
    expect(said[0]?.status).toBe('queued')
  })

  test('a workspace with no provider at all still answers', async () => {
    // The path that produced the silence seen in production: no usable model, so no turn,
    // so nothing was ever composed for the customer.
    const f = await fixture({ providerBaseUrl: mock([{ kind: 'text', text: 'unused' }]).url })
    await f.runtime.db
      .delete(schema.taskSlots)
      .where(eq(schema.taskSlots.workspaceId, f.workspaceId))

    await customerSays(f, 'ราคาเท่าไหร่คะ')
    await runQueuedWork(f)
    const conversation = await onlyConversation(f)

    expect(conversation.mode).toBe('waiting_human')
    const said = await systemMessages(f, conversation.id)
    expect(said).toHaveLength(1)
  })

  test('it is written in the language the customer wrote in', async () => {
    const provider = mock([{ kind: 'text', text: 'unused' }])
    const f = await fixture({ providerBaseUrl: provider.url })
    await f.runtime.db
      .delete(schema.taskSlots)
      .where(eq(schema.taskSlots.workspaceId, f.workspaceId))

    // An English speaker on a Thai-default workspace. The customer record says Thai,
    // because that is what it is seeded with; the message they actually sent says
    // otherwise, and that is the better evidence.
    await customerSays(f, 'how much does the starter plan cost')
    await runQueuedWork(f)
    const conversation = await onlyConversation(f)

    const said = await systemMessages(f, conversation.id)
    expect(said[0]?.text).toBe('One moment please.')
  })

  test('a turn retried after it handed off tells the customer once', async () => {
    // A real retry of the whole turn, not a replay of its effects: the job runs again with
    // the same id, on both delivery paths. The draft path matters most, because nothing
    // stops it at the mode check a send gets.
    for (const deliver of ['send', 'draft'] as const) {
      const f = await fixture({ providerBaseUrl: mock([{ kind: 'text', text: 'unused' }]).url })
      await f.runtime.db
        .delete(schema.taskSlots)
        .where(eq(schema.taskSlots.workspaceId, f.workspaceId))
      await customerSays(f, 'สวัสดีค่ะ')
      const conversation = await onlyConversation(f)
      const trigger = (await messagesOf(f, conversation.id)).find(
        (m) => m.senderType === 'customer',
      )
      const job = {
        workspaceId: f.workspaceId,
        conversationId: conversation.id,
        deliver,
        ...(trigger ? { triggerMessageId: trigger.id } : {}),
      }
      const ports = createEffectPorts(f.runtime, f.runtime.logger)
      // Drain what inbound queued, then run the same job twice by hand.
      await drainQueue(f, f.queues.ai_turn)
      await processAiTurn(f.runtime, ports, f.runtime.logger, job, {
        jobId: `ai-turn-${trigger?.id}`,
      })
      await processAiTurn(f.runtime, ports, f.runtime.logger, job, {
        jobId: `ai-turn-${trigger?.id}`,
      })

      const said = (await messagesOf(f, conversation.id)).filter((m) => m.senderType === 'system')
      expect(said).toHaveLength(1)
      const handoffs = await f.runtime.db
        .select()
        .from(schema.handoffEvents)
        .where(eq(schema.handoffEvents.conversationId, conversation.id))
      expect(handoffs).toHaveLength(1)
      // And one note for agents. The stable instant dedupes the message and the row above;
      // only the state machine ignoring a second handoff stops a second note.
      const notes = await f.runtime.db
        .select()
        .from(schema.internalNotes)
        .where(eq(schema.internalNotes.conversationId, conversation.id))
      expect(notes).toHaveLength(1)
    }
  })

  test('a retried turn does not tell the customer twice', async () => {
    const f = await fixture({ providerBaseUrl: mock([{ kind: 'text', text: 'hi' }]).url })
    await customerSays(f, 'สวัสดี')
    await runQueuedWork(f)
    const conversation = await onlyConversation(f)
    const ctx = { workspaceId: f.workspaceId, conversationId: conversation.id }
    const ports = createEffectPorts(f.runtime, f.runtime.logger)

    // The instant is what the state machine computed, so a replay of the same effect list
    // carries the same one. Two attempts, one message.
    const at = new Date()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await applyEffects(
        [{ type: 'send_acknowledgement', kind: 'handoff', language: 'th', at }],
        ctx,
        ports,
        f.runtime.logger,
      )
    }

    expect(await systemMessages(f, conversation.id)).toHaveLength(1)
    await relay(f)
    const queued = await f.queues.outbound.getJobs(['waiting', 'active', 'completed', 'delayed'])
    const forThisConversation = queued.filter(
      (job) => job?.data?.conversationId === conversation.id,
    )
    // One delivery per message, however many attempts asked for it.
    const messageIds = new Set(forThisConversation.map((job) => job?.data?.messageId))
    expect(messageIds.size).toBe(forThisConversation.length)
  })

  test('a second, genuinely later handoff speaks again', async () => {
    const f = await fixture({ providerBaseUrl: mock([{ kind: 'text', text: 'hi' }]).url })
    await customerSays(f, 'สวัสดี')
    await runQueuedWork(f)
    const conversation = await onlyConversation(f)
    const ctx = { workspaceId: f.workspaceId, conversationId: conversation.id }
    const ports = createEffectPorts(f.runtime, f.runtime.logger)

    for (const at of [new Date('2026-09-01T10:00:00Z'), new Date('2026-09-02T10:00:00Z')]) {
      await applyEffects(
        [{ type: 'send_acknowledgement', kind: 'handoff', language: 'th', at }],
        ctx,
        ports,
        f.runtime.logger,
      )
    }

    expect(await systemMessages(f, conversation.id)).toHaveLength(2)
  })

  test('a workspace that has emptied both boxes says nothing rather than failing', async () => {
    const f = await fixture({
      providerBaseUrl: mock([{ kind: 'text', text: 'hi' }]).url,
      settings: { acknowledgementText: { th: '', en: '' } },
    })
    await customerSays(f, 'สวัสดี')
    await runQueuedWork(f)
    const conversation = await onlyConversation(f)

    await applyEffects(
      [{ type: 'send_acknowledgement', kind: 'handoff', language: 'th', at: new Date() }],
      { workspaceId: f.workspaceId, conversationId: conversation.id },
      createEffectPorts(f.runtime, f.runtime.logger),
      f.runtime.logger,
    )

    expect(await systemMessages(f, conversation.id)).toHaveLength(0)
  })
})

/**
 * Tenant-defined tools.
 *
 * The rules here are the ones that cost money or trust when they are wrong: a read that
 * fails must not become an invented answer, a write must not fire before the turn is known
 * to have worked, and a bound identity must come from a proof rather than from the model.
 */
describe('tenant tools', () => {
  const endpoints: { stop: () => void }[] = []

  afterEach(() => {
    for (const e of endpoints.splice(0)) e.stop()
  })

  function endpoint(handler: (request: Request) => Response | Promise<Response>): string {
    const server = Bun.serve({ port: 0, fetch: handler })
    endpoints.push({ stop: () => server.stop(true) })
    return `http://127.0.0.1:${server.port}`
  }

  test('a read tool answers the customer and its result reaches the trace', async () => {
    const base = endpoint(() => Response.json({ plan: 'pro', renewsOn: '2026-10-01' }))
    const server = mock([
      { kind: 'tool_calls', toolCalls: [{ name: 'check_plan', arguments: {} }] },
      { kind: 'text', text: 'คุณอยู่แพ็กเกจ Pro ค่ะ' },
    ])
    const f = await fixture({ providerBaseUrl: server.url })

    await f.createTool({
      name: 'check_plan',
      description: 'Look up which plan this customer is on.',
      config: {
        method: 'GET',
        url: `${base}/plan`,
        headers: {},
        auth: 'none',
        args: [],
        bindings: [{ name: 'customer_id', source: 'customer_id' }],
        effect: 'read',
        timeoutMs: 8000,
      },
    })

    await customerSays(f, 'แพ็กเกจของฉันคืออะไร')
    await runQueuedWork(f)

    const conversation = await onlyConversation(f)
    expect(conversation.mode).toBe('ai')

    const messages = await f.runtime.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversation.id))
      .orderBy(asc(schema.messages.createdAt))
    expect(messages.at(-1)?.text).toBe('คุณอยู่แพ็กเกจ Pro ค่ะ')

    const traces = await f.runtime.db
      .select()
      .from(schema.aiTraces)
      .where(eq(schema.aiTraces.conversationId, conversation.id))
    const calls = traces[0]?.toolCalls as { toolName: string; output: unknown }[]
    expect(calls?.[0]?.toolName).toBe('check_plan')
    expect(calls?.[0]?.output).toMatchObject({ body: { plan: 'pro' } })
  })

  test('a tool the workspace has not defined is simply not offered', async () => {
    const server = mock([{ kind: 'text', text: 'สวัสดีค่ะ' }])
    const f = await fixture({ providerBaseUrl: server.url })

    await customerSays(f, 'สวัสดี')
    await runQueuedWork(f)

    const request = server.requests[0] as { tools?: { function?: { name?: string } }[] }
    const names = (request.tools ?? []).map((t) => t.function?.name)
    expect(names).toContain('handoff_to_human')
    expect(names).not.toContain('check_plan')
  })

  test('a read tool that fails hands off instead of letting the model invent an answer', async () => {
    const base = endpoint(() => new Response('upstream exploded', { status: 500 }))
    const server = mock([
      { kind: 'tool_calls', toolCalls: [{ name: 'check_plan', arguments: {} }] },
      // The model answers anyway, which is exactly the behaviour being guarded against.
      { kind: 'text', text: 'คุณอยู่แพ็กเกจ Pro ค่ะ' },
    ])
    const f = await fixture({ providerBaseUrl: server.url })

    await f.createTool({
      name: 'check_plan',
      config: {
        method: 'GET',
        url: `${base}/plan`,
        headers: {},
        auth: 'none',
        args: [],
        bindings: [],
        effect: 'read',
        timeoutMs: 8000,
      },
    })

    await customerSays(f, 'แพ็กเกจของฉันคืออะไร')
    await runQueuedWork(f)

    const conversation = await onlyConversation(f)
    expect(conversation.mode).toBe('waiting_human')
    expect(conversation.handoffReason).toBe('tool_error')

    const messages = await f.runtime.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversation.id))
    // The invented answer never reached the customer.
    expect(messages.filter((m) => m.senderType === 'ai')).toHaveLength(0)

    const events = await f.runtime.db
      .select()
      .from(schema.handoffEvents)
      .where(eq(schema.handoffEvents.conversationId, conversation.id))
    expect(events).toHaveLength(1)
    expect(events[0]?.reason).toBe('tool_error')
  })

  test('a writing tool sends nothing during the turn and fires once after it', async () => {
    const seen: { key: string | null; body: unknown }[] = []
    const base = endpoint(async (request) => {
      seen.push({
        key: request.headers.get('idempotency-key'),
        body: await request.json().catch(() => null),
      })
      return Response.json({ cancelled: true })
    })

    const server = mock([
      {
        kind: 'tool_calls',
        toolCalls: [{ name: 'cancel_booking', arguments: { booking_id: 'B-12' } }],
      },
      { kind: 'text', text: 'ยกเลิกให้แล้วค่ะ' },
    ])
    const f = await fixture({ providerBaseUrl: server.url })

    await f.createTool({
      name: 'cancel_booking',
      config: {
        method: 'POST',
        url: `${base}/cancel`,
        headers: {},
        auth: 'none',
        args: [
          { name: 'booking_id', type: 'string', description: 'Which booking', required: true },
        ],
        bindings: [{ name: 'customer', source: 'customer_id' }],
        effect: 'write',
        timeoutMs: 8000,
      },
    })

    await customerSays(f, 'ยกเลิกการจองให้หน่อย')
    await runQueuedWork(f)

    expect(seen).toHaveLength(1)
    expect(seen[0]?.body).toMatchObject({ booking_id: 'B-12' })
    // Stable across a retry of the same job, which is what makes it worth sending at all.
    expect(seen[0]?.key).toBeTruthy()

    const conversation = await onlyConversation(f)
    const messages = await f.runtime.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversation.id))
      .orderBy(asc(schema.messages.createdAt))
    expect(messages.at(-1)?.text).toBe('ยกเลิกให้แล้วค่ะ')
  })

  test('a failing write holds the reply back and fetches a person', async () => {
    const base = endpoint(() => new Response('already cancelled', { status: 409 }))
    const server = mock([
      {
        kind: 'tool_calls',
        toolCalls: [{ name: 'cancel_booking', arguments: { booking_id: 'B-12' } }],
      },
      { kind: 'text', text: 'ยกเลิกให้แล้วค่ะ' },
    ])
    const f = await fixture({ providerBaseUrl: server.url })

    await f.createTool({
      name: 'cancel_booking',
      config: {
        method: 'POST',
        url: `${base}/cancel`,
        headers: {},
        auth: 'none',
        args: [
          { name: 'booking_id', type: 'string', description: 'Which booking', required: true },
        ],
        bindings: [],
        effect: 'write',
        timeoutMs: 8000,
      },
    })

    await customerSays(f, 'ยกเลิกการจองให้หน่อย')
    await runQueuedWork(f)

    const conversation = await onlyConversation(f)
    expect(conversation.handoffReason).toBe('tool_error')

    const messages = await f.runtime.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversation.id))
    // "ยกเลิกให้แล้วค่ะ" means "I have cancelled it", which was not true.
    expect(messages.some((m) => m.senderType === 'ai')).toBe(false)

    const notes = await f.runtime.db
      .select()
      .from(schema.internalNotes)
      .where(eq(schema.internalNotes.conversationId, conversation.id))
    expect(notes.some((n) => n.body.includes('cancel_booking'))).toBe(true)
  })

  test('a tool bound to a proved identity is withheld until one exists', async () => {
    const base = endpoint(() => Response.json({ plan: 'pro' }))
    const server = mock([{ kind: 'text', text: 'ขอทราบอีเมลที่ใช้สมัครได้ไหมคะ' }])
    const f = await fixture({ providerBaseUrl: server.url })

    await f.createTool({
      name: 'account_details',
      config: {
        method: 'GET',
        url: `${base}/account`,
        headers: {},
        auth: 'none',
        args: [],
        bindings: [{ name: 'account_id', source: 'subject' }],
        effect: 'read',
        timeoutMs: 8000,
      },
    })

    await customerSays(f, 'ขอดูข้อมูลบัญชีหน่อย')
    await runQueuedWork(f)

    const offered = (server.requests[0] as { tools?: { function?: { name?: string } }[] }).tools
    expect((offered ?? []).map((t) => t.function?.name)).not.toContain('account_details')

    // Prove who they are, the way the confirm endpoint does, and the tool appears.
    const conversation = await onlyConversation(f)
    await recordVerifiedIdentity(f.runtime.db, {
      workspaceId: f.workspaceId,
      channelIdentityId: conversation.channelIdentityId,
      verified: { subject: 'acct_7', attributes: { plan: 'pro' }, via: 'widget_token' },
    })

    const second = mock([
      { kind: 'tool_calls', toolCalls: [{ name: 'account_details', arguments: {} }] },
      { kind: 'text', text: 'คุณอยู่แพ็กเกจ Pro ค่ะ' },
    ])
    await f.runtime.db
      .update(schema.providers)
      .set({ baseUrl: second.url })
      .where(eq(schema.providers.id, f.providerId))

    await customerSays(f, 'ขอดูข้อมูลบัญชีอีกครั้ง')
    await runQueuedWork(f)

    const names = (
      (second.requests[0] as { tools?: { function?: { name?: string } }[] }).tools ?? []
    ).map((t) => t.function?.name)
    expect(names).toContain('account_details')
  })

  test('switching a proof off withdraws the tools bound to it', async () => {
    const base = endpoint(() => Response.json({ plan: 'pro' }))
    const server = mock([{ kind: 'text', text: 'สวัสดีค่ะ' }])
    const f = await fixture({
      providerBaseUrl: server.url,
      settings: {
        identity: {
          widgetToken: { enabled: false },
          verificationLink: { enabled: false, url: null, secretEncrypted: null, ttlMinutes: 15 },
        },
      },
    })

    await f.createTool({
      name: 'account_details',
      config: {
        method: 'GET',
        url: `${base}/account`,
        headers: {},
        auth: 'none',
        args: [],
        bindings: [{ name: 'account_id', source: 'subject' }],
        effect: 'read',
        timeoutMs: 8000,
      },
    })

    await customerSays(f, 'สวัสดี')
    const conversation = await onlyConversation(f)
    // A proof is on the record, but the workspace no longer accepts that kind.
    await recordVerifiedIdentity(f.runtime.db, {
      workspaceId: f.workspaceId,
      channelIdentityId: conversation.channelIdentityId,
      verified: { subject: 'acct_7', attributes: {}, via: 'widget_token' },
    })

    await customerSays(f, 'ขอดูข้อมูลบัญชี')
    await runQueuedWork(f)

    const names = (
      (server.requests.at(-1) as { tools?: { function?: { name?: string } }[] }).tools ?? []
    ).map((t) => t.function?.name)
    expect(names).not.toContain('account_details')
  })
})

/**
 * The verification link, end to end.
 *
 * What it has to prove is that a link the AI asked for actually reaches the customer, that
 * spending the code binds the identity, and that the question they asked before proving
 * themselves gets answered afterwards.
 */
describe('the verification link', () => {
  test('the AI asks for one, the customer gets it, and spending it proves the identity', async () => {
    const server = mock([
      {
        kind: 'tool_calls',
        toolCalls: [{ name: 'request_identity_verification', arguments: {} }],
      },
      { kind: 'text', text: 'ขอส่งลิงก์ยืนยันตัวตนให้นะคะ' },
    ])
    const f = await fixture({
      providerBaseUrl: server.url,
      settings: {
        identity: {
          widgetToken: { enabled: true },
          verificationLink: {
            enabled: true,
            url: 'https://salon.example.com/verify',
            secretEncrypted: null,
            ttlMinutes: 15,
          },
        },
      },
    })

    await customerSays(f, 'ขอดูข้อมูลบัญชีของฉัน')
    await runQueuedWork(f)

    const conversation = await onlyConversation(f)
    const messages = await f.runtime.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversation.id))
      .orderBy(asc(schema.messages.createdAt))

    // The reply comes first and the link after it, so the customer is told why before
    // being handed a login prompt.
    const ai = messages.filter((m) => m.senderType === 'ai')
    const system = messages.filter((m) => m.senderType === 'system')
    expect(ai.at(-1)?.text).toBe('ขอส่งลิงก์ยืนยันตัวตนให้นะคะ')
    expect(system.at(-1)?.text).toContain('https://salon.example.com/verify?code=')

    const codes = await f.runtime.db
      .select()
      .from(schema.identityVerifications)
      .where(eq(schema.identityVerifications.workspaceId, f.workspaceId))
    expect(codes).toHaveLength(1)
    const code = codes[0]?.code ?? ''

    // Spending it binds the account, exactly as the confirm endpoint does.
    const consumed = await consumeVerificationCode(f.runtime.db, code)
    expect(consumed?.conversationId).toBe(conversation.id)

    // And it is spent: a second attempt gets nothing.
    expect(await consumeVerificationCode(f.runtime.db, code)).toBeNull()
  })

  test('a second link invalidates the first, so only the newest can be spent', async () => {
    const server = mock([{ kind: 'text', text: 'สวัสดีค่ะ' }])
    const f = await fixture({
      providerBaseUrl: server.url,
      settings: {
        identity: {
          widgetToken: { enabled: true },
          verificationLink: {
            enabled: true,
            url: 'https://salon.example.com/verify',
            secretEncrypted: null,
            ttlMinutes: 15,
          },
        },
      },
    })

    await customerSays(f, 'สวัสดี')
    const conversation = await onlyConversation(f)

    const first = await sendVerificationLink(f.runtime, {
      workspaceId: f.workspaceId,
      conversationId: conversation.id,
    })
    const second = await sendVerificationLink(f.runtime, {
      workspaceId: f.workspaceId,
      conversationId: conversation.id,
    })
    if (!first.ok || !second.ok) throw new Error('the links should have been sent')

    // Two live links minutes apart is how the wrong identity lands on the wrong person.
    expect(await consumeVerificationCode(f.runtime.db, first.code)).toBeNull()
    expect(await consumeVerificationCode(f.runtime.db, second.code)).not.toBeNull()
  })

  test('looking a code up does not spend it, so a bad confirmation is survivable', async () => {
    const server = mock([{ kind: 'text', text: 'สวัสดีค่ะ' }])
    const f = await fixture({
      providerBaseUrl: server.url,
      settings: {
        identity: {
          widgetToken: { enabled: true },
          verificationLink: {
            enabled: true,
            url: 'https://salon.example.com/verify',
            secretEncrypted: null,
            ttlMinutes: 15,
          },
        },
      },
    })

    await customerSays(f, 'สวัสดี')
    const conversation = await onlyConversation(f)
    const sent = await sendVerificationLink(f.runtime, {
      workspaceId: f.workspaceId,
      conversationId: conversation.id,
    })
    if (!sent.ok) throw new Error('the link should have been sent')

    // The confirm endpoint looks the code up to find the workspace whose secret signed the
    // token. If that lookup spent the code, a bad token would destroy the customer's only
    // link, and anyone who can read the chat can read the code out of it.
    expect(await findVerificationCode(f.runtime.db, sent.code)).not.toBeNull()
    expect(await findVerificationCode(f.runtime.db, sent.code)).not.toBeNull()
    expect(await consumeVerificationCode(f.runtime.db, sent.code)).not.toBeNull()
    expect(await findVerificationCode(f.runtime.db, sent.code)).toBeNull()
  })

  test('an expired code cannot be spent', async () => {
    const server = mock([{ kind: 'text', text: 'สวัสดีค่ะ' }])
    const f = await fixture({
      providerBaseUrl: server.url,
      settings: {
        identity: {
          widgetToken: { enabled: true },
          verificationLink: {
            enabled: true,
            url: 'https://salon.example.com/verify',
            secretEncrypted: null,
            ttlMinutes: 15,
          },
        },
      },
    })

    await customerSays(f, 'สวัสดี')
    const conversation = await onlyConversation(f)
    const sent = await sendVerificationLink(f.runtime, {
      workspaceId: f.workspaceId,
      conversationId: conversation.id,
    })
    if (!sent.ok) throw new Error('the link should have been sent')

    await f.runtime.db
      .update(schema.identityVerifications)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.identityVerifications.code, sent.code))

    expect(await consumeVerificationCode(f.runtime.db, sent.code)).toBeNull()
  })

  test('is not offered while the AI is only drafting, since nothing would send it', async () => {
    // The draft path ends at a suggestion for a person to approve and never reaches the
    // code that sends a link. Offering the tool there lets the model write "I've sent you
    // a link", an agent approve it, and nothing arrive.
    const server = mock([{ kind: 'text', text: 'ขอตรวจสอบให้นะคะ' }])
    const f = await fixture({
      providerBaseUrl: server.url,
      settings: {
        defaultMode: 'ai_supervised',
        identity: {
          widgetToken: { enabled: true },
          verificationLink: {
            enabled: true,
            url: 'https://salon.example.com/verify',
            secretEncrypted: null,
            ttlMinutes: 15,
          },
        },
      },
    })

    await customerSays(f, 'ขอดูข้อมูลบัญชีของฉัน')
    await runQueuedWork(f)

    const offered = (
      (server.requests[0] as { tools?: { function?: { name?: string } }[] }).tools ?? []
    ).map((t) => t.function?.name)
    expect(offered).not.toContain('request_identity_verification')
  })

  test('the tool is not offered when no link is configured', async () => {
    const server = mock([{ kind: 'text', text: 'สวัสดีค่ะ' }])
    const f = await fixture({ providerBaseUrl: server.url })

    await customerSays(f, 'ขอดูข้อมูลบัญชี')
    await runQueuedWork(f)

    const names = (
      (server.requests[0] as { tools?: { function?: { name?: string } }[] }).tools ?? []
    ).map((t) => t.function?.name)
    expect(names).not.toContain('request_identity_verification')
  })
})

describe('the account owner', () => {
  /**
   * The owner is a default, not a label. Somebody who looks after a customer should find
   * their conversation already theirs rather than having to claim it.
   *
   * The path that matters is reopening, not creating: a conversation is now made only for
   * an identity that has never written before, so a returning customer picks up an owner
   * assigned since their last message when the thread starts again.
   */
  test('is put on the conversation when the customer comes back', async () => {
    const server = mock([{ kind: 'text', text: 'สวัสดีค่ะ' }])
    const f = await fixture({ providerBaseUrl: server.url })

    await customerSays(f, 'คำถามแรก', { externalId: 'owned-customer' })
    await runQueuedWork(f)

    const first = await f.runtime.db
      .select({ id: schema.conversations.id, customerId: schema.conversations.customerId })
      .from(schema.conversations)
      .where(eq(schema.conversations.workspaceId, f.workspaceId))
    const conversationId = first[0]?.id ?? ''
    const customerId = first[0]?.customerId ?? ''

    // Somebody takes the customer on. The conversation in flight is left alone, because
    // reassigning an owner must not pull a thread from whoever is answering it.
    await f.runtime.db
      .update(schema.customers)
      .set({ assigneeUserId: f.userId })
      .where(eq(schema.customers.id, customerId))

    const untouched = await f.runtime.db
      .select({ assigneeUserId: schema.conversations.assigneeUserId })
      .from(schema.conversations)
      .where(eq(schema.conversations.id, conversationId))
    expect(untouched[0]?.assigneeUserId).toBeNull()

    // It is finished, and then they come back.
    await updateConversation(f.runtime.db, f.workspaceId, conversationId, { status: 'resolved' })
    await customerSays(f, 'คำถามที่สอง', { externalId: 'owned-customer' })

    const reopened = await f.runtime.db
      .select({
        id: schema.conversations.id,
        status: schema.conversations.status,
        assigneeUserId: schema.conversations.assigneeUserId,
      })
      .from(schema.conversations)
      .where(eq(schema.conversations.customerId, customerId))

    // Still one conversation, open again, and now the owner's.
    expect(reopened).toHaveLength(1)
    expect(reopened[0]?.id).toBe(conversationId)
    expect(reopened[0]?.status).toBe('open')
    expect(reopened[0]?.assigneeUserId).toBe(f.userId)
  })
})

describe('a customer who comes back after being resolved', () => {
  /**
   * The customer sees one unbroken chat in LINE or Messenger. Splitting it at the moment a
   * colleague decided they were finished gave the agent a fragment of what the customer was
   * looking at, and the console filled with the same name several times over.
   */
  test('carries on in the same conversation rather than starting another', async () => {
    const server = mock([{ kind: 'text', text: 'สวัสดีค่ะ' }])
    const f = await fixture({ providerBaseUrl: server.url })

    await customerSays(f, 'คำถามแรก', { externalId: 'returning-customer' })
    await runQueuedWork(f)

    const before = await f.runtime.db
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(eq(schema.conversations.workspaceId, f.workspaceId))
    expect(before).toHaveLength(1)
    const conversationId = before[0]?.id ?? ''

    // An agent takes it, answers, and marks it finished.
    await updateConversation(f.runtime.db, f.workspaceId, conversationId, {
      mode: 'human',
      status: 'resolved',
      assigneeUserId: f.userId,
      handoffReason: 'ai_requested',
    })

    await customerSays(f, 'ขอถามอีกเรื่องค่ะ', { externalId: 'returning-customer' })

    const after = await f.runtime.db
      .select({
        id: schema.conversations.id,
        status: schema.conversations.status,
        mode: schema.conversations.mode,
        handoffReason: schema.conversations.handoffReason,
      })
      .from(schema.conversations)
      .where(eq(schema.conversations.workspaceId, f.workspaceId))

    expect(after).toHaveLength(1)
    expect(after[0]?.id).toBe(conversationId)
    expect(after[0]?.status).toBe('open')

    /**
     * Back in the mode a new conversation would have started in. Left in `human` the AI may
     * only suggest, so the question would sit unanswered in front of an agent who had
     * already closed it.
     */
    expect(after[0]?.mode).toBe('ai')
    expect(after[0]?.handoffReason).toBeNull()

    // And both questions are in the one thread, which is what the customer sees.
    const texts = await f.runtime.db
      .select({ text: schema.messages.text })
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
    expect(texts.map((row) => row.text)).toContain('คำถามแรก')
    expect(texts.map((row) => row.text)).toContain('ขอถามอีกเรื่องค่ะ')
  })

  test('and the AI answers it, rather than waiting for the agent who closed it', async () => {
    const server = mock([{ kind: 'text', text: 'ยินดีค่ะ' }])
    const f = await fixture({ providerBaseUrl: server.url })

    await customerSays(f, 'คำถามแรก', { externalId: 'returning-again' })
    await runQueuedWork(f)

    const rows = await f.runtime.db
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(eq(schema.conversations.workspaceId, f.workspaceId))
    const conversationId = rows[0]?.id ?? ''

    await updateConversation(f.runtime.db, f.workspaceId, conversationId, {
      mode: 'human',
      status: 'resolved',
    })

    await customerSays(f, 'สวัสดีอีกครั้ง', { externalId: 'returning-again' })
    await runQueuedWork(f)

    const ai = await f.runtime.db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, conversationId),
          eq(schema.messages.senderType, 'ai'),
        ),
      )
    expect(ai.length).toBeGreaterThan(1)
  })
})

describe('messages arriving at the same moment', () => {
  /**
   * Inbound runs ten jobs at a time. Two messages typed in quick succession are two jobs,
   * and without a lock they both look for a conversation, both find none, and both make
   * one: a single burst of typing becomes two threads in the console.
   */
  test('still produce exactly one conversation', async () => {
    const server = mock([{ kind: 'text', text: 'สวัสดีค่ะ' }])
    const f = await fixture({ providerBaseUrl: server.url })
    const externalId = 'simultaneous-customer'

    const ports = createEffectPorts(f.runtime, f.runtime.logger)
    const events = await Promise.all(
      ['หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า'].map(async (text) => {
        const outcome = await ingestInternal(f.runtime, f.runtime.db, {
          channelId: f.channelId,
          expectedType: 'test',
          body: {
            externalId,
            displayName: externalId,
            message: { kind: 'text', text },
            eventId: `evt-${crypto.randomUUID()}`,
          },
        })
        if (!outcome.ok) throw new Error(`ingest failed: ${outcome.reason}`)
        return outcome.inboundEventId
      }),
    )

    // All five processed at once, the way the worker would run them.
    await Promise.all(
      events.map((inboundEventId) =>
        processInbound(f.runtime, ports, f.runtime.logger, {
          workspaceId: f.workspaceId,
          channelId: f.channelId,
          inboundEventId,
        }),
      ),
    )

    const conversations = await f.runtime.db
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(eq(schema.conversations.workspaceId, f.workspaceId))
    expect(conversations).toHaveLength(1)

    // And every message landed in it.
    const messages = await f.runtime.db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversations[0]?.id ?? ''))
    expect(messages.length).toBeGreaterThanOrEqual(5)
  })
})

/**
 * What happens when work is done twice, which under a transactional outbox is more often on
 * purpose: an intent that survives a crash is meant to be delivered again.
 */
describe('work that is done twice', () => {
  test('a retried AI turn delivers the reply it already wrote instead of writing another', async () => {
    const provider = mock([
      { kind: 'text', text: 'คำตอบแรกค่ะ' },
      { kind: 'text', text: 'คำตอบที่สองค่ะ' },
    ])
    const f = await fixture({ providerBaseUrl: provider.url })

    await customerSays(f, 'ถามหน่อยค่ะ')
    const conversation = await onlyConversation(f)
    const inbound = (await messagesOf(f, conversation.id)).find((m) => m.direction === 'inbound')
    if (!inbound) throw new Error('the customer message was not stored')

    const jobs = await drainQueue<{
      workspaceId: string
      conversationId: string
      deliver: 'send' | 'draft'
    }>(f, f.queues.ai_turn)
    const job = jobs[0]
    if (!job) throw new Error('no AI turn was queued')

    // The id BullMQ carries for this turn, derived from the message that prompted it, so
    // both attempts are the same job rather than two answers.
    const meta = { jobId: `ai-turn-${inbound.id}` }
    await processAiTurn(f.runtime, portsFor(f), f.runtime.logger, job, meta)
    await processAiTurn(f.runtime, portsFor(f), f.runtime.logger, job, meta)

    const replies = (await messagesOf(f, conversation.id)).filter((m) => m.senderType === 'ai')
    expect(replies).toHaveLength(1)
    expect(replies[0]?.text).toBe('คำตอบแรกค่ะ')

    // The model was paid for once: the second attempt recognised the answer it already had.
    expect(provider.requests).toHaveLength(1)

    // Delivery is still owed, under the reply's own id, exactly once.
    const outbound = await drainQueue<{ messageId: string }>(f, f.queues.outbound)
    expect(outbound.map((entry) => entry.messageId)).toEqual([replies[0]?.id as string])
  })

  test('a human taking over during the turn stops the reply being sent', async () => {
    const provider = mock([{ kind: 'text', text: 'คำตอบที่ไม่ควรถูกส่ง' }])
    const f = await fixture({ providerBaseUrl: provider.url })

    await customerSays(f, 'ถามอีกรอบค่ะ')
    const jobs = await drainQueue<{
      workspaceId: string
      conversationId: string
      deliver: 'send' | 'draft'
    }>(f, f.queues.ai_turn)
    const job = jobs[0]
    if (!job) throw new Error('no AI turn was queued')

    // The race itself: the turn is owed, and a colleague claims the conversation before it
    // runs. Until recently the mode was read once, before the model call, and never again.
    const conversation = await onlyConversation(f)
    await humanAction(f, conversation.id, {
      type: 'human_take_over',
      at: new Date(),
      userId: f.userId,
    })

    await processAiTurn(f.runtime, portsFor(f), f.runtime.logger, job)

    const replies = (await messagesOf(f, conversation.id)).filter((m) => m.senderType === 'ai')
    expect(replies).toHaveLength(0)
    expect(await drainQueue(f, f.queues.outbound)).toHaveLength(0)
    // Not thrown away: the person who took over is offered what it would have said.
    expect(await drainQueue(f, f.queues.suggestion)).toHaveLength(1)
  })

  test('an AI reply queued before a takeover is not delivered after it', async () => {
    const provider = mock([{ kind: 'text', text: 'สวัสดีค่ะ' }])
    const f = await fixture({ providerBaseUrl: provider.url })

    await customerSays(f, 'สวัสดีค่ะ')
    await runQueuedWork(f)

    const conversation = await onlyConversation(f)
    const reply = (await messagesOf(f, conversation.id)).find((m) => m.senderType === 'ai')
    if (!reply) throw new Error('the AI did not reply')

    // The reply is stored and queued; the delivery job has been waiting behind others.
    await humanAction(f, conversation.id, {
      type: 'human_take_over',
      at: new Date(),
      userId: f.userId,
    })

    await processOutbound(f.runtime, portsFor(f), f.runtime.logger, {
      workspaceId: f.workspaceId,
      conversationId: conversation.id,
      messageId: reply.id,
    })

    const after = (await messagesOf(f, conversation.id)).find((m) => m.id === reply.id)
    expect(after?.status).toBe('canceled')
    expect(after?.error).toContain('took over')
  })

  test('a message the customer has already read is never sent again', async () => {
    const provider = mock([{ kind: 'text', text: 'ขอบคุณค่ะ' }])
    const f = await fixture({ providerBaseUrl: provider.url })

    await customerSays(f, 'ขอบคุณค่ะ')
    await runQueuedWork(f)
    const conversation = await onlyConversation(f)
    const reply = (await messagesOf(f, conversation.id)).find((m) => m.senderType === 'ai')
    if (!reply) throw new Error('the AI did not reply')

    await f.runtime.db
      .update(schema.messages)
      .set({ status: 'read' })
      .where(eq(schema.messages.id, reply.id))

    await processOutbound(f.runtime, portsFor(f), f.runtime.logger, {
      workspaceId: f.workspaceId,
      conversationId: conversation.id,
      messageId: reply.id,
    })

    const after = (await messagesOf(f, conversation.id)).find((m) => m.id === reply.id)
    // Untouched. Receipts only ever raise a status, so `read` is as sent as it gets, and
    // an early return that covered only `sent` and `delivered` sent it a second time.
    expect(after?.status).toBe('read')
  })
})

describe('the review, phase B', () => {
  /**
   * Recommendation #7. A colleague takes over while the model is still writing: nothing the
   * turn produced is written or sent, and the colleague gets a suggestion instead.
   */
  test('a takeover during the model call leaves no reply and no learned field', async () => {
    let f: Fixture | null = null
    let conversationId = ''
    const slow = Bun.serve({
      port: 0,
      async fetch(request) {
        if (!new URL(request.url).pathname.endsWith('/chat/completions')) {
          return new Response('not found', { status: 404 })
        }
        const body = (await request.json()) as { tools?: unknown[] }
        // The colleague clicks "take over" while this answer is being written.
        if (f && conversationId) {
          await humanAction(f, conversationId, {
            type: 'human_take_over',
            at: new Date(),
            userId: f.userId,
          })
        }
        const message = body.tools
          ? {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: {
                    name: 'set_customer_field',
                    arguments: JSON.stringify({ key: 'order_id', value: 'SO-TAKEN' }),
                  },
                },
              ],
            }
          : { role: 'assistant', content: 'too late' }
        return Response.json({
          id: 'x',
          object: 'chat.completion',
          created: 1,
          model: 'mock-model',
          choices: [{ index: 0, message, finish_reason: body.tools ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      },
    })
    try {
      f = await fixture({ providerBaseUrl: `http://localhost:${slow.port}/v1` })
      await customerSays(f, 'my order is SO-TAKEN')
      conversationId = (await onlyConversation(f)).id
      await runQueuedWork(f)

      const messages = await messagesOf(f, conversationId)
      expect(messages.filter((m) => m.senderType === 'ai')).toHaveLength(0)
      const [customer] = await f.runtime.db
        .select({ fields: schema.customers.fields })
        .from(schema.customers)
        .where(eq(schema.customers.workspaceId, f.workspaceId))
      expect((customer?.fields as Record<string, string> | undefined)?.order_id).toBeUndefined()
    } finally {
      slow.stop(true)
    }
  })

  /**
   * Recommendation #11. A turn that failed every retry reaches a person, the same as every
   * other path out of a turn.
   */
  test('a turn that failed for good is handed to a person, once', async () => {
    const provider = mock([{ kind: 'text', text: 'unused' }])
    const f = await fixture({ providerBaseUrl: provider.url })
    await customerSays(f, 'hello?')
    const conversation = await onlyConversation(f)
    const [job] = await drainQueue<{
      workspaceId: string
      conversationId: string
      deliver: 'send' | 'draft'
    }>(f, f.queues.ai_turn)
    if (!job) throw new Error('expected a queued AI turn')

    const ports = portsFor(f)
    await handOffAfterFailure(f.runtime, ports, f.runtime.logger, job, new Error('db down'))
    await handOffAfterFailure(f.runtime, ports, f.runtime.logger, job, new Error('db down'))

    expect((await onlyConversation(f)).mode).toBe('waiting_human')
    const told = (await messagesOf(f, conversation.id)).filter((m) => m.senderType === 'system')
    expect(told).toHaveLength(1)
  })

  /**
   * Recommendation #8. An event without an id used to get a random one at parse time, so a
   * retried job stored the customer's message twice and answered it twice.
   */
  test('an event without an id is still one message when its job runs twice', async () => {
    const provider = mock([{ kind: 'text', text: 'answer' }])
    const f = await fixture({ providerBaseUrl: provider.url })
    const outcome = await ingestInternal(f.runtime, f.runtime.db, {
      channelId: f.channelId,
      expectedType: 'test',
      body: { externalId: 'no-id-customer', message: { kind: 'text', text: 'once please' } },
    })
    if (!outcome.ok) throw new Error('ingest failed')
    await drainQueue(f, f.queues.inbound)

    const job = {
      workspaceId: f.workspaceId,
      channelId: f.channelId,
      inboundEventId: outcome.inboundEventId,
    }
    // What was stored, before the worker empties it.
    const [stored] = await f.runtime.db
      .select({ payload: schema.inboundEvents.payload })
      .from(schema.inboundEvents)
      .where(eq(schema.inboundEvents.id, outcome.inboundEventId))
    await processInbound(f.runtime, portsFor(f), f.runtime.logger, job)

    // Processed events keep no raw body (recommendation #12).
    const [emptied] = await f.runtime.db
      .select({ payload: schema.inboundEvents.payload })
      .from(schema.inboundEvents)
      .where(eq(schema.inboundEvents.id, outcome.inboundEventId))
    expect(emptied?.payload).toEqual({})

    // As if the worker died after storing the message and before marking the event done.
    await f.runtime.db
      .update(schema.inboundEvents)
      .set({ processedAt: null, payload: stored?.payload ?? {} })
      .where(eq(schema.inboundEvents.id, outcome.inboundEventId))
    await processInbound(f.runtime, portsFor(f), f.runtime.logger, job)

    const conversation = await onlyConversation(f)
    const inbound = (await messagesOf(f, conversation.id)).filter((m) => m.direction === 'inbound')
    expect(inbound).toHaveLength(1)
  })
})
