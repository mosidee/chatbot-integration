import { afterEach, describe, expect, test } from 'bun:test'
import { schema } from '@ci/db'
import { eq } from 'drizzle-orm'
import { type MockServer, startMockOpenAI } from '../../core/test/helpers/mock-openai-server'
import { createEntry, indexConversationText, indexEntry, indexSource } from '../src/knowledge'
import { createPostgresRetriever, searchPastConversations } from '../src/retrieval'
import { createKnowledgeFixture, type KnowledgeFixture } from './helpers/knowledge-fixture'

/**
 * Retrieval against real Postgres, with a deterministic embedding server.
 *
 * The mock embedding hashes character trigrams, so its cosine scores are lower than a real
 * model's. Tests therefore pass an explicit dense floor rather than relying on the default,
 * which is tuned for production models.
 */

const servers: MockServer[] = []
const fixtures: KnowledgeFixture[] = []

afterEach(async () => {
  for (const s of servers.splice(0)) s.stop()
  for (const f of fixtures.splice(0)) await f.cleanup()
})

async function setup() {
  const server = startMockOpenAI([{ kind: 'text', text: 'unused' }])
  servers.push(server)
  const fixture = await createKnowledgeFixture()
  fixtures.push(fixture)
  const embedSlot = fixture.embedSlot(`${server.url}/v1`)
  return { server, fixture, embedSlot }
}

const TEST_FUSION = { denseFloor: 0.02, keywordFloor: 0.1 }

describe('hybrid retrieval', () => {
  test('finds a Thai answer from a differently worded question', async () => {
    const { fixture, embedSlot } = await setup()

    const entryId = await createEntry(fixture.db, {
      workspaceId: fixture.workspaceId,
      sourceId: fixture.sourceId,
      language: 'th',
      question: 'แพ็กเกจราคาเท่าไหร่',
      body: 'แพ็กเกจเริ่มต้นของ salon-saas ราคา 990 บาทต่อเดือน รวมการจองคิวออนไลน์',
    })
    await indexEntry(fixture.db, entryId, embedSlot)

    const retriever = createPostgresRetriever(fixture.db, { embedSlot, fusion: TEST_FUSION })
    const result = await retriever.retrieve({
      workspaceId: fixture.workspaceId,
      query: 'ราคาเท่าไหร่',
    })

    expect(result.chunks.length).toBeGreaterThan(0)
    expect(result.chunks[0]?.text).toContain('990')
    expect(result.chunks[0]?.sourceTitle).toBe('Pilot FAQ')
  })

  test('finds a product code through the keyword half alone', async () => {
    const { fixture, embedSlot } = await setup()

    const entryId = await createEntry(fixture.db, {
      workspaceId: fixture.workspaceId,
      sourceId: fixture.sourceId,
      language: 'en',
      question: null,
      body: 'Plan SKU SALON-PRO-2026 includes unlimited staff accounts and SMS reminders.',
    })
    await indexEntry(fixture.db, entryId, embedSlot)

    const retriever = createPostgresRetriever(fixture.db, { embedSlot, fusion: TEST_FUSION })
    const result = await retriever.retrieve({
      workspaceId: fixture.workspaceId,
      query: 'SALON-PRO-2026',
    })

    expect(result.keyword.length).toBeGreaterThan(0)
    expect(result.keyword[0]?.keywordScore).toBeGreaterThan(0.9)
    expect(result.chunks[0]?.text).toContain('SALON-PRO-2026')
  })

  test('reports each half separately so a regression can be located', async () => {
    const { fixture, embedSlot } = await setup()

    const entryId = await createEntry(fixture.db, {
      workspaceId: fixture.workspaceId,
      sourceId: fixture.sourceId,
      language: 'th',
      question: 'จองคิวอย่างไร',
      body: 'เข้าไปที่เมนูการจองคิว แล้วเลือกวันและเวลาที่ต้องการ',
    })
    await indexEntry(fixture.db, entryId, embedSlot)

    const retriever = createPostgresRetriever(fixture.db, { embedSlot, fusion: TEST_FUSION })
    const result = await retriever.retrieve({
      workspaceId: fixture.workspaceId,
      query: 'จองคิว',
    })

    expect(Array.isArray(result.dense)).toBe(true)
    expect(Array.isArray(result.keyword)).toBe(true)
    expect(result.embeddingModel).toBe('mock-embed-model')
    // Both halves should see this one: the words appear literally and the meaning matches.
    expect(result.dense.length).toBeGreaterThan(0)
    expect(result.keyword.length).toBeGreaterThan(0)
  })

  test('works without an embedding provider, on keyword alone', async () => {
    const { fixture, embedSlot } = await setup()

    const entryId = await createEntry(fixture.db, {
      workspaceId: fixture.workspaceId,
      sourceId: fixture.sourceId,
      language: 'en',
      question: null,
      body: 'Refunds are processed within 7 business days.',
    })
    await indexEntry(fixture.db, entryId, embedSlot)

    const retriever = createPostgresRetriever(fixture.db, {
      embedSlot: null,
      fusion: TEST_FUSION,
    })
    const result = await retriever.retrieve({
      workspaceId: fixture.workspaceId,
      query: 'Refunds',
    })

    expect(result.dense).toHaveLength(0)
    expect(result.chunks.length).toBeGreaterThan(0)
    expect(result.embeddingModel).toBeNull()
  })

  test('excludes a disabled entry', async () => {
    const { fixture, embedSlot } = await setup()

    const entryId = await createEntry(fixture.db, {
      workspaceId: fixture.workspaceId,
      sourceId: fixture.sourceId,
      language: 'en',
      question: null,
      body: 'Secret internal note about pricing changes.',
    })
    await indexEntry(fixture.db, entryId, embedSlot)

    await fixture.db
      .update(schema.knowledgeEntries)
      .set({ enabled: false })
      .where(eq(schema.knowledgeEntries.id, entryId))
    // Re-indexing a disabled entry removes its chunks.
    await indexEntry(fixture.db, entryId, embedSlot)

    const retriever = createPostgresRetriever(fixture.db, { embedSlot, fusion: TEST_FUSION })
    const result = await retriever.retrieve({
      workspaceId: fixture.workspaceId,
      query: 'Secret internal note',
    })
    expect(result.chunks).toHaveLength(0)
  })

  test('respects a channel restriction', async () => {
    const { fixture, embedSlot } = await setup()

    const entryId = await createEntry(fixture.db, {
      workspaceId: fixture.workspaceId,
      sourceId: fixture.sourceId,
      language: 'en',
      question: null,
      body: 'LINE customers get a special sticker pack.',
      channelTypes: ['line'],
    })
    await indexEntry(fixture.db, entryId, embedSlot)

    const retriever = createPostgresRetriever(fixture.db, { embedSlot, fusion: TEST_FUSION })

    const onLine = await retriever.retrieve({
      workspaceId: fixture.workspaceId,
      query: 'sticker pack',
      channelType: 'line',
    })
    expect(onLine.chunks.length).toBeGreaterThan(0)

    const onMessenger = await retriever.retrieve({
      workspaceId: fixture.workspaceId,
      query: 'sticker pack',
      channelType: 'messenger',
    })
    expect(onMessenger.chunks).toHaveLength(0)
  })

  test("never returns another workspace's knowledge", async () => {
    const { fixture, embedSlot } = await setup()
    const other = await createKnowledgeFixture()
    fixtures.push(other)

    const entryId = await createEntry(other.db, {
      workspaceId: other.workspaceId,
      sourceId: other.sourceId,
      language: 'en',
      question: null,
      body: 'Competitor pricing intelligence, strictly internal.',
    })
    await indexEntry(other.db, entryId, embedSlot)

    const retriever = createPostgresRetriever(fixture.db, { embedSlot, fusion: TEST_FUSION })
    const result = await retriever.retrieve({
      workspaceId: fixture.workspaceId,
      query: 'Competitor pricing intelligence',
    })
    expect(result.chunks).toHaveLength(0)
    expect(result.dense).toHaveLength(0)
    expect(result.keyword).toHaveLength(0)
  })

  test('re-indexing replaces chunks rather than duplicating them', async () => {
    const { fixture, embedSlot } = await setup()

    const entryId = await createEntry(fixture.db, {
      workspaceId: fixture.workspaceId,
      sourceId: fixture.sourceId,
      language: 'en',
      question: null,
      body: 'The old answer.',
    })
    await indexEntry(fixture.db, entryId, embedSlot)
    await fixture.db
      .update(schema.knowledgeEntries)
      .set({ body: 'The new answer.' })
      .where(eq(schema.knowledgeEntries.id, entryId))
    await indexEntry(fixture.db, entryId, embedSlot)

    const chunks = await fixture.db
      .select()
      .from(schema.knowledgeChunks)
      .where(eq(schema.knowledgeChunks.entryId, entryId))

    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.text).toContain('new answer')
  })

  test('indexSource marks the source ready', async () => {
    const { fixture, embedSlot } = await setup()
    await createEntry(fixture.db, {
      workspaceId: fixture.workspaceId,
      sourceId: fixture.sourceId,
      language: 'en',
      question: 'Q',
      body: 'A',
    })
    const result = await indexSource(fixture.db, fixture.sourceId, embedSlot)
    expect(result.entries).toBe(1)

    const rows = await fixture.db
      .select()
      .from(schema.knowledgeSources)
      .where(eq(schema.knowledgeSources.id, fixture.sourceId))
    expect(rows[0]?.status).toBe('ready')
    expect(rows[0]?.error).toBeNull()
  })
})

describe('recall over past conversations', () => {
  test("never returns another customer's history", async () => {
    const { fixture, embedSlot } = await setup()

    await indexConversationText(
      fixture.db,
      {
        workspaceId: fixture.workspaceId,
        customerId: fixture.customerA.id,
        conversationId: fixture.customerA.conversationId,
        text: 'ลูกค้า A เคยสอบถามเรื่องการคืนเงินของออร์เดอร์ SO-1111',
      },
      embedSlot,
    )
    await indexConversationText(
      fixture.db,
      {
        workspaceId: fixture.workspaceId,
        customerId: fixture.customerB.id,
        conversationId: fixture.customerB.conversationId,
        text: 'ลูกค้า B เคยสอบถามเรื่องการคืนเงินของออร์เดอร์ SO-2222',
      },
      embedSlot,
    )

    // Searching as customer A, with a query that matches B's text at least as well.
    const hits = await searchPastConversations(
      fixture.db,
      {
        workspaceId: fixture.workspaceId,
        customerId: fixture.customerA.id,
        query: 'การคืนเงินของออร์เดอร์',
      },
      embedSlot,
    )

    expect(hits.length).toBeGreaterThan(0)
    for (const hit of hits) {
      expect(hit.text).not.toContain('SO-2222')
      expect(hit.text).not.toContain('ลูกค้า B')
      expect(hit.conversationId).toBe(fixture.customerA.conversationId)
    }
  })

  test('returns nothing for a customer with no history', async () => {
    const { fixture, embedSlot } = await setup()
    await indexConversationText(
      fixture.db,
      {
        workspaceId: fixture.workspaceId,
        customerId: fixture.customerA.id,
        conversationId: fixture.customerA.conversationId,
        text: 'A previous question about billing.',
      },
      embedSlot,
    )

    const hits = await searchPastConversations(
      fixture.db,
      {
        workspaceId: fixture.workspaceId,
        customerId: fixture.customerB.id,
        query: 'billing',
      },
      embedSlot,
    )
    expect(hits).toHaveLength(0)
  })

  test('can exclude the conversation in progress', async () => {
    const { fixture, embedSlot } = await setup()
    await indexConversationText(
      fixture.db,
      {
        workspaceId: fixture.workspaceId,
        customerId: fixture.customerA.id,
        conversationId: fixture.customerA.conversationId,
        text: 'Something said in the current conversation.',
      },
      embedSlot,
    )

    const hits = await searchPastConversations(
      fixture.db,
      {
        workspaceId: fixture.workspaceId,
        customerId: fixture.customerA.id,
        query: 'Something said',
        excludeConversationId: fixture.customerA.conversationId,
      },
      embedSlot,
    )
    expect(hits).toHaveLength(0)
  })

  test('returns nothing when no embedding provider is configured', async () => {
    const { fixture } = await setup()
    const hits = await searchPastConversations(
      fixture.db,
      { workspaceId: fixture.workspaceId, customerId: fixture.customerA.id, query: 'anything' },
      null,
    )
    expect(hits).toHaveLength(0)
  })
})
