import { afterEach, describe, expect, test } from 'bun:test'
import type { BlobStore } from '@ci/core'
import { newId, schema } from '@ci/db'
import { and, eq } from 'drizzle-orm'
import {
  acceptMergeSuggestion,
  countPendingMerges,
  findMergeCandidates,
  findSplitConversations,
  listMergeSuggestions,
  mergeConversations,
  mergeCustomers,
  normaliseMatchValue,
  rejectMergeSuggestion,
  suggestMergesFor,
} from '../src/merge'
import { eraseCustomer } from '../src/retention'
import { createKnowledgeFixture, type KnowledgeFixture } from './helpers/knowledge-fixture'

/**
 * Merging two customers into one, against real Postgres.
 *
 * The first test here is the one that matters most. Every table that points at a customer
 * cascades on delete, so a merge that deleted before it repointed would take the person's
 * conversations with it and say nothing. Nothing about that failure is visible in a type,
 * so it is pinned by a test that counts rows on both sides of the operation.
 */

const fixtures: KnowledgeFixture[] = []
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

async function setField(f: KnowledgeFixture, customerId: string, fields: Record<string, string>) {
  await f.db.update(schema.customers).set({ fields }).where(eq(schema.customers.id, customerId))
}

async function say(f: KnowledgeFixture, conversationId: string, text: string) {
  await f.db.insert(schema.messages).values({
    id: newId(),
    workspaceId: f.workspaceId,
    conversationId,
    direction: 'inbound',
    senderType: 'customer',
    content: { kind: 'text', text },
    text,
  })
}

/** Ids are time-ordered, so the older of the fixture's two customers is the smaller string. */
function olderOf(f: KnowledgeFixture): { older: string; newer: string } {
  const [older, newer] =
    f.customerA.id < f.customerB.id
      ? [f.customerA.id, f.customerB.id]
      : [f.customerB.id, f.customerA.id]
  return { older, newer }
}

describe('merging two customers', () => {
  test('nothing belonging to either person is lost', async () => {
    const f = await setup()
    const { older, newer } = olderOf(f)
    await say(f, f.customerA.conversationId, 'first question')
    await say(f, f.customerB.conversationId, 'second question')

    // A summary and a recall embedding on each side, since both cascade from the customer.
    for (const customerId of [older, newer]) {
      await f.db.insert(schema.customerSummaries).values({
        id: newId(),
        workspaceId: f.workspaceId,
        customerId,
        summary: `summary of ${customerId.slice(0, 6)}`,
      })
    }
    for (const { id, conversationId } of [f.customerA, f.customerB]) {
      await f.db.insert(schema.conversationEmbeddings).values({
        id: newId(),
        workspaceId: f.workspaceId,
        customerId: id,
        conversationId,
        text: 'something they said',
      })
    }

    const result = await mergeCustomers(f.db, {
      workspaceId: f.workspaceId,
      survivorId: older,
      absorbedId: newer,
    })
    expect(result).not.toBeNull()

    const counts = async (table: typeof schema.conversations | typeof schema.channelIdentities) =>
      (await f.db.select({ id: table.id }).from(table).where(eq(table.workspaceId, f.workspaceId)))
        .length

    // The whole point: two conversations went in and two come out.
    expect(await counts(schema.conversations)).toBe(2)
    expect(await counts(schema.channelIdentities)).toBe(2)
    expect(
      await f.db
        .select({ id: schema.messages.id })
        .from(schema.messages)
        .where(eq(schema.messages.workspaceId, f.workspaceId)),
    ).toHaveLength(2)

    // And everything now belongs to the survivor.
    const survivorsConversations = await f.db
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(eq(schema.conversations.customerId, older))
    expect(survivorsConversations).toHaveLength(2)

    const summaries = await f.db
      .select({ id: schema.customerSummaries.id })
      .from(schema.customerSummaries)
      .where(eq(schema.customerSummaries.customerId, older))
    expect(summaries).toHaveLength(2)

    // Recall is scoped by customer, so an embedding left behind would strand past
    // conversations the survivor should be able to remember.
    const embeddings = await f.db
      .select({ id: schema.conversationEmbeddings.id })
      .from(schema.conversationEmbeddings)
      .where(eq(schema.conversationEmbeddings.customerId, older))
    expect(embeddings).toHaveLength(2)

    const left = await f.db
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(eq(schema.customers.workspaceId, f.workspaceId))
    expect(left).toHaveLength(1)
    expect(left[0]?.id).toBe(older)
  })

  test('the survivor keeps what it knew and gains what it did not', async () => {
    const f = await setup()
    const { older, newer } = olderOf(f)
    await setField(f, older, { phone: '0812345678', account_id: 'acct-1' })
    await setField(f, newer, { phone: '+66812345678', email: 'owner@salon.test' })

    await mergeCustomers(f.db, {
      workspaceId: f.workspaceId,
      survivorId: older,
      absorbedId: newer,
    })

    const [survivor] = await f.db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.id, older))
    // Its own phone stands, because the older record has been right for longer.
    expect(survivor?.fields.phone).toBe('0812345678')
    expect(survivor?.fields.account_id).toBe('acct-1')
    expect(survivor?.fields.email).toBe('owner@salon.test')
  })

  test('what the AI noted about either of them survives', async () => {
    // `notes` is a column on `customers`, so the repoint list does not cover it: without
    // being named in the survivor-wins block it dies with the absorbed row.
    const f = await setup()
    const { older, newer } = olderOf(f)
    await f.db
      .update(schema.customers)
      .set({ notes: { plan: 'Starter', city: 'Chiang Mai' } })
      .where(eq(schema.customers.id, older))
    await f.db
      .update(schema.customers)
      .set({ notes: { plan: 'Growth', staff: '3' } })
      .where(eq(schema.customers.id, newer))

    await mergeCustomers(f.db, {
      workspaceId: f.workspaceId,
      survivorId: older,
      absorbedId: newer,
    })

    const [survivor] = await f.db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.id, older))
    // Survivor wins per key, absorbed fills the gaps.
    expect(survivor?.notes).toEqual({ plan: 'Starter', city: 'Chiang Mai', staff: '3' })
  })

  test('an audit entry survives both the merge and the suggestion', async () => {
    const f = await setup()
    const userId = await makeUser(f, 'agent')
    const { older, newer } = olderOf(f)

    await mergeCustomers(f.db, {
      workspaceId: f.workspaceId,
      survivorId: older,
      absorbedId: newer,
      userId,
    })

    const [entry] = await f.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.workspaceId, f.workspaceId),
          eq(schema.auditLog.action, 'customer.merged'),
        ),
      )
    expect(entry?.targetId).toBe(older)
    expect(entry?.actorUserId).toBe(userId)
    expect((entry?.meta as { absorbedCustomerId?: string } | undefined)?.absorbedCustomerId).toBe(
      newer,
    )
  })

  test('a customer in another workspace is not merged', async () => {
    const mine = await setup()
    const theirs = await setup()

    expect(
      await mergeCustomers(mine.db, {
        workspaceId: mine.workspaceId,
        survivorId: mine.customerA.id,
        absorbedId: theirs.customerA.id,
      }),
    ).toBeNull()

    const stillThere = await theirs.db
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(eq(schema.customers.id, theirs.customerA.id))
    expect(stillThere).toHaveLength(1)
  })

  test('a customer is not merged into itself', async () => {
    const f = await setup()
    expect(
      await mergeCustomers(f.db, {
        workspaceId: f.workspaceId,
        survivorId: f.customerA.id,
        absorbedId: f.customerA.id,
      }),
    ).toBeNull()
  })
})

describe('the account owner survives a merge', () => {
  /**
   * The repoint list is about tables, so it does not cover a column on `customers`: any
   * column not named in the survivor-wins block is simply dropped with the absorbed row.
   * Somebody looking after the absorbed record must keep looking after the person.
   */
  test('is inherited when the survivor has none', async () => {
    const f = await setup()
    const { older, newer } = olderOf(f)
    const owner = await makeUser(f, 'owner')

    await f.db
      .update(schema.customers)
      .set({ assigneeUserId: owner })
      .where(eq(schema.customers.id, newer))

    await mergeCustomers(f.db, {
      workspaceId: f.workspaceId,
      survivorId: older,
      absorbedId: newer,
      userId: null,
    })

    const rows = await f.db
      .select({ assigneeUserId: schema.customers.assigneeUserId })
      .from(schema.customers)
      .where(eq(schema.customers.id, older))
    expect(rows[0]?.assigneeUserId).toBe(owner)
  })

  test('is not overwritten when the survivor already has one', async () => {
    const f = await setup()
    const { older, newer } = olderOf(f)
    const survivorOwner = await makeUser(f, 'survivor-owner')
    const absorbedOwner = await makeUser(f, 'absorbed-owner')

    await f.db
      .update(schema.customers)
      .set({ assigneeUserId: survivorOwner })
      .where(eq(schema.customers.id, older))
    await f.db
      .update(schema.customers)
      .set({ assigneeUserId: absorbedOwner })
      .where(eq(schema.customers.id, newer))

    await mergeCustomers(f.db, {
      workspaceId: f.workspaceId,
      survivorId: older,
      absorbedId: newer,
      userId: null,
    })

    const rows = await f.db
      .select({ assigneeUserId: schema.customers.assigneeUserId })
      .from(schema.customers)
      .where(eq(schema.customers.id, older))
    expect(rows[0]?.assigneeUserId).toBe(survivorOwner)
  })
})

describe('normalising an identifier', () => {
  test('one Thai mobile written three ways is one number', () => {
    const expected = '0812345678'
    expect(normaliseMatchValue('phone', '0812345678')).toBe(expected)
    expect(normaliseMatchValue('phone', '081-234-5678')).toBe(expected)
    expect(normaliseMatchValue('phone', '081 234 5678')).toBe(expected)
    expect(normaliseMatchValue('phone', '+66812345678')).toBe(expected)
    expect(normaliseMatchValue('phone', '+66 81 234 5678')).toBe(expected)
    expect(normaliseMatchValue('phone', '0066812345678')).toBe(expected)
  })

  test('two different numbers stay different', () => {
    expect(normaliseMatchValue('phone', '0812345678')).not.toBe(
      normaliseMatchValue('phone', '0812345679'),
    )
  })

  test('something too short to identify anybody is not a match', () => {
    expect(normaliseMatchValue('phone', '1234')).toBeNull()
    expect(normaliseMatchValue('account_id', 'a1')).toBeNull()
    expect(normaliseMatchValue('email', 'not-an-email')).toBeNull()
    expect(normaliseMatchValue('phone', '   ')).toBeNull()
  })

  test('an email is compared without its casing', () => {
    expect(normaliseMatchValue('email', '  Owner@Salon.TEST ')).toBe('owner@salon.test')
  })

  test('an account id keeps its casing, because it may be significant', () => {
    expect(normaliseMatchValue('account_id', 'AbCdEf')).toBe('AbCdEf')
    expect(normaliseMatchValue('account_id', 'abcdef')).not.toBe(
      normaliseMatchValue('account_id', 'AbCdEf'),
    )
  })
})

describe('proposing a merge', () => {
  test('the same phone on two records is noticed', async () => {
    const f = await setup()
    await setField(f, f.customerA.id, { phone: '081-234-5678' })
    await setField(f, f.customerB.id, { phone: '+66812345678' })

    const candidates = await findMergeCandidates(f.db, f.workspaceId, f.customerA.id, ['phone'])
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.otherCustomerId).toBe(f.customerB.id)
    expect(candidates[0]?.value).toBe('0812345678')
  })

  test('a shared employer is not evidence of anything', async () => {
    const f = await setup()
    await setField(f, f.customerA.id, { company: 'Salon ABC', order_id: 'INV-1001' })
    await setField(f, f.customerB.id, { company: 'Salon ABC', order_id: 'INV-1001' })

    expect(
      await suggestMergesFor(f.db, f.workspaceId, f.customerA.id, ['company', 'order_id']),
    ).toBe(0)
    expect(await countPendingMerges(f.db, f.workspaceId)).toBe(0)
  })

  test('the pair is proposed once, whichever side asks', async () => {
    const f = await setup()
    await setField(f, f.customerA.id, { phone: '0812345678' })
    await setField(f, f.customerB.id, { phone: '0812345678' })

    expect(await suggestMergesFor(f.db, f.workspaceId, f.customerA.id, ['phone'])).toBe(1)
    expect(await suggestMergesFor(f.db, f.workspaceId, f.customerB.id, ['phone'])).toBe(0)
    expect(await countPendingMerges(f.db, f.workspaceId)).toBe(1)
  })

  test('both people see the proposal, whichever side of the pair they are', async () => {
    const f = await setup()
    await setField(f, f.customerA.id, { phone: '0812345678' })
    await setField(f, f.customerB.id, { phone: '0812345678' })
    await suggestMergesFor(f.db, f.workspaceId, f.customerA.id, ['phone'])

    expect(await listMergeSuggestions(f.db, f.workspaceId, f.customerA.id)).toHaveLength(1)
    expect(await listMergeSuggestions(f.db, f.workspaceId, f.customerB.id)).toHaveLength(1)
  })

  test('a rejected pair is never raised again', async () => {
    const f = await setup()
    const userId = await makeUser(f, 'agent')
    await setField(f, f.customerA.id, { phone: '0812345678' })
    await setField(f, f.customerB.id, { phone: '0812345678' })
    await suggestMergesFor(f.db, f.workspaceId, f.customerA.id, ['phone'])

    const [suggestion] = await listMergeSuggestions(f.db, f.workspaceId, f.customerA.id)
    expect(await rejectMergeSuggestion(f.db, f.workspaceId, suggestion?.id ?? '', userId)).toBe(
      true,
    )
    expect(await listMergeSuggestions(f.db, f.workspaceId, f.customerA.id)).toHaveLength(0)

    // The customer writes again and the same number is recorded again.
    expect(await suggestMergesFor(f.db, f.workspaceId, f.customerA.id, ['phone'])).toBe(0)
    expect(await countPendingMerges(f.db, f.workspaceId)).toBe(0)
  })

  test('rejecting the same suggestion twice changes nothing', async () => {
    const f = await setup()
    const userId = await makeUser(f, 'agent')
    await setField(f, f.customerA.id, { phone: '0812345678' })
    await setField(f, f.customerB.id, { phone: '0812345678' })
    await suggestMergesFor(f.db, f.workspaceId, f.customerA.id, ['phone'])
    const [suggestion] = await listMergeSuggestions(f.db, f.workspaceId, f.customerA.id)

    expect(await rejectMergeSuggestion(f.db, f.workspaceId, suggestion?.id ?? '', userId)).toBe(
      true,
    )
    expect(await rejectMergeSuggestion(f.db, f.workspaceId, suggestion?.id ?? '', userId)).toBe(
      false,
    )
  })

  test('another workspace’s customers are never candidates', async () => {
    const mine = await setup()
    const theirs = await setup()
    await setField(mine, mine.customerA.id, { phone: '0812345678' })
    await setField(theirs, theirs.customerA.id, { phone: '0812345678' })

    expect(await suggestMergesFor(mine.db, mine.workspaceId, mine.customerA.id, ['phone'])).toBe(0)
    expect(await countPendingMerges(mine.db, mine.workspaceId)).toBe(0)
  })

  test('accepting performs the merge and clears the proposal', async () => {
    const f = await setup()
    const userId = await makeUser(f, 'agent')
    const { older } = olderOf(f)
    await setField(f, f.customerA.id, { phone: '0812345678' })
    await setField(f, f.customerB.id, { phone: '0812345678' })
    await suggestMergesFor(f.db, f.workspaceId, f.customerA.id, ['phone'])
    const [suggestion] = await listMergeSuggestions(f.db, f.workspaceId, f.customerA.id)

    const merged = await acceptMergeSuggestion(f.db, f.workspaceId, suggestion?.id ?? '', userId)
    expect(merged?.survivorId).toBe(older)
    expect(merged?.conversations).toBe(1)

    // The row pointed at the absorbed customer, so it went with them.
    expect(await countPendingMerges(f.db, f.workspaceId)).toBe(0)
    expect(await listMergeSuggestions(f.db, f.workspaceId, older)).toHaveLength(0)
  })

  test('erasing a customer takes the proposal, and the number in it, away', async () => {
    const f = await setup()
    await setField(f, f.customerA.id, { phone: '0812345678' })
    await setField(f, f.customerB.id, { phone: '0812345678' })
    await suggestMergesFor(f.db, f.workspaceId, f.customerA.id, ['phone'])
    expect(await countPendingMerges(f.db, f.workspaceId)).toBe(1)

    const blob: BlobStore = {
      get: async () => ({
        data: new Uint8Array(new ArrayBuffer(0)),
        mime: 'application/octet-stream',
      }),
      put: async () => {},
      remove: async () => {},
      urlFor: (key) => `/${key}`,
    }
    // Erasing either side must clear it: the row holds the phone number they gave, which
    // is exactly the sort of thing a person asking to be erased means.
    await eraseCustomer(f.db, blob, { workspaceId: f.workspaceId, customerId: f.customerB.id })

    expect(await countPendingMerges(f.db, f.workspaceId)).toBe(0)
    const left = await f.db
      .select({ id: schema.mergeSuggestions.id })
      .from(schema.mergeSuggestions)
      .where(eq(schema.mergeSuggestions.workspaceId, f.workspaceId))
    expect(left).toHaveLength(0)
  })

  test('a suggestion cannot be accepted from another workspace', async () => {
    const mine = await setup()
    const theirs = await setup()
    const userId = await makeUser(mine, 'agent')
    await setField(theirs, theirs.customerA.id, { phone: '0812345678' })
    await setField(theirs, theirs.customerB.id, { phone: '0812345678' })
    await suggestMergesFor(theirs.db, theirs.workspaceId, theirs.customerA.id, ['phone'])
    const [suggestion] = await listMergeSuggestions(
      theirs.db,
      theirs.workspaceId,
      theirs.customerA.id,
    )

    expect(
      await acceptMergeSuggestion(mine.db, mine.workspaceId, suggestion?.id ?? '', userId),
    ).toBeNull()
    expect(await countPendingMerges(theirs.db, theirs.workspaceId)).toBe(1)
  })
})

describe('folding split conversations back into one', () => {
  /**
   * The same danger as merging customers, one level down: eight tables hang off a
   * conversation and every one cascades on delete. Repointing before deleting is the whole
   * operation, and nothing about getting it wrong is visible in a type — the messages, the
   * notes, the traces and the ratings would simply be gone.
   */
  test('moves everything that hangs off the absorbed threads, then removes them', async () => {
    const f = await setup()
    const identity = await f.db
      .select({ id: schema.channelIdentities.id, channelId: schema.channelIdentities.channelId })
      .from(schema.channelIdentities)
      .where(eq(schema.channelIdentities.customerId, f.customerA.id))
      .limit(1)
    const channelIdentityId = identity[0]?.id ?? ''
    const channelId = identity[0]?.channelId ?? ''

    // A second, older thread for the same person on the same channel, as the old code left.
    const olderId = newId()
    await f.db.insert(schema.conversations).values({
      id: olderId,
      workspaceId: f.workspaceId,
      channelId,
      customerId: f.customerA.id,
      channelIdentityId,
      mode: 'ai',
      status: 'resolved',
      tags: ['billing'],
      createdAt: new Date(Date.now() - 86_400_000),
      lastMessageAt: new Date(Date.now() - 86_400_000),
    })

    await say(f, olderId, 'something said last week')
    await say(f, f.customerA.conversationId, 'something said today')

    await f.db.insert(schema.internalNotes).values({
      id: newId(),
      workspaceId: f.workspaceId,
      conversationId: olderId,
      authorType: 'human',
      body: 'a note on the old thread',
    })
    await f.db.insert(schema.handoffEvents).values({
      id: newId(),
      workspaceId: f.workspaceId,
      conversationId: olderId,
      reason: 'ai_requested',
      occurredAt: new Date(),
    })
    await f.db.insert(schema.aiTraces).values({
      id: newId(),
      workspaceId: f.workspaceId,
      conversationId: olderId,
      task: 'agent_chat',
      model: 'mock',
      outcome: 'sent',
    })

    const found = await findSplitConversations(f.db, f.workspaceId)
    const group = found.find((row) => row.channelIdentityId === channelIdentityId)
    expect(group).toBeDefined()
    // The survivor is the live thread, because that is the one the next message reopens.
    expect(group?.survivorId).toBe(f.customerA.conversationId)
    expect(group?.absorbedIds).toEqual([olderId])

    const result = await mergeConversations(f.db, {
      workspaceId: f.workspaceId,
      survivorId: f.customerA.conversationId,
      absorbedIds: [olderId],
      userId: null,
    })

    expect(result?.messages).toBe(1)
    expect(result?.notes).toBe(1)
    expect(result?.handoffEvents).toBe(1)
    expect(result?.traces).toBe(1)
    expect(result?.absorbed).toBe(1)

    // Both sides of the history are in the one thread now.
    const messages = await f.db
      .select({ text: schema.messages.text })
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, f.customerA.conversationId))
    expect(messages.map((row) => row.text)).toContain('something said last week')
    expect(messages.map((row) => row.text)).toContain('something said today')

    // And nothing was left pointing at a conversation that no longer exists.
    const gone = await f.db
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(eq(schema.conversations.id, olderId))
    expect(gone).toHaveLength(0)

    const orphanedNotes = await f.db
      .select({ id: schema.internalNotes.id })
      .from(schema.internalNotes)
      .where(eq(schema.internalNotes.conversationId, f.customerA.conversationId))
    expect(orphanedNotes).toHaveLength(1)

    // The thread now begins where its oldest message does, and keeps both sets of tags.
    const survivor = await f.db
      .select({ createdAt: schema.conversations.createdAt, tags: schema.conversations.tags })
      .from(schema.conversations)
      .where(eq(schema.conversations.id, f.customerA.conversationId))
    expect(survivor[0]?.createdAt.getTime()).toBeLessThan(Date.now() - 80_000_000)
    expect(survivor[0]?.tags).toContain('billing')
  })

  test('leaves a customer who already has one conversation alone', async () => {
    const f = await setup()
    const found = await findSplitConversations(f.db, f.workspaceId)
    expect(found).toHaveLength(0)

    const nothing = await mergeConversations(f.db, {
      workspaceId: f.workspaceId,
      survivorId: f.customerA.conversationId,
      absorbedIds: [],
    })
    expect(nothing).toBeNull()
  })
})
