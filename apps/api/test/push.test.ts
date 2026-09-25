import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createECDH } from 'node:crypto'
import { loadEnv } from '@ci/config'
import { silentLogger } from '@ci/core'
import { newId, schema } from '@ci/db'
import { createEffectPorts, type PushJob, sendPush, vapidKeys, vapidSubject } from '@ci/infra'
import { and, eq, like } from 'drizzle-orm'
import { createApp } from '../src/app'
import { createApiContext } from '../src/context'
import { type ApiActor, type ApiFixture, createApiFixture } from './helpers/session'

/**
 * Notifications on agents' devices (ADR 0010): who may subscribe, where the worker may
 * post, and who is told about what.
 */

function keyPair(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return {
    publicKey: ecdh.getPublicKey().toString('base64url'),
    privateKey: ecdh.getPrivateKey().toString('base64url'),
  }
}

const vapid = keyPair()
const env = {
  ...loadEnv(),
  TOOL_EGRESS_ALLOW_PRIVATE: false,
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
}
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

/** A subscription as a browser would post it, on a push service's host. */
function device(host = 'fcm.googleapis.com') {
  const keys = keyPair()
  return {
    endpoint: `https://${host}/fcm/send/${newId()}`,
    keys: {
      p256dh: keys.publicKey,
      auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url'),
    },
  }
}

async function subscribe(actor: ApiActor, subscription = device()) {
  const response = await fixture.as(actor, '/api/v1/push/subscriptions', {
    method: 'POST',
    body: JSON.stringify(subscription),
  })
  return { response, subscription }
}

async function devicesOf(userId: string): Promise<string[]> {
  const rows = await ctx.db
    .select({ endpoint: schema.pushSubscriptions.endpoint })
    .from(schema.pushSubscriptions)
    .where(
      and(
        eq(schema.pushSubscriptions.workspaceId, fixture.workspaceId),
        eq(schema.pushSubscriptions.userId, userId),
      ),
    )
  return rows.map((row) => row.endpoint)
}

async function clearDevices() {
  await ctx.db
    .delete(schema.pushSubscriptions)
    .where(eq(schema.pushSubscriptions.workspaceId, fixture.workspaceId))
}

async function conversation(input: {
  mode: 'ai' | 'human' | 'waiting_human' | 'ai_supervised'
  status?: 'open' | 'resolved'
  assigneeUserId?: string | null
  said?: string
}): Promise<{ conversationId: string; messageId: string }> {
  const customerId = newId()
  await ctx.db.insert(schema.customers).values({
    id: customerId,
    workspaceId: fixture.workspaceId,
    displayName: 'Khun Push',
    fields: {},
  })
  const identityId = newId()
  await ctx.db.insert(schema.channelIdentities).values({
    id: identityId,
    workspaceId: fixture.workspaceId,
    channelId,
    externalId: `push-${newId()}`,
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
    mode: input.mode,
    status: input.status ?? 'open',
    assigneeUserId: input.assigneeUserId ?? null,
  })
  const messageId = newId()
  const text = input.said ?? 'ขอคุยกับพนักงานค่ะ'
  await ctx.db.insert(schema.messages).values({
    id: messageId,
    workspaceId: fixture.workspaceId,
    conversationId,
    direction: 'inbound',
    senderType: 'customer',
    content: { kind: 'text', text },
    text,
  })
  return { conversationId, messageId }
}

/** Every post the worker would have made, answered with `status`. */
function recorder(status = 201) {
  const posts: { url: string; headers: Record<string, string> }[] = []
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    posts.push({ url: String(url), headers: init?.headers as Record<string, string> })
    return new Response(null, { status })
  }) as typeof fetch
  return { posts, fake }
}

function deps(fake: typeof fetch) {
  const keys = vapidKeys(env)
  if (!keys) throw new Error('test env has no VAPID keys')
  return { db: ctx.db, vapid: keys, subject: vapidSubject(env), logger: silentLogger, fetch: fake }
}

describe('subscribing', () => {
  test('the console is told the public key', async () => {
    const response = await fixture.as(fixture.viewer, '/api/v1/push/config')
    expect(await response.json()).toEqual({ publicKey: vapid.publicKey })
  })

  test('an agent subscribes a device, and can ask whether it is', async () => {
    await clearDevices()
    const { response, subscription } = await subscribe(fixture.agent)
    expect(response.status).toBe(200)
    expect(await devicesOf(fixture.agent.userId)).toEqual([subscription.endpoint])

    const check = await fixture.as(fixture.agent, '/api/v1/push/check', {
      method: 'POST',
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    })
    expect(await check.json()).toEqual({ subscribed: true })
  })

  test('a viewer cannot, since they could not answer what woke them', async () => {
    const { response } = await subscribe(fixture.viewer)
    expect(response.status).toBe(403)
  })

  test('an endpoint that is not a push service is refused before it is stored', async () => {
    for (const host of ['10.0.0.5', 'internal.example', 'fcm.googleapis.com.evil.example']) {
      const { response } = await subscribe(fixture.agent, device(host))
      expect(response.status).toBe(422)
    }
  })

  test('one device is one person: a colleague subscribing it takes it over', async () => {
    await clearDevices()
    const { subscription } = await subscribe(fixture.agent)
    await subscribe(fixture.admin, subscription)
    expect(await devicesOf(fixture.agent.userId)).toEqual([])
    expect(await devicesOf(fixture.admin.userId)).toEqual([subscription.endpoint])
  })

  test('unsubscribing removes only the caller’s own row', async () => {
    await clearDevices()
    const { subscription } = await subscribe(fixture.admin)
    await fixture.as(fixture.agent, '/api/v1/push/subscriptions', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    })
    expect(await devicesOf(fixture.admin.userId)).toHaveLength(1)

    await fixture.as(fixture.admin, '/api/v1/push/subscriptions', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint: subscription.endpoint, everywhere: true }),
    })
    expect(await devicesOf(fixture.admin.userId)).toHaveLength(0)
  })
})

describe('sending', () => {
  test('a handoff reaches every agent and admin device, never a viewer', async () => {
    await clearDevices()
    await subscribe(fixture.agent)
    await subscribe(fixture.admin)
    // Written by hand: the route refuses a viewer, and a row from before that rule, or a
    // viewer demoted after subscribing, must still not be woken.
    const viewerDevice = device()
    await ctx.db.insert(schema.pushSubscriptions).values({
      id: newId(),
      workspaceId: fixture.workspaceId,
      userId: fixture.viewer.userId,
      endpoint: viewerDevice.endpoint,
      p256dh: viewerDevice.keys.p256dh,
      auth: viewerDevice.keys.auth,
    })

    const { conversationId, messageId } = await conversation({ mode: 'waiting_human' })
    const { posts, fake } = recorder()
    const outcome = await sendPush(deps(fake), {
      workspaceId: fixture.workspaceId,
      conversationId,
      reason: 'handoff',
      triggerMessageId: messageId,
    })

    expect(outcome.sent).toBe(2)
    expect(posts.map((post) => post.url)).not.toContain(viewerDevice.endpoint)
    // Encrypted, signed with our key, and collapsing per conversation on an offline device.
    const headers = posts[0]?.headers ?? {}
    expect(headers['Content-Encoding']).toBe('aes128gcm')
    expect(headers.Authorization).toContain(`k=${vapid.publicKey}`)
    expect(headers.Topic).toBe(conversationId.replaceAll('-', ''))
  })

  test('a customer writing to a held conversation tells only the colleague holding it', async () => {
    await clearDevices()
    const { subscription: agentDevice } = await subscribe(fixture.agent)
    await subscribe(fixture.admin)

    const { conversationId, messageId } = await conversation({
      mode: 'human',
      assigneeUserId: fixture.agent.userId,
    })
    const { posts, fake } = recorder()
    await sendPush(deps(fake), {
      workspaceId: fixture.workspaceId,
      conversationId,
      reason: 'customer_message',
      triggerMessageId: messageId,
    })
    expect(posts.map((post) => post.url)).toEqual([agentDevice.endpoint])
  })

  test('nothing is sent once nobody is owed anything', async () => {
    await clearDevices()
    await subscribe(fixture.agent)
    const { posts, fake } = recorder()

    const resolved = await conversation({ mode: 'waiting_human', status: 'resolved' })
    const taken = await conversation({ mode: 'human', assigneeUserId: fixture.agent.userId })
    for (const job of [
      { ...resolved, reason: 'handoff' as const },
      // A colleague took it before the push ran: the handoff is answered.
      { ...taken, reason: 'handoff' as const },
    ]) {
      const outcome = await sendPush(deps(fake), {
        workspaceId: fixture.workspaceId,
        conversationId: job.conversationId,
        reason: job.reason,
      })
      expect(outcome.skipped).toBeDefined()
    }
    expect(posts).toHaveLength(0)
  })

  test('a device the push service says is gone is forgotten', async () => {
    await clearDevices()
    await subscribe(fixture.agent)
    const { conversationId } = await conversation({ mode: 'waiting_human' })
    const { fake } = recorder(410)
    const outcome = await sendPush(deps(fake), {
      workspaceId: fixture.workspaceId,
      conversationId,
      reason: 'timeout',
    })
    expect(outcome.gone).toBe(1)
    expect(await devicesOf(fixture.agent.userId)).toEqual([])
  })

  test('a stored endpoint off the list is never posted to', async () => {
    await clearDevices()
    await ctx.db.insert(schema.pushSubscriptions).values({
      id: newId(),
      workspaceId: fixture.workspaceId,
      userId: fixture.agent.userId,
      endpoint: 'https://10.0.0.5/push',
      p256dh: device().keys.p256dh,
      auth: 'x',
    })
    const { conversationId } = await conversation({ mode: 'waiting_human' })
    const { posts, fake } = recorder()
    await sendPush(deps(fake), {
      workspaceId: fixture.workspaceId,
      conversationId,
      reason: 'timeout',
    })
    expect(posts).toHaveLength(0)
    expect(await devicesOf(fixture.agent.userId)).toEqual([])
  })

  test('retried only when nothing arrived and every failure might pass', async () => {
    await clearDevices()
    await subscribe(fixture.agent)
    await subscribe(fixture.admin)
    const { conversationId } = await conversation({ mode: 'waiting_human' })
    const job: PushJob = { workspaceId: fixture.workspaceId, conversationId, reason: 'timeout' }

    await expect(sendPush(deps(recorder(503).fake), job)).rejects.toThrow('every device')

    // One arrived: a retry would buzz that phone twice, so the other is let go.
    let calls = 0
    const mixed = (async () => {
      calls += 1
      return new Response(null, { status: calls === 1 ? 201 : 503 })
    }) as unknown as typeof fetch
    const outcome = await sendPush(deps(mixed), job)
    expect(outcome).toMatchObject({ sent: 1, failed: 1 })
  })
})

describe('asking for a push', () => {
  test('notifyAgents queues one job named after the occasion', async () => {
    const { conversationId, messageId } = await conversation({ mode: 'waiting_human' })
    const ports = createEffectPorts(ctx.runtime, silentLogger)
    await ports.notifyAgents(
      { workspaceId: fixture.workspaceId, conversationId, triggerMessageId: messageId },
      'handoff',
      new Date(),
    )
    const rows = await ctx.db
      .select({ jobId: schema.outbox.jobId, queue: schema.outbox.queue })
      .from(schema.outbox)
      .where(like(schema.outbox.jobId, `push-%-${conversationId}-%`))
    expect(rows).toEqual([{ jobId: `push-handoff-${conversationId}-${messageId}`, queue: 'push' }])
  })

  // Last in the file: it removes the fixture's agent.
  test('removing a member forgets their devices here', async () => {
    await clearDevices()
    await subscribe(fixture.agent)
    const { subscription: adminDevice } = await subscribe(fixture.admin)

    const response = await fixture.as(
      fixture.admin,
      `/api/v1/admin/members/${fixture.agent.userId}`,
      { method: 'DELETE' },
    )
    expect(response.status).toBe(200)
    expect(await devicesOf(fixture.agent.userId)).toEqual([])
    expect(await devicesOf(fixture.admin.userId)).toEqual([adminDevice.endpoint])
  })
})
