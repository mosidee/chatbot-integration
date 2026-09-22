import { afterEach, describe, expect, test } from 'bun:test'
import { createEffectPorts, ingestInternal, schema } from '@ci/infra'
import { eq } from 'drizzle-orm'
import {
  type MockServer,
  startMockOpenAI,
} from '../../../packages/core/test/helpers/mock-openai-server'
import { processAiTurn } from '../src/processors/ai-turn'
import { processInbound } from '../src/processors/inbound'
import { processOutbound } from '../src/processors/outbound'
import { createFixture, type Fixture } from './helpers/fixture'

/**
 * A suspended tenant does no work.
 *
 * The rule the rest of the product enforces is that an AI turn never ends in silence: every
 * path out of it either answers the customer or fetches a person. This is the one deliberate
 * exception, and it is worth an assertion of its own precisely because it contradicts the
 * rule everywhere else — there is nobody to hand off to when every agent in the tenant is
 * locked out of the console too.
 *
 * What matters most here is the negative: no model call, no message, nothing sent.
 */

const servers: MockServer[] = []
const fixtures: Fixture[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop()
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
})

async function suspendedFixture(): Promise<{ fixture: Fixture; mock: MockServer }> {
  // Scripted with a reply that must never be requested: the assertion is that the model is
  // never called at all.
  const mock = startMockOpenAI([{ kind: 'text', text: 'This should never be sent.' }])
  servers.push(mock)

  const fixture = await createFixture({
    providerBaseUrl: mock.url,
    status: 'suspended',
  })
  fixtures.push(fixture)
  return { fixture, mock }
}

describe('a suspended workspace', () => {
  test('refuses the webhook politely rather than with an error', async () => {
    const { fixture } = await suspendedFixture()

    const outcome = await ingestInternal(fixture.runtime, fixture.runtime.db, {
      channelId: fixture.channelId,
      expectedType: 'test',
      body: {
        externalId: 'sim-suspended-1',
        message: { kind: 'text', text: 'hello?' },
        eventId: `evt-${crypto.randomUUID()}`,
      },
    })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('workspace_suspended')

    // Nothing was persisted: a tenant nobody may read should not accumulate raw payloads.
    const events = await fixture.runtime.db
      .select({ id: schema.inboundEvents.id })
      .from(schema.inboundEvents)
      .where(eq(schema.inboundEvents.channelId, fixture.channelId))
    expect(events).toHaveLength(0)
  })

  test('drops an inbound job without touching the conversation', async () => {
    const { fixture } = await suspendedFixture()
    const ports = createEffectPorts(fixture.runtime, fixture.runtime.logger)

    // Enqueued as if the workspace had been active a moment ago.
    await processInbound(fixture.runtime, ports, fixture.runtime.logger, {
      workspaceId: fixture.workspaceId,
      channelId: fixture.channelId,
      inboundEventId: 'an-event-that-is-never-read',
    })

    const conversations = await fixture.runtime.db
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(eq(schema.conversations.workspaceId, fixture.workspaceId))
    expect(conversations).toHaveLength(0)
  })

  test('drops an AI turn without calling the model or writing a message', async () => {
    const { fixture, mock } = await suspendedFixture()
    const ports = createEffectPorts(fixture.runtime, fixture.runtime.logger)

    // A conversation that exists, so the turn gets past its own context lookup and is
    // stopped by the status rather than by an absence.
    const { conversationId } = await seedConversation(fixture)

    await processAiTurn(fixture.runtime, ports, fixture.runtime.logger, {
      workspaceId: fixture.workspaceId,
      conversationId,
      deliver: 'send',
    })

    expect(mock.requests.length).toBe(0)

    const messages = await fixture.runtime.db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
    expect(messages).toHaveLength(0)

    // And no handoff either: there is nobody to hand off to.
    const events = await fixture.runtime.db
      .select({ id: schema.handoffEvents.id })
      .from(schema.handoffEvents)
      .where(eq(schema.handoffEvents.conversationId, conversationId))
    expect(events).toHaveLength(0)
  })

  test('does not send a message that was queued before the suspension', async () => {
    const { fixture } = await suspendedFixture()
    const ports = createEffectPorts(fixture.runtime, fixture.runtime.logger)
    const { conversationId } = await seedConversation(fixture)

    const messageId = crypto.randomUUID()
    await fixture.runtime.db.insert(schema.messages).values({
      id: messageId,
      workspaceId: fixture.workspaceId,
      conversationId,
      direction: 'outbound',
      senderType: 'ai',
      content: { kind: 'text', text: 'queued just before the lights went out' },
      status: 'queued',
    })

    await processOutbound(fixture.runtime, ports, fixture.runtime.logger, {
      workspaceId: fixture.workspaceId,
      conversationId,
      messageId,
    })

    const rows = await fixture.runtime.db
      .select({ status: schema.messages.status })
      .from(schema.messages)
      .where(eq(schema.messages.id, messageId))
    expect(rows[0]?.status).toBe('queued')
  })
})

/** A conversation and the customer behind it, written directly: ingestion is closed. */
async function seedConversation(fixture: Fixture): Promise<{ conversationId: string }> {
  const { db } = fixture.runtime
  const customerId = crypto.randomUUID()
  await db.insert(schema.customers).values({
    id: customerId,
    workspaceId: fixture.workspaceId,
    displayName: 'Waiting',
    primaryLanguage: 'th',
    fields: {},
  })
  const identityId = crypto.randomUUID()
  await db.insert(schema.channelIdentities).values({
    id: identityId,
    workspaceId: fixture.workspaceId,
    channelId: fixture.channelId,
    externalId: `suspended-${customerId.slice(0, 6)}`,
    customerId,
    profile: {},
  })
  const conversationId = crypto.randomUUID()
  await db.insert(schema.conversations).values({
    id: conversationId,
    workspaceId: fixture.workspaceId,
    channelId: fixture.channelId,
    customerId,
    channelIdentityId: identityId,
    mode: 'ai',
    status: 'open',
  })
  return { conversationId }
}
