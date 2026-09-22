import { type Database, newId, schema } from '@ci/db'
import type { MergeMatchKey } from '@ci/shared'
import { and, eq, inArray, or, sql } from 'drizzle-orm'

/**
 * Noticing that two customer records are one person, and joining them when a human says so.
 *
 * Every channel identity gets its own customer row on arrival, because guessing at the
 * moment a stranger first writes is how one person's history ends up in front of another.
 * The cost is duplicates: the same salon owner asking on LINE and again through the widget
 * is two records, and the widget alone makes a new one per anonymous browser. This is what
 * cleans that up, at the speed of a person reading the evidence and agreeing.
 *
 * Nothing here merges on its own. The machine proposes, a person disposes, and a rejection
 * is remembered so the same pair is never raised twice.
 */

/** Keys strong enough to propose a merge. `order_id` and `company` are deliberately absent. */
const MATCH_KEYS: MergeMatchKey[] = ['phone', 'email', 'account_id']

/**
 * The comparable form of an identifier. Returns null for anything too weak to match on.
 *
 * The value the customer typed is never rewritten — only this derived form is compared, so
 * the record keeps saying what they actually wrote.
 */
export function normaliseMatchValue(key: MergeMatchKey, raw: string): string | null {
  const value = raw.trim()
  if (value === '') return null

  if (key === 'email') {
    const lower = value.toLowerCase()
    // Nothing clever about the local part: plus-addressing and dots mean different things
    // at different providers, and folding them would merge two people who are not one.
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(lower) ? lower : null
  }

  if (key === 'phone') {
    const digits = value.replace(/[^\d+]/g, '')
    const bare = digits.replace(/\D/g, '')
    if (bare.length < 9) return null
    // Thailand writes one mobile number three ways: 081 234 5678, +66 81 234 5678 and
    // 0066…. They are the same phone, and without this the feature almost never fires.
    if (bare.startsWith('66') && bare.length === 11) return `0${bare.slice(2)}`
    if (bare.startsWith('0066')) return `0${bare.slice(4)}`
    return bare
  }

  // An account id is opaque and may well be case-sensitive, so it is compared exactly.
  // Folding case here could join two accounts that differ only by it.
  return value.length >= 4 ? value : null
}

/** The pair in its stored order: the older record first, because that is the one that survives. */
function orderPair(a: string, b: string): [string, string] {
  // Ids are UUIDv7 and therefore time-ordered, so the smaller string is the older record.
  return a < b ? [a, b] : [b, a]
}

export type MergeCandidate = { otherCustomerId: string; key: MergeMatchKey; value: string }

/**
 * Other customers in this workspace holding one of the same identifiers.
 *
 * Normalisation happens here rather than in SQL, so the candidate set is every customer
 * carrying the key at all. At a pilot's scale that is a small read; if a workspace ever
 * grows to where it is not, the answer is a generated column on the normalised value with
 * an index on it, not a cleverer query.
 */
export async function findMergeCandidates(
  db: Database,
  workspaceId: string,
  customerId: string,
  keys: MergeMatchKey[],
): Promise<MergeCandidate[]> {
  const interesting = keys.filter((key) => MATCH_KEYS.includes(key))
  if (interesting.length === 0) return []

  const rows = await db
    .select()
    .from(schema.customers)
    .where(eq(schema.customers.workspaceId, workspaceId))

  const mine = rows.find((row) => row.id === customerId)
  if (!mine) return []

  const wanted = new Map<MergeMatchKey, string>()
  for (const key of interesting) {
    const normalised = normaliseMatchValue(key, mine.fields[key] ?? '')
    if (normalised) wanted.set(key, normalised)
  }
  if (wanted.size === 0) return []

  const found: MergeCandidate[] = []
  for (const row of rows) {
    if (row.id === customerId) continue
    for (const [key, value] of wanted) {
      if (normaliseMatchValue(key, row.fields[key] ?? '') === value) {
        found.push({ otherCustomerId: row.id, key, value })
        break // One reason per pair is enough to put it in front of a person.
      }
    }
  }
  return found
}

/**
 * Raise these pairs with a human, unless the pair has been raised before.
 *
 * `onConflictDoNothing` is what makes a rejection permanent: the row stays with its
 * `rejected` status and every later attempt to propose the same two people is a no-op.
 * Without it the panel would ask again on the customer's very next message.
 */
export async function proposeMerges(
  db: Database,
  workspaceId: string,
  customerId: string,
  candidates: MergeCandidate[],
): Promise<number> {
  if (candidates.length === 0) return 0

  const values = candidates.map((candidate) => {
    const [older, newer] = orderPair(customerId, candidate.otherCustomerId)
    return {
      id: newId(),
      workspaceId,
      customerId: older,
      otherCustomerId: newer,
      matchKey: candidate.key,
      matchValue: candidate.value,
    }
  })

  const inserted = await db
    .insert(schema.mergeSuggestions)
    .values(values)
    .onConflictDoNothing({
      target: [schema.mergeSuggestions.customerId, schema.mergeSuggestions.otherCustomerId],
    })
    .returning({ id: schema.mergeSuggestions.id })

  return inserted.length
}

/** Detect and propose in one step, for the worker to call after it records a field. */
export async function suggestMergesFor(
  db: Database,
  workspaceId: string,
  customerId: string,
  changedKeys: string[],
): Promise<number> {
  const keys = changedKeys.filter((key): key is MergeMatchKey =>
    MATCH_KEYS.includes(key as MergeMatchKey),
  )
  if (keys.length === 0) return 0
  const candidates = await findMergeCandidates(db, workspaceId, customerId, keys)
  return proposeMerges(db, workspaceId, customerId, candidates)
}

export type MergeSuggestionRow = typeof schema.mergeSuggestions.$inferSelect

/** Everything still awaiting a decision about this customer, whichever side of the pair they are. */
export async function listMergeSuggestions(
  db: Database,
  workspaceId: string,
  customerId: string,
): Promise<MergeSuggestionRow[]> {
  return db
    .select()
    .from(schema.mergeSuggestions)
    .where(
      and(
        eq(schema.mergeSuggestions.workspaceId, workspaceId),
        eq(schema.mergeSuggestions.status, 'pending'),
        or(
          eq(schema.mergeSuggestions.customerId, customerId),
          eq(schema.mergeSuggestions.otherCustomerId, customerId),
        ),
      ),
    )
}

/** Say no, permanently. The row survives precisely so the pair is never raised again. */
export async function rejectMergeSuggestion(
  db: Database,
  workspaceId: string,
  suggestionId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .update(schema.mergeSuggestions)
    .set({ status: 'rejected', decidedByUserId: userId, decidedAt: new Date() })
    .where(
      and(
        eq(schema.mergeSuggestions.id, suggestionId),
        eq(schema.mergeSuggestions.workspaceId, workspaceId),
        eq(schema.mergeSuggestions.status, 'pending'),
      ),
    )
    .returning({ id: schema.mergeSuggestions.id })
  return rows.length > 0
}

export type MergeResult = {
  survivorId: string
  absorbedId: string
  identities: number
  conversations: number
  embeddings: number
  summaries: number
}

/**
 * Join two customers into one.
 *
 * The order of these statements is the whole safety of the operation. Every table that
 * points at a customer does so with `ON DELETE CASCADE`, which is what lets an erasure
 * request take a person's entire history out with one delete. Here that same cascade is a
 * loaded gun: deleting the absorbed record before its conversations have been moved would
 * destroy them, permanently and silently. So everything is repointed first, the delete is
 * the last statement, and the whole thing is one transaction, because a merge that stopped
 * half way would leave a customer whose history had partly moved.
 *
 * Five tables reference `customers.id`. Four are repointed below because their rows are the
 * person's history. The fifth, `merge_suggestions`, is deliberately left to the cascade: a
 * proposal naming the absorbed customer is answered by this very merge, and one naming the
 * survivor is re-derived afterwards. A new table that stores anything a person would want
 * to keep must be added to the repoint list, or the cascade will delete it.
 */
export async function mergeCustomers(
  db: Database,
  input: { workspaceId: string; survivorId: string; absorbedId: string; userId?: string | null },
): Promise<MergeResult | null> {
  if (input.survivorId === input.absorbedId) return null

  const rows = await db
    .select()
    .from(schema.customers)
    .where(
      and(
        eq(schema.customers.workspaceId, input.workspaceId),
        inArray(schema.customers.id, [input.survivorId, input.absorbedId]),
      ),
    )
  const survivor = rows.find((row) => row.id === input.survivorId)
  const absorbed = rows.find((row) => row.id === input.absorbedId)
  if (!survivor || !absorbed) return null

  return db.transaction(async (tx) => {
    const repoint = async (
      table:
        | typeof schema.channelIdentities
        | typeof schema.conversations
        | typeof schema.conversationEmbeddings
        | typeof schema.customerSummaries,
    ) => {
      const moved = await tx
        .update(table)
        .set({ customerId: input.survivorId })
        .where(
          and(eq(table.workspaceId, input.workspaceId), eq(table.customerId, input.absorbedId)),
        )
        .returning({ id: table.id })
      return moved.length
    }

    const identities = await repoint(schema.channelIdentities)
    const conversations = await repoint(schema.conversations)
    const embeddings = await repoint(schema.conversationEmbeddings)
    const summaries = await repoint(schema.customerSummaries)

    // What the absorbed record knew, without overwriting what the survivor already knew.
    // The survivor is the older record, so where the two disagree its version is the one
    // that has been true for longer.
    await tx
      .update(schema.customers)
      .set({
        fields: { ...absorbed.fields, ...survivor.fields },
        // A column on `customers` is not covered by the repoint list below, so a note the
        // survivor happens not to have is dropped with the absorbed row unless it is named
        // here. Same rule as the owner beneath: survivor wins per key, absorbed fills gaps.
        notes: { ...absorbed.notes, ...survivor.notes },
        displayName: survivor.displayName ?? absorbed.displayName,
        primaryLanguage: survivor.primaryLanguage ?? absorbed.primaryLanguage,
        summary: survivor.summary ?? absorbed.summary,
        // An owner is not a table, so the repoint list below does not cover it: a column
        // the survivor happens to be missing is simply dropped with the absorbed row unless
        // it is named here. Somebody looking after the absorbed record keeps looking after
        // the person, which is the whole point of the relationship surviving a merge.
        assigneeUserId: survivor.assigneeUserId ?? absorbed.assigneeUserId,
        updatedAt: new Date(),
      })
      .where(eq(schema.customers.id, input.survivorId))

    // Last, and only now that nothing points at it any more.
    await tx.delete(schema.customers).where(eq(schema.customers.id, input.absorbedId))

    // Outlives both rows and the suggestion that proposed it, and names no one: the ids
    // are the record that these two were judged to be one person, and by whom.
    await tx.insert(schema.auditLog).values({
      id: newId(),
      workspaceId: input.workspaceId,
      actorUserId: input.userId ?? null,
      action: 'customer.merged',
      targetType: 'customer',
      targetId: input.survivorId,
      meta: {
        absorbedCustomerId: input.absorbedId,
        identities,
        conversations,
        embeddings,
        summaries,
      },
    })

    return {
      survivorId: input.survivorId,
      absorbedId: input.absorbedId,
      identities,
      conversations,
      embeddings,
      summaries,
    }
  })
}

/**
 * Accept a proposal. The older record survives, which is what the stored pair order means.
 *
 * The suggestion row is not marked accepted, because it does not survive: it points at the
 * absorbed customer and cascades away with them. The audit entry is the lasting record.
 *
 * Afterwards the survivor is checked again, because it now carries both sets of
 * identifiers and may match a third record. One consequence is deliberate: a pair rejected
 * against the absorbed customer's id is gone with that customer, so the survivor and that
 * third record can be proposed afresh. They are a different pair, and nobody has yet said
 * no to it.
 */
export async function acceptMergeSuggestion(
  db: Database,
  workspaceId: string,
  suggestionId: string,
  userId: string,
): Promise<MergeResult | null> {
  const rows = await db
    .select()
    .from(schema.mergeSuggestions)
    .where(
      and(
        eq(schema.mergeSuggestions.id, suggestionId),
        eq(schema.mergeSuggestions.workspaceId, workspaceId),
        eq(schema.mergeSuggestions.status, 'pending'),
      ),
    )
    .limit(1)
  const suggestion = rows[0]
  if (!suggestion) return null

  const merged = await mergeCustomers(db, {
    workspaceId,
    survivorId: suggestion.customerId,
    absorbedId: suggestion.otherCustomerId,
    userId,
  })
  if (!merged) return null

  // The survivor now carries both sets of identifiers, so it may match somebody else.
  // Anything that was pending against the absorbed record went with it.
  await suggestMergesFor(db, workspaceId, merged.survivorId, [...MATCH_KEYS])

  return merged
}

/** Pending proposals across the workspace, for a count or a review screen. */
export async function countPendingMerges(db: Database, workspaceId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.mergeSuggestions)
    .where(
      and(
        eq(schema.mergeSuggestions.workspaceId, workspaceId),
        eq(schema.mergeSuggestions.status, 'pending'),
      ),
    )
  return rows[0]?.count ?? 0
}

// ---------------------------------------------------------------------------
// Joining conversations that should have been one
// ---------------------------------------------------------------------------

/**
 * A person's conversations on one channel, when there is more than one of them.
 *
 * These exist because a resolved conversation used to be final: the customer's next message
 * started a new one, so a single unbroken chat on their phone became several rows here.
 * That no longer happens, and this is for the history it left behind.
 */
export type SplitConversations = {
  channelIdentityId: string
  externalId: string
  displayName: string | null
  /** The one future messages will reopen: the most recently active. */
  survivorId: string
  absorbedIds: string[]
  messages: number
}

export async function findSplitConversations(
  db: Database,
  workspaceId: string,
): Promise<SplitConversations[]> {
  const rows = await db
    .select({
      id: schema.conversations.id,
      channelIdentityId: schema.conversations.channelIdentityId,
      externalId: schema.channelIdentities.externalId,
      displayName: schema.customers.displayName,
      lastMessageAt: schema.conversations.lastMessageAt,
      createdAt: schema.conversations.createdAt,
    })
    .from(schema.conversations)
    .innerJoin(
      schema.channelIdentities,
      eq(schema.channelIdentities.id, schema.conversations.channelIdentityId),
    )
    .innerJoin(schema.customers, eq(schema.customers.id, schema.conversations.customerId))
    .where(eq(schema.conversations.workspaceId, workspaceId))

  const byIdentity = new Map<string, typeof rows>()
  for (const row of rows) {
    const group = byIdentity.get(row.channelIdentityId) ?? []
    group.push(row)
    byIdentity.set(row.channelIdentityId, group)
  }

  const split: SplitConversations[] = []
  for (const [channelIdentityId, group] of byIdentity) {
    if (group.length < 2) continue

    /**
     * The survivor is the most recently active, because that is the one the next inbound
     * message reopens. Merging into anything else would leave the thread the customer is
     * about to continue separate from the history just moved.
     */
    const ordered = [...group].sort(
      (a, b) =>
        (b.lastMessageAt?.getTime() ?? b.createdAt.getTime()) -
        (a.lastMessageAt?.getTime() ?? a.createdAt.getTime()),
    )
    const survivor = ordered[0]
    if (!survivor) continue

    const ids = ordered.map((row) => row.id)
    const counted = await db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.workspaceId, workspaceId),
          inArray(schema.messages.conversationId, ids),
        ),
      )

    split.push({
      channelIdentityId,
      externalId: survivor.externalId,
      displayName: survivor.displayName,
      survivorId: survivor.id,
      absorbedIds: ordered.slice(1).map((row) => row.id),
      messages: counted.length,
    })
  }

  return split
}

export type ConversationMergeResult = {
  messages: number
  notes: number
  suggestions: number
  feedback: number
  handoffEvents: number
  traces: number
  embeddings: number
  verifications: number
  absorbed: number
}

/**
 * Fold several conversations into one.
 *
 * Every table that hangs off a conversation cascades on delete, so the order here is the
 * same one `mergeCustomers` takes and for the same reason: repoint everything first, delete
 * the emptied rows last. Deleting before repointing would take the messages, the notes, the
 * traces and the feedback with them, and say nothing about it.
 *
 * The survivor keeps its own status, mode and owner — it is the live thread — and takes the
 * earliest creation date, because the conversation now starts where the oldest message does.
 */
export async function mergeConversations(
  db: Database,
  input: {
    workspaceId: string
    survivorId: string
    absorbedIds: string[]
    userId?: string | null
  },
): Promise<ConversationMergeResult | null> {
  const absorbedIds = input.absorbedIds.filter((id) => id !== input.survivorId)
  if (absorbedIds.length === 0) return null

  const rows = await db
    .select()
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.workspaceId, input.workspaceId),
        inArray(schema.conversations.id, [input.survivorId, ...absorbedIds]),
      ),
    )
  const survivor = rows.find((row) => row.id === input.survivorId)
  if (!survivor || rows.length !== absorbedIds.length + 1) return null

  return db.transaction(async (tx) => {
    const repoint = async (
      table:
        | typeof schema.messages
        | typeof schema.internalNotes
        | typeof schema.suggestions
        | typeof schema.feedback
        | typeof schema.handoffEvents
        | typeof schema.aiTraces
        | typeof schema.conversationEmbeddings
        | typeof schema.identityVerifications,
    ) => {
      const moved = await tx
        .update(table)
        .set({ conversationId: input.survivorId })
        .where(
          and(eq(table.workspaceId, input.workspaceId), inArray(table.conversationId, absorbedIds)),
        )
        .returning({ id: table.id })
      return moved.length
    }

    const messages = await repoint(schema.messages)
    const notes = await repoint(schema.internalNotes)
    const suggestions = await repoint(schema.suggestions)
    const feedback = await repoint(schema.feedback)
    const handoffEvents = await repoint(schema.handoffEvents)
    const traces = await repoint(schema.aiTraces)
    const embeddings = await repoint(schema.conversationEmbeddings)
    const verifications = await repoint(schema.identityVerifications)

    const absorbedRows = rows.filter((row) => row.id !== input.survivorId)
    const earliest = [survivor, ...absorbedRows].reduce(
      (oldest, row) => (row.createdAt < oldest ? row.createdAt : oldest),
      survivor.createdAt,
    )
    const tags = [...new Set([survivor.tags, ...absorbedRows.map((row) => row.tags)].flat())]

    await tx
      .update(schema.conversations)
      .set({ createdAt: earliest, tags, updatedAt: new Date() })
      .where(eq(schema.conversations.id, input.survivorId))

    // Last, and only now that nothing points at them.
    await tx
      .delete(schema.conversations)
      .where(
        and(
          eq(schema.conversations.workspaceId, input.workspaceId),
          inArray(schema.conversations.id, absorbedIds),
        ),
      )

    await tx.insert(schema.auditLog).values({
      id: newId(),
      workspaceId: input.workspaceId,
      actorUserId: input.userId ?? null,
      action: 'conversation.merged',
      targetType: 'conversation',
      targetId: input.survivorId,
      meta: { absorbed: absorbedIds, messages },
    })

    return {
      messages,
      notes,
      suggestions,
      feedback,
      handoffEvents,
      traces,
      embeddings,
      verifications,
      absorbed: absorbedIds.length,
    }
  })
}

export type WorkspaceSplits = {
  workspaceId: string
  slug: string
  status: string
  groups: SplitConversations[]
}

/**
 * Every workspace that has split conversations, named so a report is readable.
 *
 * Here rather than in the script because `scripts/` cannot resolve the query builder, and
 * because a cross-workspace sweep is the kind of thing worth having in one tested place
 * rather than written again each time somebody needs it.
 */
export async function findAllSplitConversations(db: Database): Promise<WorkspaceSplits[]> {
  const workspaces = await db
    .select({
      workspaceId: schema.workspaces.id,
      slug: schema.organization.slug,
      status: schema.workspaces.status,
    })
    .from(schema.workspaces)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.workspaces.id))

  const found: WorkspaceSplits[] = []
  for (const workspace of workspaces) {
    // A suspended or deleting tenant is left alone: its data is either frozen on purpose or
    // about to go, and neither is a moment to rewrite its history.
    if (workspace.status !== 'active') {
      found.push({ ...workspace, groups: [] })
      continue
    }
    found.push({ ...workspace, groups: await findSplitConversations(db, workspace.workspaceId) })
  }
  return found
}
