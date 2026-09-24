import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { loadEnv } from '@ci/config'
import { newId, schema } from '@ci/db'
import { eq } from 'drizzle-orm'
import { createApp } from '../src/app'
import { createApiContext } from '../src/context'
import { type ApiFixture, createApiFixture } from './helpers/session'

/**
 * U03: finding a conversation. An agent looking for a customer has a name, a phone number
 * or something that was said, and used to have only the scroll bar.
 */

const env = { ...loadEnv(), TOOL_EGRESS_ALLOW_PRIVATE: false }
const ctx = createApiContext(env)
const app = createApp(ctx)

let fixture: ApiFixture
let channelId: string
const token = Math.random().toString(36).slice(2, 8)

beforeAll(async () => {
  fixture = await createApiFixture(ctx, app)
  const channels = await ctx.db
    .select({ id: schema.channels.id })
    .from(schema.channels)
    .where(eq(schema.channels.workspaceId, fixture.workspaceId))
  channelId = channels[0]?.id ?? ''

  await seed(`Somchai ${token}`, { phone: '0812345678' }, ['สนใจแพ็กเกจรายปีค่ะ'])
  await seed(`Nok ${token}`, {}, ['ลดราคา 100% จริงไหม'])
  await seed(`Ploy ${token}`, {}, ['hello there'])
})

afterAll(async () => {
  await fixture.cleanup()
  await ctx.runtime.close()
})

async function seed(name: string, fields: Record<string, string>, texts: string[]) {
  const customerId = newId()
  await ctx.db.insert(schema.customers).values({
    id: customerId,
    workspaceId: fixture.workspaceId,
    displayName: name,
    fields,
  })
  const identityId = newId()
  await ctx.db.insert(schema.channelIdentities).values({
    id: identityId,
    workspaceId: fixture.workspaceId,
    channelId,
    externalId: `search-${Math.random().toString(36).slice(2, 12)}`,
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
    mode: 'ai',
    status: 'open',
  })
  for (const text of texts) {
    await ctx.db.insert(schema.messages).values({
      id: newId(),
      workspaceId: fixture.workspaceId,
      conversationId,
      direction: 'inbound',
      senderType: 'customer',
      content: { kind: 'text', text },
      text,
      status: 'sent',
    })
  }
}

const namesFor = async (q: string): Promise<string[]> => {
  const response = await fixture.as(
    fixture.agent,
    `/api/v1/conversations?limit=100&q=${encodeURIComponent(q)}`,
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    conversations: { customer: { displayName: string | null } }[]
  }
  return body.conversations.map((row) => row.customer.displayName ?? '').sort()
}

describe('searching the inbox', () => {
  test('finds a customer by name, by identifier and by something they said', async () => {
    expect(await namesFor(`somchai ${token}`)).toEqual([`Somchai ${token}`])
    expect(await namesFor('0812345')).toEqual([`Somchai ${token}`])
    expect(await namesFor('แพ็กเกจรายปี')).toEqual([`Somchai ${token}`])
  })

  test('treats % and _ as the characters they are', async () => {
    expect(await namesFor('100%')).toEqual([`Nok ${token}`])
    expect(await namesFor('%%')).toEqual([])
  })

  test('refuses a one-character search rather than listing everything', async () => {
    const response = await fixture.as(fixture.agent, '/api/v1/conversations?q=a')
    expect(response.status).toBe(422)
  })
})
