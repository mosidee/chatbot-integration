import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { loadEnv } from '@ci/config'
import { newId, schema } from '@ci/db'
import { normaliseTags } from '@ci/shared'
import { eq, sql } from 'drizzle-orm'
import { createApp } from '../src/app'
import { createApiContext } from '../src/context'
import { type ApiFixture, createApiFixture } from './helpers/session'

/**
 * Conversation tags: who may change them, how they are spelled, that a filter needs every
 * tag, and that one workspace never sees or touches another's.
 */

const ctx = createApiContext({ ...loadEnv(), TOOL_EGRESS_ALLOW_PRIVATE: false })
const app = createApp(ctx)

let fixture: ApiFixture
let other: ApiFixture

beforeAll(async () => {
  fixture = await createApiFixture(ctx, app)
  other = await createApiFixture(ctx, app)
})

afterAll(async () => {
  await fixture.cleanup()
  await other.cleanup()
  await ctx.runtime.close()
})

async function conversation(f: ApiFixture, tags: string[] = [], name = 'Khun Tag') {
  const [channel] = await ctx.db
    .select({ id: schema.channels.id })
    .from(schema.channels)
    .where(eq(schema.channels.workspaceId, f.workspaceId))
    .limit(1)
  const customerId = newId()
  await ctx.db.insert(schema.customers).values({
    id: customerId,
    workspaceId: f.workspaceId,
    displayName: name,
    fields: {},
  })
  const identityId = newId()
  await ctx.db.insert(schema.channelIdentities).values({
    id: identityId,
    workspaceId: f.workspaceId,
    channelId: channel?.id ?? '',
    externalId: `tag-${identityId}`,
    customerId,
    profile: {},
  })
  const id = newId()
  await ctx.db.insert(schema.conversations).values({
    id,
    workspaceId: f.workspaceId,
    channelId: channel?.id ?? '',
    customerId,
    channelIdentityId: identityId,
    mode: 'ai',
    status: 'open',
    tags,
  })
  return id
}

async function tagsOf(id: string): Promise<string[]> {
  const [row] = await ctx.db
    .select({ tags: schema.conversations.tags })
    .from(schema.conversations)
    .where(eq(schema.conversations.id, id))
  return row?.tags ?? []
}

const json = (body: unknown) => ({ body: JSON.stringify(body) })

async function listIds(f: ApiFixture, query: string): Promise<string[]> {
  const response = await f.as(f.agent, `/api/v1/conversations?status=open&limit=100&${query}`)
  expect(response.status).toBe(200)
  const body = (await response.json()) as { conversations: { id: string }[] }
  return body.conversations.map((row) => row.id)
}

describe('one conversation', () => {
  test('an agent adds and removes a tag, spelled one way', async () => {
    const id = await conversation(fixture)
    const added = await fixture.as(fixture.agent, `/api/v1/conversations/${id}/tags`, {
      method: 'POST',
      ...json({ tag: '  Late   Payment ' }),
    })
    expect(added.status).toBe(200)
    expect(((await added.json()) as { tags: string[] }).tags).toEqual(['late payment'])

    // The same tag in another spelling is already there.
    await fixture.as(fixture.agent, `/api/v1/conversations/${id}/tags`, {
      method: 'POST',
      ...json({ tag: 'LATE PAYMENT' }),
    })
    expect(await tagsOf(id)).toEqual(['late payment'])

    const removed = await fixture.as(fixture.agent, `/api/v1/conversations/${id}/tags`, {
      method: 'DELETE',
      ...json({ tag: 'Late Payment' }),
    })
    expect(removed.status).toBe(200)
    expect(await tagsOf(id)).toEqual([])
  })

  test('Thai and a slash survive, because the tag is in the body', async () => {
    const id = await conversation(fixture)
    await fixture.as(fixture.agent, `/api/v1/conversations/${id}/tags`, {
      method: 'POST',
      ...json({ tag: 'ราคา/แพ็กเกจ' }),
    })
    expect(await tagsOf(id)).toEqual(['ราคา/แพ็กเกจ'])
  })

  test('a card number typed into a tag is masked before it is stored', async () => {
    const id = await conversation(fixture)
    await fixture.as(fixture.agent, `/api/v1/conversations/${id}/tags`, {
      method: 'POST',
      ...json({ tag: 'card 4111 1111 1111 1111' }),
    })
    const [stored] = await tagsOf(id)
    expect(stored).toBeDefined()
    expect(stored).not.toContain('4111 1111 1111 1111')
  })

  test('an empty tag is refused', async () => {
    const id = await conversation(fixture)
    const response = await fixture.as(fixture.agent, `/api/v1/conversations/${id}/tags`, {
      method: 'POST',
      ...json({ tag: ' , ' }),
    })
    expect(response.status).toBe(422)
  })

  test('the twenty-first tag is refused, and one already there is not', async () => {
    const twenty = Array.from({ length: 20 }, (_, index) => `t${index}`)
    const id = await conversation(fixture, twenty)
    const refused = await fixture.as(fixture.agent, `/api/v1/conversations/${id}/tags`, {
      method: 'POST',
      ...json({ tag: 'one more' }),
    })
    expect(refused.status).toBe(409)
    const again = await fixture.as(fixture.agent, `/api/v1/conversations/${id}/tags`, {
      method: 'POST',
      ...json({ tag: 't3' }),
    })
    expect(again.status).toBe(200)
    expect(await tagsOf(id)).toEqual(twenty)
  })

  test('a viewer can read tags but not change them', async () => {
    const id = await conversation(fixture, ['vip'])
    const response = await fixture.as(fixture.viewer, `/api/v1/conversations/${id}/tags`, {
      method: 'POST',
      ...json({ tag: 'nope' }),
    })
    expect(response.status).toBe(403)
    const detail = await fixture.as(fixture.viewer, `/api/v1/conversations/${id}`)
    const body = (await detail.json()) as { conversation: { tags: string[] } }
    expect(body.conversation.tags).toEqual(['vip'])
  })

  test("another workspace's conversation is not found", async () => {
    const id = await conversation(other, ['theirs'])
    for (const method of ['POST', 'DELETE']) {
      const response = await fixture.as(fixture.agent, `/api/v1/conversations/${id}/tags`, {
        method,
        ...json({ tag: 'theirs' }),
      })
      expect(response.status).toBe(404)
    }
    expect(await tagsOf(id)).toEqual(['theirs'])
  })
})

describe('the inbox', () => {
  test('a filter of several tags needs all of them', async () => {
    const both = await conversation(fixture, ['refund', 'urgent'])
    const one = await conversation(fixture, ['refund'])
    const ids = await listIds(fixture, 'tag=Refund,urgent')
    expect(ids).toContain(both)
    expect(ids).not.toContain(one)
    const single = await listIds(fixture, 'tag=refund')
    expect(single).toEqual(expect.arrayContaining([both, one]))
  })

  test('the search box finds a conversation by part of a tag', async () => {
    const id = await conversation(fixture, ['onboarding-help'], 'Khun Search')
    expect(await listIds(fixture, 'q=boarding')).toContain(id)
  })

  test("the workspace's tags are counted, and only its own", async () => {
    await conversation(other, ['only-theirs'])
    await conversation(fixture, ['counted'])
    await conversation(fixture, ['counted'])
    // `/tags` is a route of its own, not a conversation called "tags".
    const response = await fixture.as(fixture.viewer, '/api/v1/conversations/tags')
    expect(response.status).toBe(200)
    const body = (await response.json()) as { tags: { tag: string; count: number }[] }
    expect(body.tags.find((row) => row.tag === 'counted')?.count).toBe(2)
    expect(body.tags.some((row) => row.tag === 'only-theirs')).toBe(false)
  })
})

describe('across the workspace', () => {
  test('an admin renames a tag, merging it into one that exists', async () => {
    const a = await conversation(fixture, ['refunds', 'vip'])
    const b = await conversation(fixture, ['refund', 'refunds'])
    const theirs = await conversation(other, ['refunds'])

    const response = await fixture.as(fixture.admin, '/api/v1/settings/tags', {
      method: 'PATCH',
      ...json({ from: 'refunds', to: 'Refund' }),
    })
    expect(response.status).toBe(200)
    expect(await tagsOf(a)).toEqual(['refund', 'vip'])
    expect(await tagsOf(b)).toEqual(['refund'])
    expect(await tagsOf(theirs)).toEqual(['refunds'])
  })

  test('an admin deletes a tag from every conversation, and only in their workspace', async () => {
    const a = await conversation(fixture, ['obsolete', 'keep'])
    const theirs = await conversation(other, ['obsolete'])
    const response = await fixture.as(fixture.admin, '/api/v1/settings/tags', {
      method: 'DELETE',
      ...json({ tag: 'obsolete' }),
    })
    expect(response.status).toBe(200)
    expect(await tagsOf(a)).toEqual(['keep'])
    expect(await tagsOf(theirs)).toEqual(['obsolete'])
  })

  test('an agent may not rename or delete across the workspace', async () => {
    const rename = await fixture.as(fixture.agent, '/api/v1/settings/tags', {
      method: 'PATCH',
      ...json({ from: 'vip', to: 'v' }),
    })
    expect(rename.status).toBe(403)
    const remove = await fixture.as(fixture.agent, '/api/v1/settings/tags', {
      method: 'DELETE',
      ...json({ tag: 'vip' }),
    })
    expect(remove.status).toBe(403)
  })
})

/**
 * Migration 0019 normalised the tags already stored, in SQL. This runs its statement over
 * awkward values and checks that what it left is exactly what `normaliseTags` would have
 * written, so the two rules cannot drift apart.
 */
test('the migration normalises stored tags exactly as normaliseTag does', async () => {
  const raw = [
    '  Billing ',
    'billing',
    'Late \t  Payment',
    'a,b',
    'ราคา/แพ็กเกจ',
    ' ',
    `${'Q'.repeat(45)} z`,
    'KBANK',
    'émoji 😀 Tag',
  ]
  const id = await conversation(fixture, raw)
  const file = Bun.file(
    new URL('../../../packages/db/drizzle/0019_conversation_tags.sql', import.meta.url),
  )
  const [statement] = (await file.text()).split('--> statement-breakpoint')
  // The same statement, held to this one conversation.
  const scoped = (statement ?? '').replace(
    'WHERE c."id" = n."id"',
    `WHERE c."id" = '${id}' AND c."id" = n."id"`,
  )
  await ctx.db.execute(sql.raw(scoped))
  const stored = await tagsOf(id)
  expect(stored).toEqual(normaliseTags(raw))
  // And a second run changes nothing.
  await ctx.db.execute(sql.raw(scoped))
  expect(await tagsOf(id)).toEqual(stored)
})
