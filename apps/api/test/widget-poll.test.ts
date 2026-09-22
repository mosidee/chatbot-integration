import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { loadEnv } from '@ci/config'
import { createWorkspace, newId, schema } from '@ci/db'
import type { NormalizedMessage } from '@ci/shared'
import { eq } from 'drizzle-orm'
import { createApp } from '../src/app'
import { createApiContext } from '../src/context'

/**
 * What a visitor's own browser is told about their conversation.
 *
 * The widget is the one surface with no session, no socket and no second chance: if this
 * response does not say that a person is coming, nothing else will, and the visitor sits
 * watching a thread that has stopped. It also has to hand back the *end* of a long
 * conversation rather than its beginning, which is the bug that made a returning
 * visitor's chat look dead.
 */

const env = { ...loadEnv(), TOOL_EGRESS_ALLOW_PRIVATE: false }
const ctx = createApiContext(env)
const app = createApp(ctx)

let workspaceId: string
let channelId: string
let conversationId: string
let session: string
const slug = `poll-${Math.random().toString(36).slice(2, 8)}`
const VISITOR = 'anon:poll-visitor'

/** Put a message in the visitor's conversation without going through ingestion. */
async function say(input: {
  direction: 'inbound' | 'outbound'
  senderType: 'customer' | 'ai' | 'human' | 'system'
  text: string
  kind?: string
  createdAt?: Date
}): Promise<string> {
  const id = newId()
  await ctx.db.insert(schema.messages).values({
    id,
    workspaceId,
    conversationId,
    direction: input.direction,
    senderType: input.senderType,
    // An 'event' row is not a NormalizedMessage the schema knows how to build, and writing
    // one is the point of that test: they must never reach a visitor's thread.
    content: { kind: input.kind ?? 'text', text: input.text } as NormalizedMessage,
    text: input.text,
    status: 'sent',
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  })
  return id
}

const poll = async (since?: string) =>
  app.handle(
    new Request(
      `http://localhost/api/widget/${channelId}/messages${since ? `?since=${encodeURIComponent(since)}` : ''}`,
      { headers: { 'x-widget-session': session } },
    ),
  )

beforeAll(async () => {
  workspaceId = (await createWorkspace(ctx.db, { name: slug, slug })).workspaceId

  const channels = await ctx.db
    .select({ id: schema.channels.id, type: schema.channels.type })
    .from(schema.channels)
    .where(eq(schema.channels.workspaceId, workspaceId))
  channelId = channels.find((row) => row.type === 'web')?.id ?? ''

  const started = await app.handle(
    new Request(`http://localhost/api/widget/${channelId}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visitorId: 'poll-visitor' }),
    }),
  )
  session = ((await started.json()) as { session: string }).session

  // A conversation for this visitor, built directly so the test owns its message order.
  const customerId = newId()
  await ctx.db
    .insert(schema.customers)
    .values({ id: customerId, workspaceId, displayName: 'Poll visitor' })
  const identityId = newId()
  await ctx.db.insert(schema.channelIdentities).values({
    id: identityId,
    workspaceId,
    channelId,
    customerId,
    externalId: VISITOR,
  })
  conversationId = newId()
  await ctx.db.insert(schema.conversations).values({
    id: conversationId,
    workspaceId,
    customerId,
    channelId,
    channelIdentityId: identityId,
    mode: 'ai',
    status: 'open',
  })
})

afterAll(async () => {
  await ctx.db.delete(schema.organization).where(eq(schema.organization.id, workspaceId))
  await ctx.runtime.close()
})

describe('what the widget is told', () => {
  test('says who wrote each message', async () => {
    await say({ direction: 'inbound', senderType: 'customer', text: 'ราคาเท่าไหร่' })
    await say({ direction: 'outbound', senderType: 'ai', text: 'เริ่มต้นที่ 99 บาทค่ะ' })
    await say({ direction: 'outbound', senderType: 'system', text: 'รอสักครู่นะคะ' })
    await say({ direction: 'outbound', senderType: 'human', text: 'สวัสดีครับ ผมดูแลต่อเองนะครับ' })

    const body = (await (await poll()).json()) as {
      messages: { sender: string; from: string }[]
    }

    expect(body.messages.map((m) => m.sender)).toEqual(['you', 'ai', 'system', 'agent'])
    // The old field still answers, for a loader cached on a tenant's page.
    expect(body.messages.map((m) => m.from)).toEqual(['you', 'support', 'support', 'support'])
  })

  test('says whether anybody is answering', async () => {
    const aiBody = (await (await poll()).json()) as { state: string; stateText: string | null }
    expect(aiBody.state).toBe('ai')
    // Nothing to say while the AI is answering: the replies speak for themselves.
    expect(aiBody.stateText).toBeNull()

    await ctx.db
      .update(schema.conversations)
      .set({ mode: 'waiting_human' })
      .where(eq(schema.conversations.id, conversationId))

    const waiting = (await (await poll()).json()) as { state: string; stateText: string | null }
    expect(waiting.state).toBe('waiting')
    expect(waiting.stateText).toBeTruthy()

    await ctx.db
      .update(schema.conversations)
      .set({ mode: 'human' })
      .where(eq(schema.conversations.id, conversationId))
    expect(((await (await poll()).json()) as { state: string }).state).toBe('human')
  })

  test('says it in the language the visitor is writing in', async () => {
    // A Thai-default workspace, an English-speaking visitor. Being told in Thai that a
    // colleague is coming, beside a reply in English, reads as a different product.
    await say({ direction: 'inbound', senderType: 'customer', text: 'can I speak to someone' })
    await ctx.db
      .update(schema.conversations)
      .set({ mode: 'waiting_human' })
      .where(eq(schema.conversations.id, conversationId))

    const body = (await (await poll()).json()) as { stateText: string }
    expect(body.stateText).toBe('Passing you to a colleague. One moment.')

    await ctx.db
      .update(schema.conversations)
      .set({ mode: 'ai' })
      .where(eq(schema.conversations.id, conversationId))
  })

  test('a supervised workspace still reads as the AI answering', async () => {
    // The customer does not need to know a colleague approves each reply, and telling them
    // would make a careful workspace look slower than a careless one.
    await ctx.db
      .update(schema.conversations)
      .set({ mode: 'ai_supervised' })
      .where(eq(schema.conversations.id, conversationId))
    expect(((await (await poll()).json()) as { state: string }).state).toBe('ai')

    await ctx.db
      .update(schema.conversations)
      .set({ mode: 'ai' })
      .where(eq(schema.conversations.id, conversationId))
  })

  test('internal events are not part of the visitor is view of their own conversation', async () => {
    const before = ((await (await poll()).json()) as { messages: unknown[] }).messages.length
    await say({ direction: 'outbound', senderType: 'system', text: '', kind: 'event' })
    const after = ((await (await poll()).json()) as { messages: unknown[] }).messages.length
    expect(after).toBe(before)
  })
})

describe('a visitor who has been chatting for a long time', () => {
  test('is handed the end of the conversation, not the beginning', async () => {
    // Forty more, each a minute apart and all later than anything already there, so the
    // order is unambiguous.
    const base = Date.now() + 60_000
    for (let index = 0; index < 40; index += 1) {
      await say({
        direction: 'inbound',
        senderType: 'customer',
        text: `message ${index}`,
        createdAt: new Date(base + index * 60_000),
      })
    }

    const body = (await (await poll()).json()) as { messages: { text: string }[] }

    /**
     * The failure this replaces: ascending order with a limit handed back the oldest
     * page, the cursor stuck at its last row, and every later poll returned the same
     * window while new replies piled up behind it.
     */
    expect(body.messages).toHaveLength(30)
    expect(body.messages.at(-1)?.text).toBe('message 39')
  })

  test('polling from a cursor moves forwards', async () => {
    const first = (await (await poll()).json()) as { messages: { text: string; at: string }[] }
    const cursor = first.messages.at(-1)?.at as string

    expect(((await (await poll(cursor)).json()) as { messages: unknown[] }).messages).toHaveLength(
      0,
    )

    // Later than the batch above, which the previous test dated into the near future so it
    // would sort last.
    await say({
      direction: 'outbound',
      senderType: 'ai',
      text: 'something new',
      createdAt: new Date(Date.parse(cursor) + 60_000),
    })
    const next = (await (await poll(cursor)).json()) as { messages: { text: string }[] }
    expect(next.messages.map((m) => m.text)).toEqual(['something new'])
  })
})

describe('a widget on a suspended tenant is site', () => {
  test('stops rendering rather than looking alive', async () => {
    await ctx.db
      .update(schema.workspaces)
      .set({ status: 'suspended' })
      .where(eq(schema.workspaces.id, workspaceId))

    const response = await poll()
    expect(response.status).toBe(403)
    expect(((await response.json()) as { code?: string }).code).toBe('workspace_suspended')

    await ctx.db
      .update(schema.workspaces)
      .set({ status: 'active' })
      .where(eq(schema.workspaces.id, workspaceId))
  })
})
