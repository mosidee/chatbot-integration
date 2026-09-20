import type { ChannelAdapter, InboundEvent } from '@ci/channels'
import type { Logger } from '@ci/core'
import { type RedactionOptions, redactMessage } from '@ci/core'
import { type Database, newId, schema } from '@ci/db'
import type { WorkspaceSettings } from '@ci/db/schema/app'
import type {
  ConversationMode,
  HandoffReason,
  Language,
  NormalizedMessage,
  SenderType,
} from '@ci/shared'
import { messageToText } from '@ci/shared'
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'

/**
 * Database operations the processors need.
 *
 * Every function takes an explicit workspaceId and scopes its queries by it. That is the
 * tenancy guarantee; there is no ambient workspace.
 */

export async function loadWorkspaceSettings(
  db: Database,
  workspaceId: string,
): Promise<WorkspaceSettings> {
  const rows = await db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1)
  const settings = rows[0]?.settings
  if (!settings) throw new Error(`workspace ${workspaceId} has no settings`)
  return settings
}

export type ResolvedConversation = {
  conversationId: string
  customerId: string
  channelIdentityId: string
  mode: ConversationMode
  isNew: boolean
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
      })
      .returning()
    identity = inserted[0]
  } else if (event.profile?.displayName && identity.displayName !== event.profile.displayName) {
    await db
      .update(schema.channelIdentities)
      .set({ displayName: event.profile.displayName, updatedAt: new Date() })
      .where(eq(schema.channelIdentities.id, identity.id))
  }

  if (!identity) throw new Error('failed to resolve channel identity')

  // Reuse the most recent conversation that is not resolved; otherwise start a new one.
  const openConversation = await db
    .select()
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.channelIdentityId, identity.id),
        sql`${schema.conversations.status} <> 'resolved'`,
      ),
    )
    .orderBy(desc(schema.conversations.lastMessageAt))
    .limit(1)

  const windowExpiresAt =
    input.messagingWindowHours === null
      ? null
      : new Date(event.timestamp.getTime() + input.messagingWindowHours * 3600_000)

  const existing = openConversation[0]
  if (existing) {
    await db
      .update(schema.conversations)
      .set({
        lastMessageAt: event.timestamp,
        lastCustomerMessageAt: event.timestamp,
        messagingWindowExpiresAt: windowExpiresAt,
        unreadCount: sql`${schema.conversations.unreadCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(schema.conversations.id, existing.id))

    return {
      conversationId: existing.id,
      customerId: existing.customerId,
      channelIdentityId: identity.id,
      mode: existing.mode,
      isNew: false,
    }
  }

  const conversationId = newId()
  await db.insert(schema.conversations).values({
    id: conversationId,
    workspaceId,
    channelId,
    customerId: identity.customerId,
    channelIdentityId: identity.id,
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

export async function applyHandoff(
  db: Database,
  workspaceId: string,
  conversationId: string,
  reason: HandoffReason,
  at: Date,
): Promise<void> {
  await updateConversation(db, workspaceId, conversationId, {
    mode: 'waiting_human',
    handoffReason: reason,
    waitingHumanSince: at,
  })
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

export async function mergeCustomerFields(
  db: Database,
  workspaceId: string,
  customerId: string,
  updates: Record<string, string>,
): Promise<void> {
  if (Object.keys(updates).length === 0) return
  const rows = await db
    .select()
    .from(schema.customers)
    .where(and(eq(schema.customers.id, customerId), eq(schema.customers.workspaceId, workspaceId)))
    .limit(1)
  const current = rows[0]
  if (!current) return

  await db
    .update(schema.customers)
    .set({ fields: { ...current.fields, ...updates }, updatedAt: new Date() })
    .where(eq(schema.customers.id, customerId))
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
