import type {
  AiTask,
  ChannelEventKind,
  ConversationMode,
  ConversationStatus,
  HandoffReason,
  Language,
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
 * scoped by it. See `scoped()` in ../tenancy.ts — do not hand-write unscoped queries.
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
  'inserted',
  'sent',
  'discarded',
])
export const aiOutcomeEnum = pgEnum('ai_outcome', ['sent', 'draft', 'handoff', 'error'])

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
    apiKey: string | null
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
    lastMessageAt: ts('last_message_at'),
    lastCustomerMessageAt: ts('last_customer_message_at'),
    waitingHumanSince: ts('waiting_human_since'),
    unreadCount: integer('unread_count').default(0).notNull(),
    createdAt: ts('created_at').defaultNow().notNull(),
    updatedAt: ts('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('conversations_workspace_status_idx').on(t.workspaceId, t.status, t.lastMessageAt),
    index('conversations_workspace_mode_idx').on(t.workspaceId, t.mode),
    index('conversations_identity_idx').on(t.channelIdentityId),
    index('conversations_customer_idx').on(t.customerId),
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
    createdAt: ts('created_at').defaultNow().notNull(),
  },
  (t) => [index('suggestions_conversation_idx').on(t.conversationId, t.createdAt)],
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
  HandoffReason,
  Language,
  MessageDirection,
  MessageStatus,
  SenderType,
}
