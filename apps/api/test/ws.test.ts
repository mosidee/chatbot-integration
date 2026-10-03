import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { loadEnv } from '@ci/config'
import { newId, schema } from '@ci/db'
import { viewersOf } from '@ci/infra'
import { and, eq } from 'drizzle-orm'
import { createApp } from '../src/app'
import { createApiContext } from '../src/context'
import { type ApiFixture, createApiFixture } from './helpers/session'

/**
 * Recommendation #18: a socket is authorised for as long as it is open, not only when it
 * opens. Removing somebody from the workspace must end the live feed they were watching.
 */

const env = { ...loadEnv(), TOOL_EGRESS_ALLOW_PRIVATE: false }
const ctx = createApiContext(env)
const app = createApp(ctx)
let server: ReturnType<typeof app.listen>
let fixture: ApiFixture
let url: string

beforeAll(async () => {
  fixture = await createApiFixture(ctx, app)
  server = app.listen(0)
  url = `ws://localhost:${server.server?.port}/ws`
})

afterAll(async () => {
  await server.stop()
  await fixture.cleanup()
  await ctx.runtime.close()
})

type Opened = { socket: WebSocket; first: Promise<{ type: string }>; closed: Promise<number> }

function open(cookie: string, origin = env.PUBLIC_WEB_URL): Opened {
  // Bun's client accepts headers, which is how a browser's cookie and origin are simulated.
  const socket = new WebSocket(url, { headers: { cookie, origin } } as unknown as string[])
  const first = new Promise<{ type: string }>((resolve) => {
    socket.addEventListener('message', (event) => resolve(JSON.parse(String(event.data))), {
      once: true,
    })
  })
  const closed = new Promise<number>((resolve) => {
    socket.addEventListener('close', (event) => resolve(event.code))
  })
  return { socket, first, closed }
}

const within = <T>(promise: Promise<T>, ms = 5000) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms)),
  ])

async function makeConversation(): Promise<string> {
  const [channel] = await ctx.db
    .select({ id: schema.channels.id })
    .from(schema.channels)
    .where(eq(schema.channels.workspaceId, fixture.workspaceId))
    .limit(1)
  const customerId = newId()
  await ctx.db
    .insert(schema.customers)
    .values({ id: customerId, workspaceId: fixture.workspaceId, displayName: 'W' })
  const identityId = newId()
  await ctx.db.insert(schema.channelIdentities).values({
    id: identityId,
    workspaceId: fixture.workspaceId,
    channelId: channel?.id ?? '',
    customerId,
    externalId: `ws-${identityId}`,
  })
  const conversationId = newId()
  await ctx.db.insert(schema.conversations).values({
    id: conversationId,
    workspaceId: fixture.workspaceId,
    channelId: channel?.id ?? '',
    customerId,
    channelIdentityId: identityId,
    mode: 'human',
    status: 'open',
  })
  return conversationId
}

describe('the live socket', () => {
  test('opens for a member of the console origin', async () => {
    const { socket, first } = open(fixture.agent.cookie)
    expect((await within(first)).type).toBe('ready')
    socket.close()
  })

  test('refuses a page on another origin riding the cookie', async () => {
    const { closed } = open(fixture.agent.cookie, 'https://evil.example')
    expect(await within(closed)).toBe(4403)
  })

  test('records the conversation on screen, only one of its own, until it closes', async () => {
    const conversationId = await makeConversation()
    const watching = () =>
      viewersOf(ctx.runtime.redis, {
        workspaceId: fixture.workspaceId,
        conversationId,
        userIds: [fixture.agent.userId],
      })
    const eventually = async (want: boolean) => {
      for (let i = 0; i < 50; i += 1) {
        if ((await watching()).has(fixture.agent.userId) === want) return
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error(`viewing never became ${want}`)
    }

    const { socket, first, closed } = open(fixture.agent.cookie)
    expect((await within(first)).type).toBe('ready')
    socket.send(JSON.stringify({ type: 'viewing', conversationId }))
    await eventually(true)

    // An id from nowhere is not recorded, and does not disturb what was.
    socket.send(JSON.stringify({ type: 'viewing', conversationId: newId() }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect((await watching()).has(fixture.agent.userId)).toBe(true)

    socket.send(JSON.stringify({ type: 'viewing', conversationId: null }))
    await eventually(false)

    socket.send(JSON.stringify({ type: 'viewing', conversationId }))
    await eventually(true)
    socket.close()
    await within(closed)
    await eventually(false)
  })

  test("a colleague's typing reaches everyone else watching the workspace", async () => {
    const conversationId = await makeConversation()
    const typist = open(fixture.agent.cookie)
    const watcher = open(fixture.admin.cookie)
    expect((await within(typist.first)).type).toBe('ready')
    expect((await within(watcher.first)).type).toBe('ready')
    const seen = new Promise<{ type: string; conversationId?: string }>((resolve) => {
      watcher.socket.addEventListener('message', (event) => {
        const parsed = JSON.parse(String(event.data))
        if (parsed.type === 'typing') resolve(parsed)
      })
    })
    typist.socket.send(JSON.stringify({ type: 'typing', conversationId }))
    expect((await within(seen)).conversationId).toBe(conversationId)
    typist.socket.close()
    watcher.socket.close()
  })

  test('closes when the person is removed from the workspace', async () => {
    const { first, closed } = open(fixture.viewer.cookie)
    expect((await within(first)).type).toBe('ready')

    const removed = await fixture.as(
      fixture.admin,
      `/api/v1/admin/members/${fixture.viewer.userId}`,
      {
        method: 'DELETE',
      },
    )
    expect(removed.status).toBe(200)
    expect(await within(closed)).toBe(4403)

    // Put the fixture back for cleanup's sake.
    const rows = await ctx.db
      .select()
      .from(schema.member)
      .where(
        and(
          eq(schema.member.organizationId, fixture.workspaceId),
          eq(schema.member.userId, fixture.viewer.userId),
        ),
      )
    expect(rows).toHaveLength(0)
  })
})
