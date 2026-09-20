import { z } from 'zod'
import { conversationModeSchema, conversationStatusSchema } from './conversation'

/**
 * Events pushed to the agent GUI over WebSocket.
 * The API publishes these onto Redis channel `ws:{workspaceId}`; every API replica
 * forwards them to its own connected sockets, so any replica count works.
 */

export const wsEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message.created'),
    conversationId: z.string(),
    messageId: z.string(),
  }),
  z.object({
    type: z.literal('message.updated'),
    conversationId: z.string(),
    messageId: z.string(),
  }),
  z.object({
    type: z.literal('conversation.updated'),
    conversationId: z.string(),
    mode: conversationModeSchema.optional(),
    status: conversationStatusSchema.optional(),
    assigneeUserId: z.string().nullable().optional(),
  }),
  z.object({
    type: z.literal('suggestion.created'),
    conversationId: z.string(),
    suggestionId: z.string(),
  }),
  z.object({
    type: z.literal('typing'),
    conversationId: z.string(),
    actor: z.enum(['ai', 'human']),
    userId: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal('presence'),
    userId: z.string(),
    online: z.boolean(),
  }),
])
export type WsEvent = z.infer<typeof wsEventSchema>

/** Messages the browser may send up the socket. */
export const wsClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), conversationId: z.string().nullable() }),
  z.object({ type: z.literal('typing'), conversationId: z.string() }),
  z.object({ type: z.literal('ping') }),
])
export type WsClientMessage = z.infer<typeof wsClientMessageSchema>

export const redisWsChannel = (workspaceId: string): string => `ws:${workspaceId}`
