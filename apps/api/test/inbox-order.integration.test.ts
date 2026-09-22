import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { loadEnv } from '@ci/config'
import { newId, schema } from '@ci/db'
import { eq } from 'drizzle-orm'
import { createApp } from '../src/app'
import { createApiContext } from '../src/context'
import { type ApiFixture, createApiFixture } from './helpers/session'

/**
 * The order the inbox arrives in.
 *
 * Two rules, and the first beats the second: your customers, then customers nobody has
 * claimed, then everybody else's; and inside each of those, whoever has been waiting
 * longest. The second rule is the one that used to live in the browser, so these assertions
 * are also what stops it quietly moving back there.
 */

const env = { ...loadEnv(), TOOL_EGRESS_ALLOW_PRIVATE: false }
const ctx = createApiContext(env)
const app = createApp(ctx)

let fixture: ApiFixture
let channelId: string

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000)

beforeAll(async () => {
  fixture = await createApiFixture(ctx, app)
  const channels = await ctx.db
    .select({ id: schema.channels.id })
    .from(schema.channels)
    .where(eq(schema.channels.workspaceId, fixture.workspaceId))
  channelId = channels.find((row) => row.id)?.id ?? ''
})

afterAll(async () => {
  await fixture.cleanup()
  await ctx.runtime.close()
})

/**
 * One customer with one conversation. `lastCustomerMessageAt` at or after `lastMessageAt`
 * is what "the customer spoke last and nobody has answered" looks like in a row.
 */
async function seed(input: {
  name: string
  owner: string | null
  customerSpokeAt: Date
  answeredAt?: Date
  mode?: 'ai' | 'waiting_human'
  waitingSince?: Date
}): Promise<{ customerId: string; conversationId: string }> {
  const customerId = newId()
  await ctx.db.insert(schema.customers).values({
    id: customerId,
    workspaceId: fixture.workspaceId,
    displayName: input.name,
    primaryLanguage: 'th',
    fields: {},
    assigneeUserId: input.owner,
  })

  const identityId = newId()
  await ctx.db.insert(schema.channelIdentities).values({
    id: identityId,
    workspaceId: fixture.workspaceId,
    channelId,
    // Random, not a slice of the id: a UUIDv7 begins with a timestamp, so two rows made in
    // the same millisecond collide on the channel's unique external id.
    externalId: `order-${Math.random().toString(36).slice(2, 12)}`,
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
    lastCustomerMessageAt: input.customerSpokeAt,
    lastMessageAt: input.answeredAt ?? input.customerSpokeAt,
    ...(input.waitingSince ? { waitingHumanSince: input.waitingSince } : {}),
  })

  return { customerId, conversationId }
}

const namesInOrder = async (actor = fixture.admin): Promise<string[]> => {
  const response = await fixture.as(actor, '/api/v1/conversations?limit=100')
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    conversations: { customer: { displayName: string | null } }[]
  }
  return body.conversations.map((row) => row.customer.displayName ?? '')
}

describe('who owns the customer decides the group', () => {
  test('puts yours first, then unclaimed, then whoever else owns one', async () => {
    // Deliberately seeded in the wrong order, and with the colleague waiting longest, so
    // that ownership is the only thing that can produce the expected result.
    await seed({ name: 'theirs', owner: fixture.agent.userId, customerSpokeAt: minutesAgo(600) })
    await seed({ name: 'nobody', owner: null, customerSpokeAt: minutesAgo(300) })
    await seed({ name: 'mine', owner: fixture.admin.userId, customerSpokeAt: minutesAgo(5) })

    expect(await namesInOrder()).toEqual(['mine', 'nobody', 'theirs'])
  })

  test('reads differently for each person, which is the point', async () => {
    // The same three rows, seen by the colleague: now theirs is first.
    expect(await namesInOrder(fixture.agent)).toEqual(['theirs', 'nobody', 'mine'])
  })
})

describe('inside a group, longest wait first', () => {
  test('orders by how long the customer has been waiting', async () => {
    await ctx.db
      .delete(schema.customers)
      .where(eq(schema.customers.workspaceId, fixture.workspaceId))

    await seed({ name: 'waiting-20m', owner: null, customerSpokeAt: minutesAgo(20) })
    await seed({ name: 'waiting-90m', owner: null, customerSpokeAt: minutesAgo(90) })
    await seed({ name: 'waiting-5m', owner: null, customerSpokeAt: minutesAgo(5) })

    expect(await namesInOrder()).toEqual(['waiting-90m', 'waiting-20m', 'waiting-5m'])
  })

  test('sinks a conversation somebody has already answered below every waiting one', async () => {
    await ctx.db
      .delete(schema.customers)
      .where(eq(schema.customers.workspaceId, fixture.workspaceId))

    // Answered two minutes ago, so nobody is waiting on it, however recent it is.
    await seed({
      name: 'answered',
      owner: null,
      customerSpokeAt: minutesAgo(10),
      answeredAt: minutesAgo(2),
    })
    await seed({ name: 'waiting', owner: null, customerSpokeAt: minutesAgo(8) })

    expect(await namesInOrder()).toEqual(['waiting', 'answered'])
  })

  /**
   * A conversation handed to a person is waiting even though the AI spoke last, because it
   * usually said "one moment". Before this it would have been sorted as answered and sunk,
   * which is exactly the queue agents work from.
   */
  test('counts a conversation waiting for a human from when it was handed over', async () => {
    await ctx.db
      .delete(schema.customers)
      .where(eq(schema.customers.workspaceId, fixture.workspaceId))

    await seed({
      name: 'handed-over',
      owner: null,
      customerSpokeAt: minutesAgo(30),
      answeredAt: minutesAgo(29),
      mode: 'waiting_human',
      waitingSince: minutesAgo(29),
    })
    await seed({ name: 'waiting-3m', owner: null, customerSpokeAt: minutesAgo(3) })

    expect(await namesInOrder()).toEqual(['handed-over', 'waiting-3m'])
  })
})

describe('assigning a customer', () => {
  test('is refused to a viewer and allowed to an agent', async () => {
    const { customerId } = await seed({
      name: 'to-assign',
      owner: null,
      customerSpokeAt: minutesAgo(1),
    })

    const asViewer = await fixture.as(fixture.viewer, `/api/v1/customers/${customerId}`, {
      method: 'PATCH',
      body: JSON.stringify({ assigneeUserId: fixture.viewer.userId }),
    })
    expect(asViewer.status).toBe(403)

    const asAgent = await fixture.as(fixture.agent, `/api/v1/customers/${customerId}`, {
      method: 'PATCH',
      body: JSON.stringify({ assigneeUserId: fixture.agent.userId }),
    })
    expect(asAgent.status).toBe(200)
  })

  /**
   * Otherwise an owner could be parked on somebody from another tenant, who would then be
   * named in this workspace's inbox while being unable to open it.
   */
  test('refuses somebody who is not in this workspace', async () => {
    const { customerId } = await seed({
      name: 'stranger',
      owner: null,
      customerSpokeAt: minutesAgo(1),
    })
    const other = await createApiFixture(ctx, app)
    try {
      const response = await fixture.as(fixture.admin, `/api/v1/customers/${customerId}`, {
        method: 'PATCH',
        body: JSON.stringify({ assigneeUserId: other.admin.userId }),
      })
      expect(response.status).toBe(400)
    } finally {
      await other.cleanup()
    }
  })

  test('refuses a customer in another workspace, and does not say which', async () => {
    const other = await createApiFixture(ctx, app)
    try {
      const strangerCustomerId = newId()
      await ctx.db.insert(schema.customers).values({
        id: strangerCustomerId,
        workspaceId: other.workspaceId,
        displayName: 'not yours',
        primaryLanguage: 'th',
        fields: {},
      })

      const response = await fixture.as(fixture.admin, `/api/v1/customers/${strangerCustomerId}`, {
        method: 'PATCH',
        body: JSON.stringify({ assigneeUserId: fixture.admin.userId }),
      })
      expect(response.status).toBe(404)
    } finally {
      await other.cleanup()
    }
  })

  test('lets a customer go again', async () => {
    const { customerId } = await seed({
      name: 'released',
      owner: fixture.admin.userId,
      customerSpokeAt: minutesAgo(1),
    })

    const response = await fixture.as(fixture.admin, `/api/v1/customers/${customerId}`, {
      method: 'PATCH',
      body: JSON.stringify({ assigneeUserId: null }),
    })
    expect(response.status).toBe(200)

    const rows = await ctx.db
      .select({ assigneeUserId: schema.customers.assigneeUserId })
      .from(schema.customers)
      .where(eq(schema.customers.id, customerId))
    expect(rows[0]?.assigneeUserId).toBeNull()
  })
})

describe('the message window', () => {
  /**
   * The thread used to take the first two hundred messages, so a long conversation showed
   * its opening and hid everything an agent needed. Conversations live longer now that a
   * returning customer reopens one, which turned that from an edge case into the normal one.
   */
  const seedMessages = async (conversationId: string, count: number) => {
    for (let index = 0; index < count; index += 1) {
      await ctx.db.insert(schema.messages).values({
        id: newId(),
        workspaceId: fixture.workspaceId,
        conversationId,
        direction: 'inbound',
        senderType: 'customer',
        content: { kind: 'text', text: `message ${index}` },
        text: `message ${index}`,
        status: 'sent',
        createdAt: new Date(Date.now() - (count - index) * 60_000),
      })
    }
  }

  const windowOf = async (conversationId: string, size?: number) => {
    const path = `/api/v1/conversations/${conversationId}${size ? `?messages=${size}` : ''}`
    const response = await fixture.as(fixture.admin, path)
    expect(response.status).toBe(200)
    return (await response.json()) as {
      messages: { text: string | null }[]
      hasMoreMessages: boolean
    }
  }

  test('returns the newest thirty, oldest first, and says there is more', async () => {
    const { conversationId } = await seed({
      name: 'long-thread',
      owner: null,
      customerSpokeAt: minutesAgo(1),
    })
    await seedMessages(conversationId, 45)

    const body = await windowOf(conversationId)
    expect(body.messages).toHaveLength(30)
    expect(body.hasMoreMessages).toBe(true)

    // The newest end of the thread, read in the order a person reads it.
    expect(body.messages[0]?.text).toBe('message 15')
    expect(body.messages.at(-1)?.text).toBe('message 44')
  })

  test('reaches further back when asked, and stops claiming there is more', async () => {
    const { conversationId } = await seed({
      name: 'long-thread-2',
      owner: null,
      customerSpokeAt: minutesAgo(1),
    })
    await seedMessages(conversationId, 45)

    const sixty = await windowOf(conversationId, 60)
    expect(sixty.messages).toHaveLength(45)
    expect(sixty.hasMoreMessages).toBe(false)
    expect(sixty.messages[0]?.text).toBe('message 0')
    expect(sixty.messages.at(-1)?.text).toBe('message 44')
  })

  test('says there is nothing more when the thread is short', async () => {
    const { conversationId } = await seed({
      name: 'short-thread',
      owner: null,
      customerSpokeAt: minutesAgo(1),
    })
    await seedMessages(conversationId, 4)

    const body = await windowOf(conversationId)
    expect(body.messages).toHaveLength(4)
    expect(body.hasMoreMessages).toBe(false)
  })
})
