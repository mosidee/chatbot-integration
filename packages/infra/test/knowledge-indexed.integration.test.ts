import { afterEach, expect, test } from 'bun:test'
import { newId, schema } from '@ci/db'
import { eq } from 'drizzle-orm'
import { indexEntry } from '../src/knowledge'
import { createKnowledgeFixture, type KnowledgeFixture } from './helpers/knowledge-fixture'

/**
 * UX audit U11: "saved" is not "findable". An entry says it is indexed only once retrieval
 * holds the revision the editor shows.
 */

const fixtures: KnowledgeFixture[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup()
})

async function entryState(f: KnowledgeFixture, id: string) {
  const [row] = await f.db
    .select({
      updatedAt: schema.knowledgeEntries.updatedAt,
      indexedRevision: schema.knowledgeEntries.indexedRevision,
    })
    .from(schema.knowledgeEntries)
    .where(eq(schema.knowledgeEntries.id, id))
  return {
    indexed: row?.indexedRevision?.getTime() === row?.updatedAt.getTime(),
  }
}

test('an entry is indexed once its current text is, and not before', async () => {
  const f = await createKnowledgeFixture()
  fixtures.push(f)
  const id = newId()
  await f.db.insert(schema.knowledgeEntries).values({
    id,
    workspaceId: f.workspaceId,
    sourceId: f.sourceId,
    variantGroup: id,
    language: 'th',
    question: 'เปิดกี่โมง',
    body: 'เปิด 10 โมงค่ะ',
  })
  expect((await entryState(f, id)).indexed).toBe(false)

  // No embedding provider: keyword retrieval still holds the text, which is what counts.
  await indexEntry(f.db, f.workspaceId, id, null)
  expect((await entryState(f, id)).indexed).toBe(true)

  // An edit moves the revision on; the old index no longer describes it.
  await f.db
    .update(schema.knowledgeEntries)
    .set({ body: 'เปิด 11 โมงค่ะ', updatedAt: new Date(Date.now() + 1000) })
    .where(eq(schema.knowledgeEntries.id, id))
  expect((await entryState(f, id)).indexed).toBe(false)

  await indexEntry(f.db, f.workspaceId, id, null)
  expect((await entryState(f, id)).indexed).toBe(true)

  // Switched off: nothing to find, and nothing still on its way either.
  await f.db
    .update(schema.knowledgeEntries)
    .set({ enabled: false, updatedAt: new Date(Date.now() + 2000) })
    .where(eq(schema.knowledgeEntries.id, id))
  await indexEntry(f.db, f.workspaceId, id, null)
  expect((await entryState(f, id)).indexed).toBe(true)
})
