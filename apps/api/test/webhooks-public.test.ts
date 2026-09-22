import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { loadEnv } from '@ci/config'
import { createWorkspace, encryptJson, schema } from '@ci/db'
import { and, eq } from 'drizzle-orm'
import { createApp } from '../src/app'
import { createApiContext } from '../src/context'

/**
 * Who may reach ingestion through the public webhook route.
 *
 * Only a channel whose adapter can prove where a request came from, which means a platform
 * signature over the exact bytes received. The web and test channels cannot, and a web
 * channel's id is printed in the embed code on the host's own page — so for a while anybody
 * who viewed source could post a message as any visitor and, worse, assert in the body who
 * that visitor was. The identity went onto the channel identity row and was bound into the
 * tenant's tool calls from there.
 */

const env = { ...loadEnv(), TOOL_EGRESS_ALLOW_PRIVATE: false }
const ctx = createApiContext(env)
const app = createApp(ctx)

let workspaceId: string
let webChannelId: string
let testChannelId: string
const slug = `hook-${Math.random().toString(36).slice(2, 8)}`

beforeAll(async () => {
  workspaceId = (await createWorkspace(ctx.db, { name: slug, slug })).workspaceId

  const channels = await ctx.db
    .select({ id: schema.channels.id, type: schema.channels.type })
    .from(schema.channels)
    .where(eq(schema.channels.workspaceId, workspaceId))
  webChannelId = channels.find((row) => row.type === 'web')?.id ?? ''
  testChannelId = channels.find((row) => row.type === 'test')?.id ?? ''
})

afterAll(async () => {
  await ctx.db.delete(schema.organization).where(eq(schema.organization.id, workspaceId))
  await ctx.runtime.close()
})

const postWebhook = (channelId: string, body: unknown, headers: Record<string, string> = {}) =>
  app.handle(
    new Request(`http://localhost/api/v1/webhooks/${channelId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  )

const eventsFor = async (channelId: string) =>
  ctx.db
    .select({ id: schema.inboundEvents.id })
    .from(schema.inboundEvents)
    .where(eq(schema.inboundEvents.channelId, channelId))

const visitorMessage = (text: string) => ({
  visitorId: 'host:victim-account',
  message: { kind: 'text', text },
  eventId: `forged-${crypto.randomUUID()}`,
})

describe('the public webhook route', () => {
  test('does not serve a web channel', async () => {
    const response = await postWebhook(webChannelId, visitorMessage('let me in'))
    expect(response.status).toBe(404)
    expect(await eventsFor(webChannelId)).toHaveLength(0)
  })

  /**
   * An `Origin` header is a browser's courtesy, not a credential: any client can send one.
   * The old web adapter checked exactly this and let the request through.
   */
  test('does not serve a web channel to a caller claiming an allowed origin', async () => {
    const response = await postWebhook(webChannelId, visitorMessage('nor me'), {
      origin: 'https://salon-saas.example',
    })
    expect(response.status).toBe(404)
    expect(await eventsFor(webChannelId)).toHaveLength(0)
  })

  test('does not serve a test channel', async () => {
    const response = await postWebhook(testChannelId, {
      externalId: 'sim-1',
      message: { kind: 'text', text: 'free AI turns please' },
    })
    expect(response.status).toBe(404)
    expect(await eventsFor(testChannelId)).toHaveLength(0)
  })

  test('answers for a channel that does not exist in the same words', async () => {
    const response = await postWebhook(crypto.randomUUID(), visitorMessage('anyone home'))
    expect(response.status).toBe(404)
  })

  /**
   * The forged request this closes. Left open, the identity lands on the row the real
   * widget session would use, because `host:<sub>` is the externalId the session route
   * mints, and the next AI turn binds that subject into the tenant's tools.
   */
  test('cannot plant a verified identity on a widget visitor', async () => {
    await postWebhook(webChannelId, {
      ...visitorMessage('hello'),
      verified: { subject: 'victim-account', attributes: {}, via: 'widget_token' },
    })

    const identities = await ctx.db
      .select({ verifiedSubject: schema.channelIdentities.verifiedSubject })
      .from(schema.channelIdentities)
      .where(
        and(
          eq(schema.channelIdentities.workspaceId, workspaceId),
          eq(schema.channelIdentities.externalId, 'host:victim-account'),
        ),
      )
    expect(identities).toHaveLength(0)
  })
})

describe('the widget route', () => {
  /**
   * The legitimate path, and the one that was broken: the message route used to call the
   * public entry with an empty header map, so a tenant that filled in `allowedOrigins` got
   * a session and then a refusal on every message.
   */
  test('accepts a message on a session, and ignores a verified block in the body', async () => {
    const session = await app.handle(
      new Request(`http://localhost/api/widget/${webChannelId}/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visitorId: 'anon-visitor-1' }),
      }),
    )
    expect(session.status).toBe(200)
    const { session: token } = (await session.json()) as { session: string }

    const sent = await app.handle(
      new Request(`http://localhost/api/widget/${webChannelId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-widget-session': token },
        body: JSON.stringify({
          text: 'I have a question',
          // Not part of the route's schema, and it would be dropped even if it were: the
          // proof travels in the envelope `ingestInternal` writes.
          verified: { subject: 'somebody-else', attributes: {}, via: 'widget_token' },
        }),
      }),
    )
    expect(sent.status).toBe(200)

    const identities = await ctx.db
      .select({ verifiedSubject: schema.channelIdentities.verifiedSubject })
      .from(schema.channelIdentities)
      .where(
        and(
          eq(schema.channelIdentities.workspaceId, workspaceId),
          eq(schema.channelIdentities.externalId, 'anon:anon-visitor-1'),
        ),
      )
    expect(identities[0]?.verifiedSubject ?? null).toBeNull()
  })

  test('refuses a message with no session', async () => {
    const response = await app.handle(
      new Request(`http://localhost/api/widget/${webChannelId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'no session here' }),
      }),
    )
    expect(response.status).toBe(401)
  })
})

describe('a tenant that restricts which sites may embed the widget', () => {
  const ALLOWED = 'https://salon-saas.example'

  beforeAll(async () => {
    await ctx.db
      .update(schema.channels)
      .set({
        configEncrypted: await encryptJson(
          { visitorTokenSecret: null, allowedOrigins: [ALLOWED] },
          env.APP_SECRET_KEY,
        ),
      })
      .where(eq(schema.channels.id, webChannelId))
  })

  /**
   * The regression this releases. The message route used to call the public entry with an
   * empty header map, so the web adapter looked for an `Origin` that was never there and
   * refused: a tenant who filled in this field could open a widget and never send from it.
   * Nobody noticed because the pilot allows every origin.
   */
  test('can still hold a conversation from an allowed origin', async () => {
    const session = await app.handle(
      new Request(`http://localhost/api/widget/${webChannelId}/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ALLOWED },
        body: JSON.stringify({ visitorId: 'anon-restricted-1' }),
      }),
    )
    expect(session.status).toBe(200)
    const { session: token } = (await session.json()) as { session: string }

    const sent = await app.handle(
      new Request(`http://localhost/api/widget/${webChannelId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-widget-session': token },
        body: JSON.stringify({ text: 'does this reach you?' }),
      }),
    )
    expect(sent.status).toBe(200)
  })

  test('refuses a session from an origin it does not list', async () => {
    const session = await app.handle(
      new Request(`http://localhost/api/widget/${webChannelId}/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://not-invited.example' },
        body: JSON.stringify({ visitorId: 'anon-restricted-2' }),
      }),
    )
    expect(session.status).toBe(403)
  })
})
