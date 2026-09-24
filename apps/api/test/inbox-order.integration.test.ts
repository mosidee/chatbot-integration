import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { loadEnv } from '@ci/config'
import { newId, schema } from '@ci/db'
import { signMediaUrl } from '@ci/infra'
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

describe('the channel a conversation is on', () => {
  /**
   * One person can hold a conversation on LINE and another on the widget, and the two rows
   * are otherwise identical at a glance. The console gets the channel with the conversation
   * rather than resolving it separately, because listing channels needs the agent role and
   * a viewer reads the same inbox.
   */
  test('comes back with every row in the list', async () => {
    const { conversationId } = await seed({
      name: 'channel-badge',
      owner: null,
      customerSpokeAt: minutesAgo(1),
    })

    const response = await fixture.as(fixture.admin, '/api/v1/conversations?limit=100')
    const body = (await response.json()) as {
      conversations: { id: string; channel: { type: string; name: string } }[]
    }
    const row = body.conversations.find((item) => item.id === conversationId)
    expect(row?.channel.type).toBe('test')
    expect(row?.channel.name).toBe('Simulator')
  })

  test('comes back with the conversation itself', async () => {
    const { conversationId } = await seed({
      name: 'channel-badge-detail',
      owner: null,
      customerSpokeAt: minutesAgo(1),
    })

    const response = await fixture.as(fixture.admin, `/api/v1/conversations/${conversationId}`)
    const body = (await response.json()) as { channel: { type: string; name: string } | null }
    expect(body.channel?.type).toBe('test')
  })

  test('is readable by a viewer, who cannot list channels at all', async () => {
    // The reason it travels with the conversation rather than being looked up.
    expect((await fixture.as(fixture.viewer, '/api/v1/settings/channels')).status).toBe(403)

    const response = await fixture.as(fixture.viewer, '/api/v1/conversations?limit=100')
    expect(response.status).toBe(200)
    const body = (await response.json()) as { conversations: { channel: { type: string } }[] }
    expect(body.conversations.every((row) => Boolean(row.channel?.type))).toBe(true)
  })
})

describe('sending a file to a customer', () => {
  /**
   * The whole path: an agent uploads, sends, and the file becomes a link a chat platform
   * can fetch without a session. The link is the only way LINE or Messenger can receive a
   * file at all, so the parts that make it safe are asserted rather than assumed.
   */
  const upload = async (name: string, mime: string, body: string) => {
    const form = new FormData()
    form.set('file', new File([body], name, { type: mime }))
    const response = await app.handle(
      new Request('http://localhost/api/v1/uploads', {
        method: 'POST',
        headers: { cookie: fixture.admin.cookie, origin: env.PUBLIC_WEB_URL },
        body: form,
      }),
    )
    return { status: response.status, body: await response.json() }
  }

  test('accepts a document, which the allowlist used to refuse', async () => {
    const pdf = await upload('invoice.pdf', 'application/pdf', '%PDF-1.4')
    expect(pdf.status).toBe(200)

    const docx = await upload(
      'quote.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'PK',
    )
    expect(docx.status).toBe(200)
  })

  test('still refuses something we should not relay', async () => {
    const zip = await upload('payload.zip', 'application/zip', 'PK')
    expect(zip.status).toBe(415)
  })

  test('serves the file to a caller with no session at all, given the link', async () => {
    const uploaded = await upload('receipt.pdf', 'application/pdf', '%PDF-receipt')
    const storageKey = (uploaded.body as { storageKey: string }).storageKey

    const link = await signMediaUrl({
      workspaceId: fixture.workspaceId,
      storageKey,
      fileName: 'receipt.pdf',
      secret: env.APP_SECRET_KEY,
      baseUrl: 'http://localhost',
      ttlDays: env.MEDIA_LINK_TTL_DAYS,
    })

    // No cookie: this is what LINE's fetcher looks like.
    const fetched = await app.handle(new Request(link))
    expect(fetched.status).toBe(200)
    expect(fetched.headers.get('content-type')).toContain('application/pdf')
    expect(await fetched.text()).toBe('%PDF-receipt')
  })

  test('refuses a link whose claims were edited', async () => {
    const uploaded = await upload('private.pdf', 'application/pdf', '%PDF-secret')
    const storageKey = (uploaded.body as { storageKey: string }).storageKey
    const link = await signMediaUrl({
      workspaceId: fixture.workspaceId,
      storageKey,
      secret: env.APP_SECRET_KEY,
      baseUrl: 'http://localhost',
      ttlDays: 7,
    })

    const [header, , signature] = link.split('/api/media/')[1]?.split('/')[0]?.split('.') ?? []
    const forged = btoa(JSON.stringify({ key: 'someone-else/file.pdf', exp: 9_999_999_999 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

    const response = await app.handle(
      new Request(`http://localhost/api/media/${header}.${forged}.${signature}/x.pdf`),
    )
    expect(response.status).toBe(404)
  })

  test('refuses a link for a file that is not there', async () => {
    const link = await signMediaUrl({
      workspaceId: 'nobody',
      storageKey: 'nobody/nothing.pdf',
      secret: env.APP_SECRET_KEY,
      baseUrl: 'http://localhost',
      ttlDays: 7,
    })
    expect((await app.handle(new Request(link))).status).toBe(404)
  })

  test('stores the file on the message, ready for the outbound job to sign', async () => {
    const uploaded = await upload('note.pdf', 'application/pdf', '%PDF-note')
    const storageKey = (uploaded.body as { storageKey: string }).storageKey
    const { conversationId } = await seed({
      name: 'file-recipient',
      owner: null,
      customerSpokeAt: minutesAgo(1),
    })

    const sent = await fixture.as(
      fixture.admin,
      `/api/v1/conversations/${conversationId}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({
          message: {
            kind: 'file',
            text: 'your invoice',
            attachments: [
              {
                storageKey,
                sourceUrl: null,
                mime: 'application/pdf',
                sizeBytes: 8,
                fileName: 'note.pdf',
                width: null,
                height: null,
                durationMs: null,
              },
            ],
          },
        }),
      },
    )
    expect(sent.status).toBe(200)

    const rows = await ctx.db
      .select({ content: schema.messages.content })
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
    const stored = rows
      .map((row) => row.content as { kind: string; attachments?: { storageKey: string }[] })
      .find((content) => content.kind === 'file')

    expect(stored?.attachments?.[0]?.storageKey).toBe(storageKey)
  })
})

/**
 * The badges on the Inbox in the navigation.
 *
 * Shown on every page, so they cannot be derived from the list the inbox loads; and they
 * must be this workspace's counts and nobody else's.
 */
describe('the inbox badges', () => {
  const counts = async (actor = fixture.admin): Promise<{ open: number; waiting: number }> => {
    const response = await fixture.as(actor, '/api/v1/conversations/counts')
    expect(response.status).toBe(200)
    return (await response.json()) as { open: number; waiting: number }
  }

  test('open counts open conversations and nothing else', async () => {
    const before = await counts()

    const { conversationId } = await seed({
      name: 'badge',
      owner: null,
      customerSpokeAt: minutesAgo(1),
    })
    expect((await counts()).open).toBe(before.open + 1)
    // Open with the AI answering: nobody is being waited for.
    expect((await counts()).waiting).toBe(before.waiting)

    // Resolving takes it off: there is nothing left in the Open tab.
    await ctx.db
      .update(schema.conversations)
      .set({ status: 'resolved' })
      .where(eq(schema.conversations.id, conversationId))
    expect((await counts()).open).toBe(before.open)
  })

  test('waiting counts conversations handed to a person, and drops when one is taken', async () => {
    const before = await counts()

    const { conversationId } = await seed({
      name: 'waiting badge',
      owner: null,
      customerSpokeAt: minutesAgo(2),
      mode: 'waiting_human',
      waitingSince: minutesAgo(2),
    })
    const during = await counts()
    expect(during.waiting).toBe(before.waiting + 1)
    // A waiting conversation is still an open one, so both badges move.
    expect(during.open).toBe(before.open + 1)

    // A colleague takes it over: still open, no longer waiting.
    await ctx.db
      .update(schema.conversations)
      .set({ mode: 'human', waitingHumanSince: null })
      .where(eq(schema.conversations.id, conversationId))
    const after = await counts()
    expect(after.waiting).toBe(before.waiting)
    expect(after.open).toBe(before.open + 1)
  })

  test('a conversation resolved while it waited is no longer waiting', async () => {
    // Resolving leaves the mode as it was. Counting the mode alone kept these on the red
    // badge forever, until it read higher than the blue one it is meant to be part of.
    const before = await counts()
    const { conversationId } = await seed({
      name: 'resolved while waiting',
      owner: null,
      customerSpokeAt: minutesAgo(3),
      mode: 'waiting_human',
      waitingSince: minutesAgo(3),
    })
    await ctx.db
      .update(schema.conversations)
      .set({ status: 'resolved' })
      .where(eq(schema.conversations.id, conversationId))

    const after = await counts()
    expect(after.waiting).toBe(before.waiting)
    expect(after.waiting).toBeLessThanOrEqual(after.open)
  })

  test('a viewer sees them too', async () => {
    // Reading the inbox is a viewer's whole job, so the badges that point at it are theirs.
    const response = await fixture.as(fixture.viewer, '/api/v1/conversations/counts')
    expect(response.status).toBe(200)
  })

  test("another workspace's conversations never reach them", async () => {
    const before = await counts()

    const other = await createApiFixture(ctx, app)
    const otherChannel = (
      await ctx.db
        .select({ id: schema.channels.id })
        .from(schema.channels)
        .where(eq(schema.channels.workspaceId, other.workspaceId))
    )[0]?.id as string
    const customerId = newId()
    await ctx.db.insert(schema.customers).values({
      id: customerId,
      workspaceId: other.workspaceId,
      displayName: 'elsewhere',
      fields: {},
    })
    const identityId = newId()
    await ctx.db.insert(schema.channelIdentities).values({
      id: identityId,
      workspaceId: other.workspaceId,
      channelId: otherChannel,
      externalId: `elsewhere-${Math.random().toString(36).slice(2, 12)}`,
      customerId,
      profile: {},
    })
    await ctx.db.insert(schema.conversations).values({
      id: newId(),
      workspaceId: other.workspaceId,
      channelId: otherChannel,
      customerId,
      channelIdentityId: identityId,
      mode: 'waiting_human',
      status: 'open',
    })

    expect(await counts()).toEqual(before)
    await other.cleanup()
  })
})
