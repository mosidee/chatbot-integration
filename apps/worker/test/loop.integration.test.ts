import { afterEach, describe, expect, test } from 'bun:test'
import { signBodyBase64 } from '@ci/channels'
import { applyEffects, type ConversationState, transition } from '@ci/core'
import { newId, schema } from '@ci/db'
import {
  acceptMergeSuggestion,
  applyReceipt,
  conversationForReceipt,
  countPendingMerges,
  countReviewQueue,
  createEffectPorts,
  createEntry,
  createSource,
  eraseCustomer,
  indexEntry,
  ingestWebhook,
  listMergeSuggestions,
  loadDashboard,
  loadWorkspaceSettings,
  markReviewed,
  markSuggestionSent,
  runRetention,
  storeMessage,
  toWebhookRequest,
  updateConversation,
  upsertFeedback,
  waitingHumanJobId,
} from '@ci/infra'
import { asc, desc, eq } from 'drizzle-orm'
import {
  type MockServer,
  startMockOpenAI,
} from '../../../packages/core/test/helpers/mock-openai-server'
import { processAiTurn } from '../src/processors/ai-turn'
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
    expect(messages[1]?.text ?? '').toBe('แพ็กเกจเริ่มต้น 990 บาทต่อเดือนค่ะ')

    // The reply was queued for delivery rather than sent inline.
    const outbound = await drainQueue<{ messageId: string }>(f.runtime.queues.outbound)
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
      conversationId?: string | null
    }>(f.runtime.queues.summarize)) {
      await processSummarize(f.runtime, ports, f.runtime.logger, job)
    }

    const customers = await f.runtime.db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.workspaceId, f.workspaceId))

    expect(customers[0]?.summary).toContain('เชียงใหม่')
    expect(customers[0]?.summary).toContain('ยังไม่ได้ตัดสินใจสมัคร')
    expect(customers[0]?.fields).toMatchObject({ city: 'Chiang Mai' })
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
      conversationId?: string | null
    }>(f.runtime.queues.summarize)) {
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

    const scheduled = await f.runtime.queues.waiting_human.getJob(
      waitingHumanJobId(conversation.id),
    )
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

    const scheduled = await f.runtime.queues.waiting_human.getJob(
      waitingHumanJobId(conversation.id),
    )
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
    expect(ack?.text).toBe('รอสักครู่นะคะ')
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

    await drainQueue(f.runtime.queues.inbound)
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
    }>(f.runtime.queues.ai_turn)) {
      await processAiTurn(f.runtime, ports, f.runtime.logger, job)
    }

    // The send will fail: the access token is not a real one.
    for (const job of await drainQueue<{
      workspaceId: string
      conversationId: string
      messageId: string
    }>(f.runtime.queues.outbound)) {
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
    }>(f.runtime.queues.ai_turn)) {
      await processAiTurn(f.runtime, ports, f.runtime.logger, job)
    }
    for (const job of await drainQueue<{
      workspaceId: string
      conversationId: string
      messageId: string
    }>(f.runtime.queues.outbound)) {
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
