import { afterEach, expect, test } from 'bun:test'
import { newId, schema } from '@ci/db'
import { eq } from 'drizzle-orm'
import { listWorkspaceTags } from '../src/conversation-tags'
import { createKnowledgeFixture, type KnowledgeFixture } from './helpers/knowledge-fixture'

const fixtures: KnowledgeFixture[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup()
})

/**
 * The tags the AI is offered are shown in every customer's conversation, so one that only a
 * single customer carries — however many conversations they have — is never among them.
 */
test("a tag on two of one customer's conversations is not offered to the AI", async () => {
  const f = await createKnowledgeFixture()
  fixtures.push(f)
  const [first] = await f.db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.id, f.customerA.conversationId))
  if (!first) throw new Error('no conversation')
  // The same customer on a second thread, as LINE and the widget would make.
  const identityId = newId()
  await f.db.insert(schema.channelIdentities).values({
    id: identityId,
    workspaceId: f.workspaceId,
    channelId: first.channelId,
    externalId: `second-${identityId}`,
    customerId: f.customerA.id,
    profile: {},
  })
  const secondId = newId()
  await f.db.insert(schema.conversations).values({
    id: secondId,
    workspaceId: f.workspaceId,
    channelId: first.channelId,
    customerId: f.customerA.id,
    channelIdentityId: identityId,
    mode: 'ai',
    status: 'open',
  })
  for (const id of [f.customerA.conversationId, secondId]) {
    await f.db
      .update(schema.conversations)
      .set({ tags: ['khun somchai', 'billing'] })
      .where(eq(schema.conversations.id, id))
  }
  await f.db
    .update(schema.conversations)
    .set({ tags: ['billing'] })
    .where(eq(schema.conversations.id, f.customerB.conversationId))

  const offered = (await listWorkspaceTags(f.db, f.workspaceId, { minCustomers: 2 })).map(
    (row) => row.tag,
  )
  expect(offered).toEqual(['billing'])
  // Everyone in the console still sees every tag, with its conversation count.
  expect(await listWorkspaceTags(f.db, f.workspaceId)).toEqual([
    { tag: 'billing', count: 3 },
    { tag: 'khun somchai', count: 2 },
  ])
})
