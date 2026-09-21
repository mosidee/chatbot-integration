import { afterEach, describe, expect, test } from 'bun:test'
import type { BlobStore } from '@ci/core'
import { newId, schema } from '@ci/db'
import { and, eq } from 'drizzle-orm'
import { deleteFeedback, listFeedback, upsertFeedback } from '../src/feedback'
import { eraseCustomer } from '../src/retention'
import { countReviewQueue, isInReviewQueue, markReviewed } from '../src/review'
import { createKnowledgeFixture, type KnowledgeFixture } from './helpers/knowledge-fixture'

/**
 * The review queue and feedback, against real Postgres.
 *
 * The predicate is written in SQL and its whole job is to be right about which
 * conversations nobody has looked at, so it is tested against the database rather than a
 * fake. Times matter here: a message written after a review must bring the conversation
 * back, and the comparison is between two database clocks, so the rows say explicitly when
 * they were created rather than racing `now()`.
 */

const fixtures: KnowledgeFixture[] = []
/** Users are not the fixture's to make, so each test's own are removed with its own handle. */
const users: { fixture: KnowledgeFixture; id: string }[] = []

afterEach(async () => {
  for (const { fixture, id } of users.splice(0)) {
    await fixture.db.delete(schema.user).where(eq(schema.user.id, id))
  }
  for (const f of fixtures.splice(0)) await f.cleanup()
})

async function setup() {
  const fixture = await createKnowledgeFixture()
  fixtures.push(fixture)
  return fixture
}

async function makeUser(fixture: KnowledgeFixture, label: string): Promise<string> {
  const id = newId()
  await fixture.db.insert(schema.user).values({
    id,
    name: label,
    email: `${label}-${id.slice(0, 8)}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  users.push({ fixture, id })
  return id
}

/** A message at an explicit time, so "after the review" is a fact and not a race. */
async function say(
  fixture: KnowledgeFixture,
  conversationId: string,
  senderType: 'customer' | 'ai' | 'human',
  text: string,
  createdAt: Date,
): Promise<string> {
  const id = newId()
  await fixture.db.insert(schema.messages).values({
    id,
    workspaceId: fixture.workspaceId,
    conversationId,
    direction: senderType === 'customer' ? 'inbound' : 'outbound',
    senderType,
    content: { kind: 'text', text },
    text,
    createdAt,
  })
  return id
}

const T0 = new Date('2026-09-01T10:00:00.000Z')
const T1 = new Date('2026-09-01T10:01:00.000Z')

describe('the review queue', () => {
  test('a conversation only enters once the AI has answered in it', async () => {
    const f = await setup()
    expect(await countReviewQueue(f.db, f.workspaceId)).toBe(0)

    await say(f, f.customerA.conversationId, 'customer', 'สวัสดีค่ะ', T0)
    expect(await countReviewQueue(f.db, f.workspaceId)).toBe(0)

    await say(f, f.customerA.conversationId, 'ai', 'สวัสดีค่ะ ยินดีให้บริการ', T1)
    expect(await countReviewQueue(f.db, f.workspaceId)).toBe(1)
    expect(await isInReviewQueue(f.db, f.workspaceId, f.customerA.conversationId)).toBe(true)
  })

  test('a conversation a human ever spoke in is not the queue’s business', async () => {
    const f = await setup()
    await say(f, f.customerA.conversationId, 'ai', 'AI answered', T0)
    await say(f, f.customerA.conversationId, 'human', 'and then a person did', T1)

    expect(await countReviewQueue(f.db, f.workspaceId)).toBe(0)
  })

  test('a handoff means someone was already fetched', async () => {
    const f = await setup()
    await say(f, f.customerA.conversationId, 'ai', 'AI answered', T0)
    await f.db
      .update(schema.conversations)
      .set({ handoffReason: 'low_confidence' })
      .where(eq(schema.conversations.id, f.customerA.conversationId))

    expect(await countReviewQueue(f.db, f.workspaceId)).toBe(0)
  })

  test('a resolved conversation still needs reviewing', async () => {
    const f = await setup()
    await say(f, f.customerA.conversationId, 'ai', 'AI answered', T0)
    await f.db
      .update(schema.conversations)
      .set({ status: 'resolved' })
      .where(eq(schema.conversations.id, f.customerA.conversationId))

    expect(await countReviewQueue(f.db, f.workspaceId)).toBe(1)
  })

  test('reviewing clears it, and a later AI reply brings it back', async () => {
    const f = await setup()
    const userId = await makeUser(f, 'reviewer')
    await say(f, f.customerA.conversationId, 'ai', 'first answer', T0)

    const reviewedAt = await markReviewed(f.db, f.workspaceId, f.customerA.conversationId, userId)
    expect(reviewedAt).not.toBeNull()
    expect(await countReviewQueue(f.db, f.workspaceId)).toBe(0)

    // The AI speaks again, after the review. Nobody has seen this one.
    await say(f, f.customerA.conversationId, 'ai', 'second answer', new Date(Date.now() + 60_000))
    expect(await countReviewQueue(f.db, f.workspaceId)).toBe(1)
  })

  test('marking a conversation in another workspace reviewed does nothing', async () => {
    const mine = await setup()
    const theirs = await setup()
    const userId = await makeUser(mine, 'reviewer')
    await say(theirs, theirs.customerA.conversationId, 'ai', 'their answer', T0)

    expect(
      await markReviewed(mine.db, mine.workspaceId, theirs.customerA.conversationId, userId),
    ).toBeNull()
    expect(await countReviewQueue(theirs.db, theirs.workspaceId)).toBe(1)
  })

  test('one workspace’s queue never counts another’s conversations', async () => {
    const mine = await setup()
    const theirs = await setup()
    await say(mine, mine.customerA.conversationId, 'ai', 'mine', T0)
    await say(theirs, theirs.customerA.conversationId, 'ai', 'theirs', T0)

    expect(await countReviewQueue(mine.db, mine.workspaceId)).toBe(1)
    expect(await countReviewQueue(theirs.db, theirs.workspaceId)).toBe(1)
  })
})

describe('feedback', () => {
  test('a person holds one opinion per message, and may change it', async () => {
    const f = await setup()
    const userId = await makeUser(f, 'agent')
    const messageId = await say(f, f.customerA.conversationId, 'ai', 'an answer', T0)
    const target = {
      workspaceId: f.workspaceId,
      conversationId: f.customerA.conversationId,
      targetType: 'message' as const,
      targetId: messageId,
    }

    const down = await upsertFeedback(f.db, {
      ...target,
      userId,
      rating: 'down',
      reason: 'missing_knowledge',
      note: '  ยังไม่มีข้อมูลเรื่องนี้  ',
    })
    expect(down?.rating).toBe('down')
    expect(down?.reason).toBe('missing_knowledge')
    expect(down?.note).toBe('ยังไม่มีข้อมูลเรื่องนี้')

    const up = await upsertFeedback(f.db, { ...target, userId, rating: 'up' })
    expect(up?.id).toBe(down?.id)
    expect(up?.rating).toBe('up')
    // A thumbs-up has nothing to explain, so the old reason does not linger.
    expect(up?.reason).toBeNull()

    expect(await listFeedback(f.db, f.workspaceId, f.customerA.conversationId)).toHaveLength(1)
  })

  test('two people may disagree about the same message', async () => {
    const f = await setup()
    const one = await makeUser(f, 'agent-one')
    const two = await makeUser(f, 'agent-two')
    const messageId = await say(f, f.customerA.conversationId, 'ai', 'an answer', T0)
    const target = {
      workspaceId: f.workspaceId,
      conversationId: f.customerA.conversationId,
      targetType: 'message' as const,
      targetId: messageId,
    }

    await upsertFeedback(f.db, { ...target, userId: one, rating: 'up' })
    await upsertFeedback(f.db, { ...target, userId: two, rating: 'down', reason: 'wrong_answer' })

    expect(await listFeedback(f.db, f.workspaceId, f.customerA.conversationId)).toHaveLength(2)
  })

  test('only AI messages can be rated', async () => {
    const f = await setup()
    const userId = await makeUser(f, 'agent')
    const customerMessage = await say(f, f.customerA.conversationId, 'customer', 'a question', T0)

    expect(
      await upsertFeedback(f.db, {
        workspaceId: f.workspaceId,
        conversationId: f.customerA.conversationId,
        targetType: 'message',
        targetId: customerMessage,
        userId,
        rating: 'down',
        reason: 'wrong_answer',
      }),
    ).toBeNull()
  })

  test('a message belonging to another conversation cannot be rated through this one', async () => {
    const f = await setup()
    const userId = await makeUser(f, 'agent')
    const elsewhere = await say(f, f.customerB.conversationId, 'ai', 'B’s answer', T0)

    expect(
      await upsertFeedback(f.db, {
        workspaceId: f.workspaceId,
        conversationId: f.customerA.conversationId,
        targetType: 'message',
        targetId: elsewhere,
        userId,
        rating: 'up',
      }),
    ).toBeNull()
  })

  test('another workspace’s message cannot be rated at all', async () => {
    const mine = await setup()
    const theirs = await setup()
    const userId = await makeUser(mine, 'agent')
    const theirMessage = await say(theirs, theirs.customerA.conversationId, 'ai', 'theirs', T0)

    expect(
      await upsertFeedback(mine.db, {
        workspaceId: mine.workspaceId,
        conversationId: theirs.customerA.conversationId,
        targetType: 'message',
        targetId: theirMessage,
        userId,
        rating: 'up',
      }),
    ).toBeNull()
  })

  test('a suggestion is rated the same way', async () => {
    const f = await setup()
    const userId = await makeUser(f, 'agent')
    const suggestionId = newId()
    await f.db.insert(schema.suggestions).values({
      id: suggestionId,
      workspaceId: f.workspaceId,
      conversationId: f.customerA.conversationId,
      messageText: 'a draft',
    })

    const row = await upsertFeedback(f.db, {
      workspaceId: f.workspaceId,
      conversationId: f.customerA.conversationId,
      targetType: 'suggestion',
      targetId: suggestionId,
      userId,
      rating: 'down',
      reason: 'wrong_tone_or_language',
    })
    expect(row?.targetType).toBe('suggestion')
  })

  test('one agent cannot withdraw another’s feedback', async () => {
    const f = await setup()
    const mine = await makeUser(f, 'agent-one')
    const theirs = await makeUser(f, 'agent-two')
    const messageId = await say(f, f.customerA.conversationId, 'ai', 'an answer', T0)
    const row = await upsertFeedback(f.db, {
      workspaceId: f.workspaceId,
      conversationId: f.customerA.conversationId,
      targetType: 'message',
      targetId: messageId,
      userId: theirs,
      rating: 'up',
    })

    expect(
      await deleteFeedback(f.db, {
        workspaceId: f.workspaceId,
        conversationId: f.customerA.conversationId,
        feedbackId: row?.id ?? '',
        userId: mine,
      }),
    ).toBe(false)

    expect(
      await deleteFeedback(f.db, {
        workspaceId: f.workspaceId,
        conversationId: f.customerA.conversationId,
        feedbackId: row?.id ?? '',
        userId: theirs,
      }),
    ).toBe(true)
  })

  test('erasing a customer takes their feedback with it', async () => {
    const f = await setup()
    const userId = await makeUser(f, 'agent')
    const messageId = await say(f, f.customerA.conversationId, 'ai', 'an answer', T0)
    await upsertFeedback(f.db, {
      workspaceId: f.workspaceId,
      conversationId: f.customerA.conversationId,
      targetType: 'message',
      targetId: messageId,
      userId,
      rating: 'down',
      reason: 'fabricated',
    })

    const blob: BlobStore = {
      get: async () => ({
        data: new Uint8Array(new ArrayBuffer(0)),
        mime: 'application/octet-stream',
      }),
      put: async () => {},
      remove: async () => {},
      urlFor: (key) => `/${key}`,
    }
    await eraseCustomer(f.db, blob, { workspaceId: f.workspaceId, customerId: f.customerA.id })

    const left = await f.db
      .select({ id: schema.feedback.id })
      .from(schema.feedback)
      .where(
        and(
          eq(schema.feedback.workspaceId, f.workspaceId),
          eq(schema.feedback.conversationId, f.customerA.conversationId),
        ),
      )
    expect(left).toHaveLength(0)
  })
})
