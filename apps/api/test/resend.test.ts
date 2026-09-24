import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { loadEnv } from '@ci/config'
import { newId, schema } from '@ci/db'
import { and, eq, like } from 'drizzle-orm'
import { createApp } from '../src/app'
import { createApiContext } from '../src/context'
import { type ApiFixture, createApiFixture } from './helpers/session'

/**
 * U09: a message that failed to deliver can be sent again from the console. Only one that
 * failed for good — nothing else will try it — and only once per click.
 */

const env = { ...loadEnv(), TOOL_EGRESS_ALLOW_PRIVATE: false }
const ctx = createApiContext(env)
const app = createApp(ctx)

let fixture: ApiFixture
let channelId: string

beforeAll(async () => {
  fixture = await createApiFixture(ctx, app)
  const channels = await ctx.db
    .select({ id: schema.channels.id })
    .from(schema.channels)
    .where(eq(schema.channels.workspaceId, fixture.workspaceId))
  channelId = channels[0]?.id ?? ''
})

afterAll(async () => {
  await fixture.cleanup()
  await ctx.runtime.close()
})

async function conversationWith(input: {
  mode?: 'ai' | 'human'
  status: 'failed' | 'sent' | 'uncertain'
  senderType?: 'human' | 'ai'
}): Promise<{ conversationId: string; messageId: string }> {
  const customerId = newId()
  await ctx.db.insert(schema.customers).values({
    id: customerId,
    workspaceId: fixture.workspaceId,
    displayName: 'resend',
    fields: {},
  })
  const identityId = newId()
  await ctx.db.insert(schema.channelIdentities).values({
    id: identityId,
    workspaceId: fixture.workspaceId,
    channelId,
    externalId: `resend-${Math.random().toString(36).slice(2, 12)}`,
    customerId,
    profile: {},
  })
  const conversationId = newId()
  await ctx.db.insert(schema.conversations).values({
    id: conversationId,
    workspaceId: fixture.workspaceId,
    channelId,
    customerId,
    channelIdentityId: identityId,
    mode: input.mode ?? 'ai',
    status: 'open',
  })
  const messageId = newId()
  await ctx.db.insert(schema.messages).values({
    id: messageId,
    workspaceId: fixture.workspaceId,
    conversationId,
    direction: 'outbound',
    senderType: input.senderType ?? 'human',
    content: { kind: 'text', text: 'hello' },
    text: 'hello',
    status: input.status,
    error: input.status === 'failed' ? 'platform said no' : null,
  })
  return { conversationId, messageId }
}

const resend = (conversationId: string, messageId: string, actor = fixture.agent) =>
  fixture.as(actor, `/api/v1/conversations/${conversationId}/messages/${messageId}/resend`, {
    method: 'POST',
  })

describe('sending a failed message again', () => {
  test('queues it once, under a job id of its own', async () => {
    const { conversationId, messageId } = await conversationWith({ status: 'failed' })

    expect((await resend(conversationId, messageId)).status).toBe(200)
    const [row] = await ctx.db
      .select({ status: schema.messages.status, error: schema.messages.error })
      .from(schema.messages)
      .where(eq(schema.messages.id, messageId))
    expect(row).toEqual({ status: 'queued', error: null })

    const jobs = await ctx.db
      .select({ jobId: schema.outbox.jobId })
      .from(schema.outbox)
      .where(
        and(
          eq(schema.outbox.queue, 'outbound'),
          like(schema.outbox.jobId, `outbound-${messageId}-resend-%`),
        ),
      )
    expect(jobs).toHaveLength(1)

    // A second click finds it queued, not failed.
    expect((await resend(conversationId, messageId)).status).toBe(409)
  })

  test('refuses a message that did not fail, or may have arrived', async () => {
    for (const status of ['sent', 'uncertain'] as const) {
      const { conversationId, messageId } = await conversationWith({ status })
      expect((await resend(conversationId, messageId)).status).toBe(409)
    }
  })

  test('refuses an AI reply while a colleague owns the conversation', async () => {
    const { conversationId, messageId } = await conversationWith({
      status: 'failed',
      senderType: 'ai',
      mode: 'human',
    })
    expect((await resend(conversationId, messageId)).status).toBe(409)
  })

  test('refuses a viewer, and a message outside the conversation named', async () => {
    const { conversationId, messageId } = await conversationWith({ status: 'failed' })
    expect((await resend(conversationId, messageId, fixture.viewer)).status).toBe(403)

    const other = await conversationWith({ status: 'failed' })
    expect((await resend(other.conversationId, messageId)).status).toBe(404)
  })
})
