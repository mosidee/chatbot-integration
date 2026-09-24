import { afterEach, describe, expect, test } from 'bun:test'
import { newId, schema } from '@ci/db'
import { eq } from 'drizzle-orm'
import { type MockServer, startMockOpenAI } from '../../core/test/helpers/mock-openai-server'
import {
  createEntry,
  indexConversationText,
  indexEntry,
  indexSource,
  replaceFileSource,
} from '../src/knowledge'
import { loadTurnContext } from '../src/repo'
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

describe('reranking', () => {
  /** Index a handful of entries so ordering is observable. */
  async function seedEntries(
    fixture: KnowledgeFixture,
    embedSlot: ReturnType<KnowledgeFixture['embedSlot']>,
  ) {
    const bodies = [
      'Refunds are processed within seven business days.',
      'The starter plan costs 990 THB per month.',
      'Opening hours are nine to six, Monday to Friday.',
      'Staff accounts are unlimited on the pro plan.',
    ]
    for (const body of bodies) {
      const entryId = await createEntry(fixture.db, {
        workspaceId: fixture.workspaceId,
        sourceId: fixture.sourceId,
        language: 'en',
        question: null,
        body,
      })
      await indexEntry(fixture.db, entryId, embedSlot)
    }
  }

  test('a configured reranker reorders the results and is reported in the result', async () => {
    const { fixture, embedSlot, server } = await setup()
    await seedEntries(fixture, embedSlot)

    const rerankSlot = fixture.embedSlot(`${server.url}/v1`)
    const withoutRerank = createPostgresRetriever(fixture.db, { embedSlot, fusion: TEST_FUSION })
    const withRerank = createPostgresRetriever(fixture.db, {
      embedSlot,
      rerankSlot: { ...rerankSlot, task: 'rerank' },
      fusion: TEST_FUSION,
    })

    const plain = await withoutRerank.retrieve({
      workspaceId: fixture.workspaceId,
      query: 'plan',
      limit: 3,
    })
    const ranked = await withRerank.retrieve({
      workspaceId: fixture.workspaceId,
      query: 'plan',
      limit: 3,
    })

    expect(plain.usedRerank).toBe(false)
    expect(ranked.usedRerank).toBe(true)
    // The mock reranker reverses the order it is given, so the ordering must differ.
    expect(ranked.chunks.map((c) => c.id)).not.toEqual(plain.chunks.map((c) => c.id))
  })

  test('reranking never returns fewer results than the query would without it', async () => {
    const { fixture, embedSlot, server } = await setup()
    await seedEntries(fixture, embedSlot)

    const rerankSlot = { ...fixture.embedSlot(`${server.url}/v1`), task: 'rerank' as const }
    const plain = await createPostgresRetriever(fixture.db, {
      embedSlot,
      fusion: TEST_FUSION,
    }).retrieve({ workspaceId: fixture.workspaceId, query: 'plan', limit: 3 })

    const ranked = await createPostgresRetriever(fixture.db, {
      embedSlot,
      rerankSlot,
      fusion: TEST_FUSION,
    }).retrieve({ workspaceId: fixture.workspaceId, query: 'plan', limit: 3 })

    expect(ranked.chunks).toHaveLength(plain.chunks.length)
    // The same set of chunks, possibly in a different order.
    expect(new Set(ranked.chunks.map((c) => c.id))).toEqual(new Set(plain.chunks.map((c) => c.id)))
  })

  test('a reranker that fails leaves the fused order untouched', async () => {
    const { fixture, embedSlot } = await setup()
    await seedEntries(fixture, embedSlot)

    const plain = await createPostgresRetriever(fixture.db, {
      embedSlot,
      fusion: TEST_FUSION,
    }).retrieve({ workspaceId: fixture.workspaceId, query: 'plan', limit: 3 })

    const brokenRerank = {
      ...fixture.embedSlot('http://localhost:1/v1'),
      task: 'rerank' as const,
    }
    const ranked = await createPostgresRetriever(fixture.db, {
      embedSlot,
      rerankSlot: brokenRerank,
      fusion: TEST_FUSION,
    }).retrieve({ workspaceId: fixture.workspaceId, query: 'plan', limit: 3 })

    expect(ranked.usedRerank).toBe(false)
    expect(ranked.chunks.map((c) => c.id)).toEqual(plain.chunks.map((c) => c.id))
  })
})

describe('the review, phase D', () => {
  /** #19: two models can both answer with 1024 numbers that mean nothing to each other. */
  test('never compares a query with vectors from another model', async () => {
    const { fixture, embedSlot } = await setup()
    const entryId = await createEntry(fixture.db, {
      workspaceId: fixture.workspaceId,
      sourceId: fixture.sourceId,
      language: 'en',
      question: null,
      body: 'Opening hours are nine to six.',
    })
    await indexEntry(fixture.db, entryId, embedSlot)

    // Same server, same size of vector, a different model name: a different space.
    const otherModel = {
      ...embedSlot,
      primary: embedSlot.primary ? { ...embedSlot.primary, model: 'another-embed-model' } : null,
    }
    const retriever = createPostgresRetriever(fixture.db, {
      embedSlot: otherModel,
      fusion: TEST_FUSION,
    })
    const result = await retriever.retrieve({
      workspaceId: fixture.workspaceId,
      query: 'opening hours',
    })
    expect(result.dense).toHaveLength(0)
    expect(result.embeddingModel).toBe('another-embed-model')
  })

  /** #20: a reindex that cannot embed leaves the previous index answering. */
  test('a file reindex that fails keeps the old index', async () => {
    const { fixture, embedSlot } = await setup()
    await replaceFileSource(
      fixture.db,
      {
        workspaceId: fixture.workspaceId,
        sourceId: fixture.sourceId,
        language: 'en',
        body: 'Version one of the price list.',
      },
      embedSlot,
    )
    const dead = {
      ...embedSlot,
      primary: embedSlot.primary
        ? {
            ...embedSlot.primary,
            provider: { ...embedSlot.primary.provider, baseUrl: 'http://127.0.0.1:9/v1' },
          }
        : null,
    }
    await expect(
      replaceFileSource(
        fixture.db,
        {
          workspaceId: fixture.workspaceId,
          sourceId: fixture.sourceId,
          language: 'en',
          body: 'Version two.',
        },
        dead,
      ),
    ).rejects.toThrow()

    const chunks = await fixture.db
      .select({ text: schema.knowledgeChunks.text })
      .from(schema.knowledgeChunks)
      .where(eq(schema.knowledgeChunks.sourceId, fixture.sourceId))
    expect(chunks.map((c) => c.text).join(' ')).toContain('Version one')
  })

  /** #21: a permanent conversation's earlier episodes stay recallable. */
  test('recalls an earlier part of the conversation in progress', async () => {
    const { fixture, embedSlot } = await setup()
    await indexConversationText(
      fixture.db,
      {
        workspaceId: fixture.workspaceId,
        customerId: fixture.customerA.id,
        conversationId: fixture.customerA.conversationId,
        text: 'Last month they asked about moving the salon to the premium plan.',
      },
      embedSlot,
    )

    const search = (since: Date) =>
      searchPastConversations(
        fixture.db,
        {
          workspaceId: fixture.workspaceId,
          customerId: fixture.customerA.id,
          query: 'premium plan',
          excludeConversationId: fixture.customerA.conversationId,
          excludeSince: since,
        },
        embedSlot,
      )
    // The visible window began after it was indexed: recallable.
    expect(await search(new Date(Date.now() + 60_000))).toHaveLength(1)
    // It is on screen already: not repeated back.
    expect(await search(new Date(Date.now() - 60_000))).toHaveLength(0)
  })

  /** #21: the model reads a long conversation's latest notes, not its first twenty. */
  test('a turn is given the newest notes, oldest first', async () => {
    const { fixture } = await setup()
    const base = Date.now() - 60 * 60 * 1000
    await fixture.db.insert(schema.internalNotes).values(
      Array.from({ length: 25 }, (_, index) => ({
        id: newId(),
        workspaceId: fixture.workspaceId,
        conversationId: fixture.customerA.conversationId,
        authorType: 'human' as const,
        body: `note ${index}`,
        createdAt: new Date(base + index * 1000),
      })),
    )
    const context = await loadTurnContext(
      fixture.db,
      fixture.workspaceId,
      fixture.customerA.conversationId,
    )
    const bodies = context?.notes.map((note) => note.body) ?? []
    expect(bodies).toHaveLength(20)
    expect(bodies[0]).toBe('note 5')
    expect(bodies.at(-1)).toBe('note 24')
  })
})
