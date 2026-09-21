import type {
  AiTask,
  ChannelEventKind,
  ConversationMode,
  ConversationStatus,
  FeedbackRating,
  FeedbackReason,
  FeedbackTargetType,
  HandoffReason,
  Language,
  MergeMatchKey,
  MergeSuggestionStatus,
  MessageDirection,
  MessageStatus,
  NormalizedMessage,
  SenderType,
} from '@ci/shared'
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { organization, user } from './auth'

/**
 * Application schema.
 *
 * Tenancy rule: every tenant-owned table carries `workspaceId` and every query must be
 * scoped by it, with an explicit `eq(table.workspaceId, workspaceId)` in the WHERE. There
 * is no ambient workspace and no helper that adds it for you.
 *
 * IDs are UUIDv7 (time-ordered) generated in the application via `newId()` in ../id.ts,
 * stored as text so they join cleanly with Better Auth's text ids.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true })

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const channelTypeEnum = pgEnum('channel_type', ['test', 'web', 'line', 'messenger'])
export const conversationModeEnum = pgEnum('conversation_mode', [
  'ai',
  'ai_supervised',
  'human',
  'waiting_human',
])
export const conversationStatusEnum = pgEnum('conversation_status', ['open', 'snoozed', 'resolved'])
export const messageDirectionEnum = pgEnum('message_direction', ['inbound', 'outbound'])
export const senderTypeEnum = pgEnum('sender_type', ['customer', 'ai', 'human', 'system'])
export const messageStatusEnum = pgEnum('message_status', [
  'queued',
  'sent',
  'delivered',
  'read',
  'failed',
])
export const handoffReasonEnum = pgEnum('handoff_reason', [
  'ai_requested',
  'customer_requested',
  'low_confidence',
  'negative_sentiment',
  'keyword_rule',
  'unsupported_media',
  'tool_error',
  'model_error',
])
export const aiTaskEnum = pgEnum('ai_task', [
  'agent_chat',
  'vision',
  'suggestion_for_human',
  'summarize',
  'classify_intent_and_handoff',
  'embed',
  'rerank',
])
export const suggestionStatusEnum = pgEnum('suggestion_status', [
  'pending',
  /**
   * Nothing writes this. Inserting a draft into the composer is not a decision — the agent
   * may still edit it away or never send — so the status only moves when the message goes.
   * The value stays because dropping one from a Postgres enum means rebuilding the type.
   */
  'inserted',
  'sent',
  'discarded',
])
export const aiOutcomeEnum = pgEnum('ai_outcome', ['sent', 'draft', 'handoff', 'error'])

export const feedbackRatingEnum = pgEnum('feedback_rating', ['up', 'down'])
export const feedbackReasonEnum = pgEnum('feedback_reason', [
  'wrong_answer',
  'fabricated',
  'missing_knowledge',
  'wrong_tone_or_language',
  'should_have_handed_off',
])
export const feedbackTargetEnum = pgEnum('feedback_target', ['message', 'suggestion'])

/** Only identifiers that name a person or an account; see packages/shared/src/merge.ts. */
export const mergeMatchKeyEnum = pgEnum('merge_match_key', ['phone', 'email', 'account_id'])
export const mergeSuggestionStatusEnum = pgEnum('merge_suggestion_status', ['pending', 'rejected'])

// ---------------------------------------------------------------------------
// Workspace (1:1 extension of Better Auth's organization)
// ---------------------------------------------------------------------------

export type WorkspaceSettings = {
  defaultLanguage: Language
  defaultMode: ConversationMode
  /** System prompt / persona prepended to every agent turn. */
  persona: string
  businessHours: {
    timezone: string
    /** 0 = Sunday. Absent day means closed. */
    days: Record<string, { open: string; close: string } | undefined>
  }
  retentionDays: number
  redaction: { cardNumbers: boolean; thaiNationalId: boolean }
  /** Minutes a conversation may sit in `waiting_human` before the AI offers a fallback reply. */
  waitingHumanFallbackMinutes: number | null
  acknowledgementText: Record<Language, string>
  /** Per-model price table for cost estimates, keyed `provider:model`. */
  modelPrices: Record<string, { inputPerMillion: number; outputPerMillion: number }>
  /**
   * Point retrieval at an existing knowledge platform instead of ours. Null uses the
   * built-in Postgres hybrid search.
   */
  externalRetrieval: {
    kind: 'dify' | 'ragflow' | 'generic'
    baseUrl: string
    /**
     * AES-256-GCM, like every other credential here. The settings endpoint reports
     * `hasApiKey` and never returns this, because a viewer can read workspace settings.
     */
    apiKeyEncrypted: string | null
    datasetId: string | null
    topK?: number
    scoreThreshold?: number
  } | null
}

export const workspaces = pgTable('workspaces', {
  id: text('id')
    .primaryKey()
    .references(() => organization.id, { onDelete: 'cascade' }),
  settings: jsonb('settings').$type<WorkspaceSettings>().notNull(),
  createdAt: ts('created_at').defaultNow().notNull(),
  updatedAt: ts('updated_at').defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// Channels and identities
// ---------------------------------------------------------------------------

export const channels = pgTable(
  'channels',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: channelTypeEnum('type').notNull(),
    name: text('name').notNull(),
    /** AES-256-GCM blob holding platform credentials. Never leaves the server. */
    configEncrypted: text('config_encrypted'),
    /** Secret used to verify inbound webhooks for this channel. */
    webhookSecret: text('webhook_secret'),
    /** Overrides the workspace default for conversations on this channel. */
    defaultMode: conversationModeEnum('default_mode'),
    enabled: boolean('enabled').default(true).notNull(),
    createdAt: ts('created_at').defaultNow().notNull(),
    updatedAt: ts('updated_at').defaultNow().notNull(),
  },
  (t) => [index('channels_workspace_idx').on(t.workspaceId)],
)

export const customers = pgTable(
  'customers',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    displayName: text('display_name'),
    primaryLanguage: text('primary_language').$type<Language>(),
    /** Business identifiers extracted from conversation: phone, orderId, accountId, ... */
    fields: jsonb('fields').$type<Record<string, string>>().default({}).notNull(),
    /** Rolling summary maintained by the summarize job; injected into every prompt. */
    summary: text('summary'),
    summaryUpdatedAt: ts('summary_updated_at'),
    createdAt: ts('created_at').defaultNow().notNull(),
    updatedAt: ts('updated_at').defaultNow().notNull(),
  },
  (t) => [index('customers_workspace_idx').on(t.workspaceId)],
)

export const channelIdentities = pgTable(
  'channel_identities',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    /** Opaque platform id: LINE userId, Messenger PSID, widget visitor id. */
    externalId: text('external_id').notNull(),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    displayName: text('display_name'),
    avatarUrl: text('avatar_url'),
    profile: jsonb('profile').$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: ts('created_at').defaultNow().notNull(),
    updatedAt: ts('updated_at').defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('channel_identities_channel_external_uq').on(t.channelId, t.externalId),
    index('channel_identities_customer_idx').on(t.customerId),
    index('channel_identities_workspace_idx').on(t.workspaceId),
  ],
)

// ---------------------------------------------------------------------------
// Conversations and messages
// ---------------------------------------------------------------------------

export const conversations = pgTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    channelIdentityId: text('channel_identity_id')
      .notNull()
      .references(() => channelIdentities.id, { onDelete: 'cascade' }),
    mode: conversationModeEnum('mode').notNull().default('ai'),
    status: conversationStatusEnum('status').notNull().default('open'),
    assigneeUserId: text('assignee_user_id').references(() => user.id, { onDelete: 'set null' }),
    tags: text('tags').array().default([]).notNull(),
    handoffReason: handoffReasonEnum('handoff_reason'),
    handoffNote: text('handoff_note'),
    /**
     * Platforms that only allow free-form replies for a period after the customer's last
     * message (WhatsApp 24h, Messenger policy windows). Null means no window applies.
     */
    messagingWindowExpiresAt: ts('messaging_window_expires_at'),
    /**
     * LINE hands out a token with each webhook event that lets us answer for free. It is
     * single-use and expires about a minute later, and our pipeline is asynchronous, so the
     * token is carried here and used only while still fresh. Everything else is a push,
     * which counts against the account's monthly quota.
     */
    replyToken: text('reply_token'),
    replyTokenExpiresAt: ts('reply_token_expires_at'),
    lastMessageAt: ts('last_message_at'),
    lastCustomerMessageAt: ts('last_customer_message_at'),
    waitingHumanSince: ts('waiting_human_since'),
    /**
     * When a person last looked over what the AI said here, and who.
     *
     * Written with the database's `now()`, never a Date from the application: it is
     * compared against `messages.created_at`, which `defaultNow()` writes on the database
     * clock, and two clocks a few hundred milliseconds apart would let a conversation
     * re-enter the review queue or slip out of it.
     */
    reviewedAt: ts('reviewed_at'),
    reviewedByUserId: text('reviewed_by_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    unreadCount: integer('unread_count').default(0).notNull(),
    createdAt: ts('created_at').defaultNow().notNull(),
    updatedAt: ts('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('conversations_workspace_status_idx').on(t.workspaceId, t.status, t.lastMessageAt),
    index('conversations_workspace_mode_idx').on(t.workspaceId, t.mode),
    index('conversations_identity_idx').on(t.channelIdentityId),
    index('conversations_customer_idx').on(t.customerId),
    index('conversations_workspace_reviewed_idx').on(t.workspaceId, t.reviewedAt),
  ],
)

export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    direction: messageDirectionEnum('direction').notNull(),
    senderType: senderTypeEnum('sender_type').notNull(),
    senderUserId: text('sender_user_id').references(() => user.id, { onDelete: 'set null' }),
    /** The normalised message. Already redacted before it is written. */
    content: jsonb('content').$type<NormalizedMessage>().notNull(),
    /** Flat text for previews, search and prompts. Redacted. */
    text: text('text').notNull().default(''),
    /** What the redactor masked, for audit. Never contains the original values. */
    redactionFindings: jsonb('redaction_findings')
      .$type<{ type: string; count: number }[]>()
      .default([])
      .notNull(),
    platformMessageId: text('platform_message_id'),
    status: messageStatusEnum('status').notNull().default('sent'),
    error: text('error'),
    aiTraceId: text('ai_trace_id'),
    createdAt: ts('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('messages_conversation_idx').on(t.conversationId, t.createdAt),
    /** The review queue asks "is there an AI message here, and a human one?" per conversation. */
    index('messages_conversation_sender_idx').on(t.conversationId, t.senderType, t.createdAt),
    index('messages_workspace_idx').on(t.workspaceId),
    // Postgres treats NULLs as distinct in a unique index, which is exactly what we want:
    // outbound messages have no platform id until the adapter sends them, so many rows
    // may hold NULL while inbound platform ids stay unique per conversation.
    // Do not add NULLS NOT DISTINCT here; it would break outbound inserts.
    uniqueIndex('messages_platform_id_uq').on(t.conversationId, t.platformMessageId),
  ],
)

export const internalNotes = pgTable(
  'internal_notes',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    authorType: senderTypeEnum('author_type').notNull(),
    authorUserId: text('author_user_id').references(() => user.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    createdAt: ts('created_at').defaultNow().notNull(),
  },
  (t) => [index('internal_notes_conversation_idx').on(t.conversationId, t.createdAt)],
)

/**
 * Raw platform events, stored before processing.
 * The unique index is the idempotency guarantee: platforms retry webhooks, and a retry
 * must never produce a second customer message.
 */
export const inboundEvents = pgTable(
  'inbound_events',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    platformEventId: text('platform_event_id').notNull(),
    payload: jsonb('payload').$type<unknown>().notNull(),
    receivedAt: ts('received_at').defaultNow().notNull(),
    processedAt: ts('processed_at'),
    error: text('error'),
  },
  (t) => [
    uniqueIndex('inbound_events_channel_platform_uq').on(t.channelId, t.platformEventId),
    index('inbound_events_unprocessed_idx').on(t.processedAt),
  ],
)

// ---------------------------------------------------------------------------
// AI providers, slots and traces
// ---------------------------------------------------------------------------

export const providers = pgTable(
  'providers',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    baseUrl: text('base_url').notNull(),
    /** AES-256-GCM. Never returned to the browser; the API exposes `hasKey` only. */
    apiKeyEncrypted: text('api_key_encrypted'),
    headersEncrypted: text('headers_encrypted'),
    /** Models without function calling fall back to the answer-only path. */
    supportsTools: boolean('supports_tools').default(true).notNull(),
    supportsVision: boolean('supports_vision').default(false).notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    createdAt: ts('created_at').defaultNow().notNull(),
    updatedAt: ts('updated_at').defaultNow().notNull(),
  },
  (t) => [index('providers_workspace_idx').on(t.workspaceId)],
)

export const taskSlots = pgTable(
  'task_slots',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    task: aiTaskEnum('task').notNull(),
    primaryProviderId: text('primary_provider_id').references(() => providers.id, {
      onDelete: 'set null',
    }),
    primaryModel: text('primary_model'),
    fallbackProviderId: text('fallback_provider_id').references(() => providers.id, {
      onDelete: 'set null',
    }),
    fallbackModel: text('fallback_model'),
    /** temperature, maxTokens, topP, ... */
    params: jsonb('params').$type<Record<string, unknown>>().default({}).notNull(),
    updatedAt: ts('updated_at').defaultNow().notNull(),
  },
  (t) => [uniqueIndex('task_slots_workspace_task_uq').on(t.workspaceId, t.task)],
)

export const aiTraces = pgTable(
  'ai_traces',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id').references(() => conversations.id, {
      onDelete: 'cascade',
    }),
    task: aiTaskEnum('task').notNull(),
    providerId: text('provider_id').references(() => providers.id, { onDelete: 'set null' }),
    providerName: text('provider_name'),
    model: text('model'),
    /** True when the primary slot failed and the fallback answered. */
    usedFallback: boolean('used_fallback').default(false).notNull(),
    prompt: jsonb('prompt').$type<unknown>(),
    toolCalls: jsonb('tool_calls').$type<unknown>(),
    retrieved: jsonb('retrieved').$type<unknown>(),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    latencyMs: integer('latency_ms'),
    costEstimate: numeric('cost_estimate', { precision: 12, scale: 6 }),
    outcome: aiOutcomeEnum('outcome').notNull(),
    error: text('error'),
    createdAt: ts('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('ai_traces_conversation_idx').on(t.conversationId, t.createdAt),
    index('ai_traces_workspace_idx').on(t.workspaceId, t.createdAt),
  ],
)

export const suggestions = pgTable(
  'suggestions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    messageText: text('message_text').notNull(),
    /** Retrieved knowledge chunks with scores, so the agent can see the sources. */
    chunks: jsonb('chunks').$type<unknown>().default([]).notNull(),
    aiTraceId: text('ai_trace_id').references(() => aiTraces.id, { onDelete: 'set null' }),
    status: suggestionStatusEnum('status').notNull().default('pending'),
    /**
     * The message this draft became, once a human sent it.
     *
     * It is what makes the draft worth studying: comparing this message's text with
     * `messageText` says whether the agent trusted the draft or rewrote it, which is the
     * implicit correction signal. Set whether the agent used "insert and send" or inserted
     * the draft, edited it and sent it themselves.
     */
    sentMessageId: text('sent_message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    createdAt: ts('created_at').defaultNow().notNull(),
  },
  (t) => [index('suggestions_conversation_idx').on(t.conversationId, t.createdAt)],
)

/**
 * What a person thought of something the AI wrote.
 *
 * `targetId` points at either a message or a suggestion and carries no foreign key, the
 * same compromise `messages.ai_trace_id` makes: one column cannot reference two tables.
 * Nothing is orphaned by it, because feedback hangs off the conversation and dies with it,
 * and deleting a conversation is how both retention and erasure work.
 *
 * One row per person per target. An agent who changes their mind updates their own row,
 * and the unique index is what makes that an upsert rather than a second opinion.
 */
export const feedback = pgTable(
  'feedback',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    targetType: feedbackTargetEnum('target_type').notNull(),
    targetId: text('target_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    rating: feedbackRatingEnum('rating').notNull(),
    /** Only ever set on a thumbs-down; forced to null on a thumbs-up. */
    reason: feedbackReasonEnum('reason'),
    note: text('note'),
    createdAt: ts('created_at').defaultNow().notNull(),
    updatedAt: ts('updated_at').defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('feedback_target_user_uq').on(t.targetType, t.targetId, t.userId),
    index('feedback_workspace_idx').on(t.workspaceId, t.createdAt),
    index('feedback_conversation_idx').on(t.conversationId),
  ],
)

/**
 * A proposal that two customer records are the same person.
 *
 * There is no `accepted` status. Accepting performs the merge, which deletes the absorbed
 * customer, and this row cascades away with it; what survives is the audit entry. A
 * rejected row, by contrast, must outlive the decision: it is the only thing stopping the
 * same pair being proposed again on the customer's next message, forever.
 *
 * The pair is stored in a fixed order — `customerId` is always the older of the two, which
 * is also the one that survives a merge — so the unique index cannot be defeated by
 * proposing the same two people the other way round.
 */
export const mergeSuggestions = pgTable(
  'merge_suggestions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** The older record: the one that keeps its id if a person accepts. */
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    /** The newer record, absorbed into the other one on accept. */
    otherCustomerId: text('other_customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    matchKey: mergeMatchKeyEnum('match_key').notNull(),
    /** The normalised value both records carried, shown so a person can judge the match. */
    matchValue: text('match_value').notNull(),
    status: mergeSuggestionStatusEnum('status').notNull().default('pending'),
    decidedByUserId: text('decided_by_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    decidedAt: ts('decided_at'),
    createdAt: ts('created_at').defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('merge_suggestions_pair_uq').on(t.customerId, t.otherCustomerId),
    index('merge_suggestions_workspace_idx').on(t.workspaceId, t.status),
    index('merge_suggestions_other_idx').on(t.otherCustomerId),
  ],
)

/**
 * Every time the AI stopped answering, and why.
 *
 * `conversations.handoff_reason` answers a different question: why is this one waiting
 * right now. It is cleared the moment a person hands the conversation back, which is
 * correct for a badge in the inbox and useless for a month's worth of reporting — the list
 * of what the AI could not handle would empty itself as agents worked through their queue.
 * This table is the history, and the dashboard's "what to write into the knowledge base
 * next" reads from here.
 *
 * `occurred_at` is the instant the state machine recorded, not the insert time, which is
 * what makes the row idempotent: a retried job replays an effect list that was already
 * computed, so the same handoff carries the same instant and conflicts with itself.
 */
export const handoffEvents = pgTable(
  'handoff_events',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    reason: handoffReasonEnum('reason').notNull(),
    occurredAt: ts('occurred_at').notNull(),
    createdAt: ts('created_at').defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('handoff_events_conversation_at_uq').on(t.conversationId, t.occurredAt),
    index('handoff_events_workspace_idx').on(t.workspaceId, t.occurredAt),
  ],
)

export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    actorUserId: text('actor_user_id').references(() => user.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    meta: jsonb('meta').$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: ts('created_at').defaultNow().notNull(),
  },
  (t) => [index('audit_log_workspace_idx').on(t.workspaceId, t.createdAt)],
)

// Re-export enum value types so callers can use the shared union types directly.
export type {
  AiTask,
  ChannelEventKind,
  ConversationMode,
  ConversationStatus,
  FeedbackRating,
  FeedbackReason,
  FeedbackTargetType,
  HandoffReason,
  Language,
  MergeMatchKey,
  MergeSuggestionStatus,
  MessageDirection,
  MessageStatus,
  SenderType,
}
