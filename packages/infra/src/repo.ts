import type { ChannelAdapter, InboundEvent } from '@ci/channels'
import type { Logger } from '@ci/core'
import { type RedactionOptions, redactMessage } from '@ci/core'
import { type Database, newId, schema } from '@ci/db'
import type { WorkspaceSettings } from '@ci/db/schema/app'
import type {
  ConversationMode,
  Language,
  NormalizedMessage,
  SenderType,
  WorkspaceStatus,
} from '@ci/shared'
import { messageToText } from '@ci/shared'
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'

/**
 * Database operations the processors need.
 *
 * Every function takes an explicit workspaceId and scopes its queries by it. That is the
 * tenancy guarantee; there is no ambient workspace.
 */

export type LoadedWorkspace = {
  settings: WorkspaceSettings
  status: WorkspaceStatus
}

/**
 * The workspace a job is about: its settings and whether it may be worked on at all.
 *
 * Both come from the one row every processor already reads, so asking whether a tenant is
 * suspended costs nothing it was not already paying. A processor that reads the settings
 * and then asks about the status separately could be told the workspace is fine and act on
 * settings from before a suspension, which is the kind of gap worth closing by construction.
 */
export async function loadWorkspace(db: Database, workspaceId: string): Promise<LoadedWorkspace> {
  const rows = await db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1)
  const row = rows[0]
  if (!row?.settings) throw new Error(`workspace ${workspaceId} has no settings`)
  return { settings: withSettingsDefaults(row.settings), status: row.status }
}

export async function loadWorkspaceSettings(
  db: Database,
  workspaceId: string,
): Promise<WorkspaceSettings> {
  return (await loadWorkspace(db, workspaceId)).settings
}

/**
 * Whether a queued job should go ahead, given the state of its workspace.
 *
 * A suspended or deleting tenant does no work at all: no model call, no message stored, no
 * message sent. The job is dropped rather than failed, because failing it means BullMQ
 * retries it three times and then keeps it, and none of that changes the answer.
 *
 * It is logged every time. A dropped job is invisible otherwise, and somebody looking into
 * why a customer got no reply needs to find the reason rather than an absence.
 *
 * Note what this means for the AI turn in particular, since it is an exception to the
 * strongest rule in this codebase: normally every path out of a turn ends in a message to
 * the customer or a handoff to a person, precisely so nobody is left waiting. A suspended
 * workspace is the one case where the turn simply stops, and it is deliberate — there is no
 * colleague to hand off to, because every one of them is locked out too.
 */
export async function workspaceIsWorkable(
  db: Database,
  workspaceId: string,
  logger: Logger | undefined,
  queue: string,
): Promise<LoadedWorkspace | null> {
  const workspace = await loadWorkspace(db, workspaceId)
  if (workspace.status === 'active') return workspace

  logger?.info('workspace not active, job dropped', {
    queue,
    workspaceId,
    status: workspace.status,
  })
  return null
}

/**
 * Fill in keys added after a row was written.
 *
 * Settings are one jsonb document, so a workspace created before a key existed simply does
 * not have it. Defaulting on read means no backfill migration and no `undefined` reaching
 * a caller that reasonably expected the type it was given.
 */
export function withSettingsDefaults(settings: WorkspaceSettings): WorkspaceSettings {
  return {
    ...settings,
    identity: {
      // A widget token was already trusted before this key existed, so leaving it on
      // changes nothing for anyone. The link is new, and starts off.
      widgetToken: { enabled: settings.identity?.widgetToken?.enabled ?? true },
      verificationLink: {
        enabled: settings.identity?.verificationLink?.enabled ?? false,
        url: settings.identity?.verificationLink?.url ?? null,
        secretEncrypted: settings.identity?.verificationLink?.secretEncrypted ?? null,
        ttlMinutes: settings.identity?.verificationLink?.ttlMinutes ?? 15,
      },
    },
  }
}

export type ResolvedConversation = {
  conversationId: string
  customerId: string
  channelIdentityId: string
  mode: ConversationMode
  isNew: boolean
}

/** Who looks after this customer, if anybody. Null when nobody has claimed them. */
async function customerOwner(
  db: Database,
  workspaceId: string,
  customerId: string,
): Promise<string | null> {
  const rows = await db
    .select({ assigneeUserId: schema.customers.assigneeUserId })
    .from(schema.customers)
    .where(and(eq(schema.customers.id, customerId), eq(schema.customers.workspaceId, workspaceId)))
    .limit(1)
  return rows[0]?.assigneeUserId ?? null
}

/**
 * Find or create the identity, customer and open conversation for an inbound event.
 *
 * A new channel identity always gets its own customer row, so day one behaves as if no
 * merging existed. Linking identities is a later, human-confirmed action that repoints
 * `customerId`; nothing here ever merges automatically.
 */
export async function resolveConversation(
  db: Database,
  input: {
    workspaceId: string
    channelId: string
    event: InboundEvent
    defaultMode: ConversationMode
    defaultLanguage: Language
    messagingWindowHours: number | null
  },
): Promise<ResolvedConversation> {
  const { workspaceId, channelId, event } = input

  const existingIdentity = await db
    .select()
    .from(schema.channelIdentities)
    .where(
      and(
        // The workspace term is redundant — the channel already belongs to one — and it is
        // here anyway. This row now carries the proof of who a customer is, and that is the
        // last place to rely on an invariant enforced two files away.
        eq(schema.channelIdentities.workspaceId, workspaceId),
        eq(schema.channelIdentities.channelId, channelId),
        eq(schema.channelIdentities.externalId, event.externalId),
      ),
    )
    .limit(1)

  let identity = existingIdentity[0]

  if (!identity) {
    const customerId = newId()
    await db.insert(schema.customers).values({
      id: customerId,
      workspaceId,
      displayName: event.profile?.displayName ?? null,
      primaryLanguage: input.defaultLanguage,
      fields: {},
    })

    const inserted = await db
      .insert(schema.channelIdentities)
      .values({
        id: newId(),
        workspaceId,
        channelId,
        externalId: event.externalId,
        customerId,
        displayName: event.profile?.displayName ?? null,
        avatarUrl: event.profile?.avatarUrl ?? null,
        profile: {},
        ...(event.verified
          ? {
              verifiedSubject: event.verified.subject,
              verifiedAttributes: event.verified.attributes,
              verifiedVia: event.verified.via,
              verifiedAt: new Date(),
            }
          : {}),
      })
      .returning()
    identity = inserted[0]
  } else {
    const patch: Partial<typeof schema.channelIdentities.$inferInsert> = {}
    if (event.profile?.displayName && identity.displayName !== event.profile.displayName) {
      patch.displayName = event.profile.displayName
    }
    // Re-recorded whenever a proof accompanies a message. That is how a changed plan
    // reaches us, but only once the channel presents a fresh proof: a widget session
    // carries the attributes it was minted with for its whole twelve hours, so what
    // arrives here is unchanged until the page is loaded again.
    if (event.verified) {
      patch.verifiedSubject = event.verified.subject
      patch.verifiedAttributes = event.verified.attributes
      patch.verifiedVia = event.verified.via
      patch.verifiedAt = new Date()
    }
    if (Object.keys(patch).length > 0) {
      patch.updatedAt = new Date()
      await db
        .update(schema.channelIdentities)
        .set(patch)
        .where(
          and(
            eq(schema.channelIdentities.id, identity.id),
            eq(schema.channelIdentities.workspaceId, workspaceId),
          ),
        )
      identity = { ...identity, ...patch } as typeof identity
    }
  }

  if (!identity) throw new Error('failed to resolve channel identity')

  /**
   * The most recent conversation this person has on this channel, whatever state it is in.
   *
   * A resolved conversation is reopened rather than replaced. The customer sees one
   * unbroken chat in LINE or Messenger, and splitting it at the moment a colleague decided
   * they were finished gives the agent a fragment of what the customer is looking at.
   * Resolving means done for now, not closed for good.
   */
  const openConversation = await db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.channelIdentityId, identity.id))
    .orderBy(desc(schema.conversations.lastMessageAt))
    .limit(1)

  const windowExpiresAt =
    input.messagingWindowHours === null
      ? null
      : new Date(event.timestamp.getTime() + input.messagingWindowHours * 3600_000)

  const existing = openConversation[0]
  if (existing) {
    /**
     * Coming back after it was resolved starts the conversation again, in the mode a new
     * one would have started in.
     *
     * Keeping the old mode would be worse than splitting: a thread an agent resolved is
     * left in `human`, so the AI may only suggest, and the customer's new question waits
     * for somebody who already considers this finished. The handoff reason goes with it,
     * because it belonged to the episode that ended.
     *
     * This is why the state machine never sees a resolved conversation on a customer
     * message: the decision about what mode a conversation begins in is made here, and
     * beginning again is the same decision.
     */
    const reopening = existing.status === 'resolved'

    /**
     * A conversation beginning again belongs to whoever owns the customer.
     *
     * Looked up only when reopening, which is rare, rather than on every inbound message.
     * Without this the owner would be almost meaningless at the conversation level: a
     * conversation is now created only for an identity that has never written before, so a
     * returning customer would never pick up an owner assigned since their last message.
     */
    const owner = reopening ? await customerOwner(db, workspaceId, existing.customerId) : null

    await db
      .update(schema.conversations)
      .set({
        lastMessageAt: event.timestamp,
        lastCustomerMessageAt: event.timestamp,
        messagingWindowExpiresAt: windowExpiresAt,
        unreadCount: sql`${schema.conversations.unreadCount} + 1`,
        ...(reopening
          ? {
              status: 'open' as const,
              mode: input.defaultMode,
              handoffReason: null,
              waitingHumanSince: null,
              // Only when there is one: a customer nobody owns leaves the conversation with
              // whoever last handled it, who is the best guess available.
              ...(owner ? { assigneeUserId: owner } : {}),
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.conversations.id, existing.id))

    return {
      conversationId: existing.id,
      customerId: existing.customerId,
      channelIdentityId: identity.id,
      mode: reopening ? input.defaultMode : existing.mode,
      isNew: false,
    }
  }

  /**
   * A new conversation starts with the customer's owner, if they have one.
   *
   * This is what makes the owner a default rather than a label: somebody who looks after a
   * customer finds their next conversation already theirs, without anybody claiming it by
   * hand. A colleague can still take this one thread afterwards, and doing so does not
   * change who owns the relationship.
   *
   * Rare in practice, because a brand-new identity brings a brand-new customer with nobody
   * looking after them yet. It matters once an existing customer is reached on a channel
   * they have not used before.
   */
  const newOwner = await customerOwner(db, workspaceId, identity.customerId)

  const conversationId = newId()
  await db.insert(schema.conversations).values({
    id: conversationId,
    workspaceId,
    channelId,
    customerId: identity.customerId,
    channelIdentityId: identity.id,
    assigneeUserId: newOwner,
    mode: input.defaultMode,
    status: 'open',
    lastMessageAt: event.timestamp,
    lastCustomerMessageAt: event.timestamp,
    messagingWindowExpiresAt: windowExpiresAt,
    unreadCount: 1,
  })

  return {
    conversationId,
    customerId: identity.customerId,
    channelIdentityId: identity.id,
    mode: input.defaultMode,
    isNew: true,
  }
}

/** Store a message, redacting it first. Nothing sensitive is ever written. */
export async function storeMessage(
  db: Database,
  input: {
    workspaceId: string
    conversationId: string
    direction: 'inbound' | 'outbound'
    senderType: SenderType
    senderUserId?: string | null
    message: NormalizedMessage
    platformMessageId?: string | null
    status?: 'queued' | 'sent' | 'delivered' | 'read' | 'failed'
    aiTraceId?: string | null
    redaction: RedactionOptions
  },
): Promise<{ id: string; message: NormalizedMessage; text: string; duplicate: boolean }> {
  const { message, findings } = redactMessage(input.message, input.redaction)
  const text = messageToText(message)
  const id = newId()

  // Platforms retry webhooks. The unique index on (conversation, platform id) turns a
  // retry into a no-op rather than a second copy of the customer's message.
  const inserted = await db
    .insert(schema.messages)
    .values({
      id,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      direction: input.direction,
      senderType: input.senderType,
      senderUserId: input.senderUserId ?? null,
      content: message,
      text,
      redactionFindings: findings,
      platformMessageId: input.platformMessageId ?? null,
      status: input.status ?? 'sent',
      aiTraceId: input.aiTraceId ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: schema.messages.id })

  return { id, message, text, duplicate: inserted.length === 0 }
}

export type TurnContext = {
  conversation: typeof schema.conversations.$inferSelect
  customer: typeof schema.customers.$inferSelect
  identity: typeof schema.channelIdentities.$inferSelect
  channel: typeof schema.channels.$inferSelect
  recentMessages: (typeof schema.messages.$inferSelect)[]
  notes: (typeof schema.internalNotes.$inferSelect)[]
}

/** Everything one AI turn needs, in as few round trips as is reasonable. */
export async function loadTurnContext(
  db: Database,
  workspaceId: string,
  conversationId: string,
  messageLimit = 30,
): Promise<TurnContext | null> {
  const conversationRows = await db
    .select()
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.id, conversationId),
        eq(schema.conversations.workspaceId, workspaceId),
      ),
    )
    .limit(1)

  const conversation = conversationRows[0]
  if (!conversation) return null

  const [customerRows, identityRows, channelRows, messageRows, noteRows] = await Promise.all([
    db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.id, conversation.customerId))
      .limit(1),
    db
      .select()
      .from(schema.channelIdentities)
      .where(eq(schema.channelIdentities.id, conversation.channelIdentityId))
      .limit(1),
    db
      .select()
      .from(schema.channels)
      .where(eq(schema.channels.id, conversation.channelId))
      .limit(1),
    db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
      .orderBy(desc(schema.messages.createdAt))
      .limit(messageLimit),
    db
      .select()
      .from(schema.internalNotes)
      .where(eq(schema.internalNotes.conversationId, conversationId))
      .orderBy(asc(schema.internalNotes.createdAt))
      .limit(20),
  ])

  const customer = customerRows[0]
  const identity = identityRows[0]
  const channel = channelRows[0]
  if (!customer || !identity || !channel) return null

  return {
    conversation,
    customer,
    identity,
    channel,
    // The query is newest-first for the LIMIT; the prompt needs oldest-first.
    recentMessages: messageRows.reverse(),
    notes: noteRows,
  }
}

export async function updateConversation(
  db: Database,
  workspaceId: string,
  conversationId: string,
  patch: Partial<typeof schema.conversations.$inferInsert>,
): Promise<void> {
  if (Object.keys(patch).length === 0) return
  await db
    .update(schema.conversations)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(schema.conversations.id, conversationId),
        eq(schema.conversations.workspaceId, workspaceId),
      ),
    )
}

export async function addInternalNote(
  db: Database,
  input: {
    workspaceId: string
    conversationId: string
    authorType: SenderType
    authorUserId?: string | null
    body: string
  },
): Promise<string> {
  const id = newId()
  await db.insert(schema.internalNotes).values({
    id,
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    authorType: input.authorType,
    authorUserId: input.authorUserId ?? null,
    body: input.body,
  })
  return id
}

export async function recordTrace(
  db: Database,
  workspaceId: string,
  conversationId: string | null,
  trace: {
    task: string
    providerId: string | null
    providerName: string | null
    model: string | null
    usedFallback: boolean
    prompt: unknown
    toolCalls: unknown
    retrieved: unknown
    tokensIn: number | null
    tokensOut: number | null
    latencyMs: number
    costEstimate: number | null
    outcome: 'sent' | 'draft' | 'handoff' | 'error'
    error: string | null
  },
): Promise<string> {
  const id = newId()
  await db.insert(schema.aiTraces).values({
    id,
    workspaceId,
    conversationId,
    task: trace.task as (typeof schema.aiTaskEnum.enumValues)[number],
    providerId: trace.providerId,
    providerName: trace.providerName,
    model: trace.model,
    usedFallback: trace.usedFallback,
    prompt: trace.prompt,
    toolCalls: trace.toolCalls,
    retrieved: trace.retrieved,
    tokensIn: trace.tokensIn,
    tokensOut: trace.tokensOut,
    latencyMs: trace.latencyMs,
    costEstimate: trace.costEstimate === null ? null : String(trace.costEstimate),
    outcome: trace.outcome,
    error: trace.error,
  })
  return id
}

/**
 * Fill in a customer's name and avatar from the platform.
 *
 * Messenger's webhook carries only a page-scoped id, so without this every conversation shows
 * an opaque number in the inbox. LINE includes no profile either. The lookup runs once, when
 * the identity is new or still nameless, and a failure is not worth interrupting anyone over:
 * a customer who has blocked the account has no readable profile at all.
 */
export async function enrichIdentityProfile(
  db: Database,
  input: {
    workspaceId: string
    identityId: string
    externalId: string
    adapter: Pick<ChannelAdapter<never>, 'fetchProfile'>
    config: unknown
    logger: Logger
  },
): Promise<void> {
  const fetchProfile = input.adapter.fetchProfile
  if (!fetchProfile) return

  const rows = await db
    .select()
    .from(schema.channelIdentities)
    .where(eq(schema.channelIdentities.id, input.identityId))
    .limit(1)
  const identity = rows[0]
  if (!identity || identity.displayName) return

  try {
    const profile = await fetchProfile(input.externalId, input.config as never)
    if (!profile?.displayName) return

    await db
      .update(schema.channelIdentities)
      .set({
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        profile: profile.raw,
        updatedAt: new Date(),
      })
      .where(eq(schema.channelIdentities.id, identity.id))

    // The customer record carries the name agents actually see in the inbox.
    await db
      .update(schema.customers)
      .set({ displayName: profile.displayName, updatedAt: new Date() })
      .where(
        and(eq(schema.customers.id, identity.customerId), isNull(schema.customers.displayName)),
      )
  } catch (error) {
    input.logger.warn('could not read the customer profile', {
      externalId: input.externalId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Record identifiers the customer has given, and report which ones actually changed.
 *
 * The caller needs that list because a changed identifier is what can make this customer
 * look like one we already know. Re-hearing a phone number we already had is not news, and
 * scanning for a twin on every turn that merely repeats it would be work for nothing.
 */
export async function mergeCustomerFields(
  db: Database,
  workspaceId: string,
  customerId: string,
  updates: Record<string, string>,
): Promise<string[]> {
  if (Object.keys(updates).length === 0) return []
  const rows = await db
    .select()
    .from(schema.customers)
    .where(and(eq(schema.customers.id, customerId), eq(schema.customers.workspaceId, workspaceId)))
    .limit(1)
  const current = rows[0]
  if (!current) return []

  const changed = Object.keys(updates).filter((key) => current.fields[key] !== updates[key])
  if (changed.length === 0) return []

  await db
    .update(schema.customers)
    .set({ fields: { ...current.fields, ...updates }, updatedAt: new Date() })
    .where(eq(schema.customers.id, customerId))

  return changed
}

export async function addConversationTags(
  db: Database,
  workspaceId: string,
  conversationId: string,
  tags: string[],
): Promise<void> {
  if (tags.length === 0) return
  const rows = await db
    .select({ tags: schema.conversations.tags })
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.id, conversationId),
        eq(schema.conversations.workspaceId, workspaceId),
      ),
    )
    .limit(1)

  const current = rows[0]?.tags ?? []
  const merged = [...new Set([...current, ...tags])]
  await updateConversation(db, workspaceId, conversationId, { tags: merged })
}

/**
 * Record that a draft became a real message.
 *
 * Called whether the agent pressed "insert and send" or inserted the draft, rewrote half
 * of it and sent that. Both are the AI's draft reaching a customer, and the difference
 * between them is the interesting part: comparing the stored `messageText` with the
 * message's own text says whether the draft was trusted or corrected, without asking the
 * agent to tell us.
 */
export async function markSuggestionSent(
  db: Database,
  workspaceId: string,
  conversationId: string,
  suggestionId: string,
  messageId: string,
): Promise<boolean> {
  const rows = await db
    .update(schema.suggestions)
    .set({ status: 'sent', sentMessageId: messageId })
    .where(
      and(
        eq(schema.suggestions.id, suggestionId),
        eq(schema.suggestions.workspaceId, workspaceId),
        eq(schema.suggestions.conversationId, conversationId),
      ),
    )
    .returning({ id: schema.suggestions.id })
  return rows.length > 0
}
