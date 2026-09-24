import { z } from 'zod'
import { conversationModeSchema, conversationStatusSchema } from './conversation'
import { workspaceStatusSchema } from './workspace'

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
  /**
   * The workspace was suspended, restored or scheduled for deletion.
   *
   * Sent so an open console reacts at once rather than on the next reload. Somebody typing
   * a reply into a workspace that has just been suspended should be told, not left to
   * discover it when the send fails.
   */
  z.object({
    type: z.literal('workspace.status'),
    status: workspaceStatusSchema,
  }),
  /**
   * Somebody's access to this workspace may have changed: a role, a removal, a password
   * reset that ended their sessions. Never reaches a browser; the socket server re-checks
   * the named person's sockets (everyone's when `userId` is null) and closes the ones that
   * no longer qualify.
   */
  z.object({
    type: z.literal('auth.changed'),
    userId: z.string().nullable(),
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
