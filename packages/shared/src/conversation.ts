import { z } from 'zod'

/** Who is currently answering this customer. The central concept of the product. */
export const conversationModeSchema = z.enum([
  /** AI answers automatically and may hand off. */
  'ai',
  /** AI drafts; a human approves, edits or discards before anything is sent. */
  'ai_supervised',
  /** A human owns the conversation. The AI only suggests; it never sends. */
  'human',
  /** AI has handed off and nobody has picked it up yet. */
  'waiting_human',
])
export type ConversationMode = z.infer<typeof conversationModeSchema>

export const conversationStatusSchema = z.enum(['open', 'snoozed', 'resolved'])
export type ConversationStatus = z.infer<typeof conversationStatusSchema>

export const channelTypeSchema = z.enum(['test', 'web', 'line', 'messenger'])
export type ChannelType = z.infer<typeof channelTypeSchema>

export const messageDirectionSchema = z.enum(['inbound', 'outbound'])
export type MessageDirection = z.infer<typeof messageDirectionSchema>

export const senderTypeSchema = z.enum(['customer', 'ai', 'human', 'system'])
export type SenderType = z.infer<typeof senderTypeSchema>

export const messageStatusSchema = z.enum([
  'queued',
  'sent',
  'delivered',
  'read',
  'failed',
  'canceled',
  'uncertain',
])
export type MessageStatus = z.infer<typeof messageStatusSchema>

/** Why the AI stopped answering. Shown to agents as an internal note and in the queue. */
export const handoffReasonSchema = z.enum([
  'ai_requested',
  'customer_requested',
  'low_confidence',
  'negative_sentiment',
  'keyword_rule',
  'unsupported_media',
  'tool_error',
  'model_error',
])
export type HandoffReason = z.infer<typeof handoffReasonSchema>

/** The AI task slots an operator can point at different providers and models. */
export const aiTaskSchema = z.enum([
  'agent_chat',
  'vision',
  'suggestion_for_human',
  'summarize',
  'classify_intent_and_handoff',
  'embed',
  'rerank',
])
export type AiTask = z.infer<typeof aiTaskSchema>

// The console role lives in ./workspace with the rest of tenancy, and is re-exported from
// the package index. It sat here unused, which is how a second spelling of the same enum
// survives long enough to disagree with the first.

export const languageSchema = z.enum(['th', 'en'])
export type Language = z.infer<typeof languageSchema>
