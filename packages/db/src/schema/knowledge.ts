import type { Language } from '@ci/shared'
import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from 'drizzle-orm/pg-core'
import { conversations, customers, messages, workspaces } from './app'
import { user } from './auth'

/**
 * Knowledge and memory.
 *
 * ## Why 1024 dimensions
 *
 * The embedding column has to be a fixed size, and that size constrains which models an
 * operator may choose. 1024 is native for bge-m3, the strongest open multilingual model for
 * Thai, and OpenAI's text-embedding-3 models can be asked for 1024 through the `dimensions`
 * parameter. One number therefore covers both the self-hosted and the hosted path.
 *
 * Changing it means a migration and re-embedding everything, which the knowledge screen can
 * already trigger because re-ingestion is a normal operation.
 */
export const EMBEDDING_DIMENSIONS = 1024

const ts = (name: string) => timestamp(name, { withTimezone: true })

export const knowledgeKindEnum = pgEnum('knowledge_kind', ['qa', 'article', 'file', 'url'])
export const ingestionStatusEnum = pgEnum('ingestion_status', [
  'pending',
  'processing',
  'ready',
  'failed',
])

/**
 * One thing an operator added: a typed Q&A pair, a written article, an uploaded file or a
 * crawled URL. Parsing and embedding progress is tracked here so a Thai PDF that extracts
 * as nonsense shows as `failed` with its reason in the knowledge screen, rather than
 * looking like the AI is broken.
 */
export const knowledgeSources = pgTable(
  'knowledge_sources',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: knowledgeKindEnum('kind').notNull(),
    title: text('title').notNull(),
    status: ingestionStatusEnum('status').notNull().default('pending'),
    error: text('error'),
    /** Set for uploaded files. */
    storageKey: text('storage_key'),
    mime: text('mime'),
    byteSize: integer('byte_size'),
    /** Where a promoted reply came from, crawl settings, parser notes. */
    meta: jsonb('meta').$type<Record<string, unknown>>().default({}).notNull(),
    createdByUserId: text('created_by_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    createdAt: ts('created_at').defaultNow().notNull(),
    updatedAt: ts('updated_at').defaultNow().notNull(),
  },
  (t) => [index('knowledge_sources_workspace_idx').on(t.workspaceId, t.status)],
)

/**
 * The readable unit an agent edits.
 *
 * A source may hold many entries: a Q&A source has one, an uploaded manual has one per
 * section. Per-language variants are separate rows sharing a `variantGroup`, so a Thai and
 * an English version of the same answer can be authored and retrieved independently.
 */
export const knowledgeEntries = pgTable(
  'knowledge_entries',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceId: text('source_id')
      .notNull()
      .references(() => knowledgeSources.id, { onDelete: 'cascade' }),
    /** Ties per-language variants of the same answer together. */
    variantGroup: text('variant_group').notNull(),
    language: text('language').$type<Language>().notNull(),
    /** Null for articles; set for Q&A entries. */
    question: text('question'),
    body: text('body').notNull(),
    tags: text('tags').array().default([]).notNull(),
    /** Empty means every channel. Otherwise restricts retrieval to these channel types. */
    channelTypes: text('channel_types').array().default([]).notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    createdAt: ts('created_at').defaultNow().notNull(),
    updatedAt: ts('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('knowledge_entries_workspace_idx').on(t.workspaceId, t.enabled),
    index('knowledge_entries_source_idx').on(t.sourceId),
    index('knowledge_entries_variant_idx').on(t.variantGroup),
  ],
)

/**
 * What retrieval actually searches.
 *
 * Both halves of the hybrid live on this table: a dense vector for meaning, and a trigram
 * index over the text for literal matches. The trigram half is what finds a product code
 * or a Thai term the embedding glosses over; see ADR 0003 for the measurements behind it.
 */
export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceId: text('source_id')
      .notNull()
      .references(() => knowledgeSources.id, { onDelete: 'cascade' }),
    entryId: text('entry_id').references(() => knowledgeEntries.id, { onDelete: 'cascade' }),
    language: text('language').$type<Language>(),
    /** Position within the entry, so neighbouring context can be shown to an agent. */
    ord: integer('ord').default(0).notNull(),
    text: text('text').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }),
    /** Which model produced the embedding, so a model change can be detected and re-run. */
    embeddingModel: text('embedding_model'),
    /**
     * The vector space it lives in: the model and whether a size was requested. Two models
     * can both answer with 1024 numbers that mean nothing to each other, so a query is only
     * ever compared with vectors from its own space.
     */
    embeddingSpace: text('embedding_space'),
    createdAt: ts('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('knowledge_chunks_workspace_idx').on(t.workspaceId),
    index('knowledge_chunks_source_idx').on(t.sourceId),
    index('knowledge_chunks_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('knowledge_chunks_text_trgm_idx').using('gin', sql`${t.text} gin_trgm_ops`),
  ],
)

/**
 * Semantic recall over a customer's own past conversations.
 *
 * `customerId` is denormalised onto the row on purpose. The tool that searches this table
 * runs inside an agent turn, and scoping only by workspace would let one customer's history
 * surface in another customer's conversation. The customer id is part of every query, and a
 * test asserts it.
 */
export const conversationEmbeddings = pgTable(
  'conversation_embeddings',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    messageId: text('message_id').references(() => messages.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }),
    embeddingModel: text('embedding_model'),
    /** See `knowledgeChunks.embeddingSpace`. */
    embeddingSpace: text('embedding_space'),
    createdAt: ts('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('conversation_embeddings_customer_idx').on(t.workspaceId, t.customerId),
    index('conversation_embeddings_conversation_idx').on(t.conversationId),
    index('conversation_embeddings_embedding_idx').using(
      'hnsw',
      t.embedding.op('vector_cosine_ops'),
    ),
  ],
)

/**
 * History of the rolling customer summary.
 *
 * The current summary lives on `customers`; this keeps what it said before, so a wrong
 * summary can be traced to the conversation and model that produced it.
 */
export const customerSummaries = pgTable(
  'customer_summaries',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    summary: text('summary').notNull(),
    facts: jsonb('facts').$type<Record<string, string>>().default({}).notNull(),
    model: text('model'),
    aiTraceId: text('ai_trace_id'),
    createdAt: ts('created_at').defaultNow().notNull(),
  },
  (t) => [index('customer_summaries_customer_idx').on(t.customerId, t.createdAt)],
)

/** Reusable replies an agent can insert with a shortcut. */
export const cannedResponses = pgTable(
  'canned_responses',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    shortcut: text('shortcut').notNull(),
    language: text('language').$type<Language>(),
    body: text('body').notNull(),
    createdAt: ts('created_at').defaultNow().notNull(),
    updatedAt: ts('updated_at').defaultNow().notNull(),
  },
  (t) => [uniqueIndex('canned_responses_shortcut_uq').on(t.workspaceId, t.shortcut)],
)
