import { applyEffects, type ConversationState, transition } from '@ci/core'
import { newId, schema } from '@ci/db'
import {
  createEffectPorts,
  loadWorkspaceSettings,
  storeMessage,
  updateConversation,
} from '@ci/infra'
import {
  conversationModeSchema,
  conversationStatusSchema,
  normalizedMessageSchema,
} from '@ci/shared'
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm'
import Elysia from 'elysia'
import { z } from 'zod'
import { authPlugin } from '../auth-plugin'
import type { ApiContext } from '../context'

/**
 * Conversation routes: the inbox, the thread, and every human control over who answers.
 *
 * Human actions go through the same state machine the worker uses, so "take over" behaves
 * identically whether it was triggered by an agent's click or by the AI handing off.
 */
export function conversationRoutes(ctx: ApiContext) {
  const { db, runtime } = ctx
  const ports = createEffectPorts(runtime, runtime.logger)

  const loadState = async (
    workspaceId: string,
    conversationId: string,
  ): Promise<{
    row: typeof schema.conversations.$inferSelect
    state: ConversationState
  } | null> => {
    const rows = await db
      .select()
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.id, conversationId),
          eq(schema.conversations.workspaceId, workspaceId),
        ),
      )
      .limit(1)
    const row = rows[0]
    if (!row) return null
    return {
      row,
      state: {
        mode: row.mode,
        status: row.status,
        assigneeUserId: row.assigneeUserId,
        waitingHumanSince: row.waitingHumanSince,
        handoffReason: row.handoffReason,
      },
    }
  }

  const applyTransition = async (
    workspaceId: string,
    conversationId: string,
    event: Parameters<typeof transition>[1],
  ) => {
    const loaded = await loadState(workspaceId, conversationId)
    if (!loaded) return null
    const settings = await loadWorkspaceSettings(db, workspaceId)
    const { patch, effects } = transition(loaded.state, event, {
      waitingHumanFallbackMinutes: settings.waitingHumanFallbackMinutes,
    })
    if (Object.keys(patch).length > 0) {
      await updateConversation(db, workspaceId, conversationId, patch)
    }
    await applyEffects(effects, { workspaceId, conversationId }, ports, runtime.logger)
    await runtime.publisher.publish(workspaceId, { type: 'conversation.updated', conversationId })
    return { ...loaded.state, ...patch }
  }

  return (
    new Elysia({ prefix: '/conversations' })
      .use(authPlugin(ctx))

      .get(
        '/',
        async ({ workspaceId, query }) => {
          const filters = [eq(schema.conversations.workspaceId, workspaceId)]
          if (query.status) filters.push(eq(schema.conversations.status, query.status))
          if (query.mode) filters.push(eq(schema.conversations.mode, query.mode))
          if (query.channelId) filters.push(eq(schema.conversations.channelId, query.channelId))
          if (query.assigneeUserId) {
            filters.push(eq(schema.conversations.assigneeUserId, query.assigneeUserId))
          }
          if (query.tag) filters.push(sql`${query.tag} = ANY(${schema.conversations.tags})`)
          if (query.before)
            filters.push(lt(schema.conversations.lastMessageAt, new Date(query.before)))

          const rows = await db
            .select()
            .from(schema.conversations)
            .where(and(...filters))
            .orderBy(desc(schema.conversations.lastMessageAt))
            .limit(query.limit ?? 50)

          if (rows.length === 0) return { conversations: [] }

          const customerIds = [...new Set(rows.map((r) => r.customerId))]
          const customers = await db
            .select()
            .from(schema.customers)
            .where(inArray(schema.customers.id, customerIds))
          const byCustomer = new Map(customers.map((c) => [c.id, c]))

          // One extra query for previews rather than one per row.
          const conversationIds = rows.map((r) => r.id)
          const lastMessages = await db
            .select({
              conversationId: schema.messages.conversationId,
              text: schema.messages.text,
              createdAt: schema.messages.createdAt,
              senderType: schema.messages.senderType,
            })
            .from(schema.messages)
            .where(inArray(schema.messages.conversationId, conversationIds))
            .orderBy(desc(schema.messages.createdAt))
          const preview = new Map<string, (typeof lastMessages)[number]>()
          for (const m of lastMessages)
            if (!preview.has(m.conversationId)) preview.set(m.conversationId, m)

          return {
            conversations: rows.map((row) => ({
              id: row.id,
              mode: row.mode,
              status: row.status,
              channelId: row.channelId,
              assigneeUserId: row.assigneeUserId,
              tags: row.tags,
              handoffReason: row.handoffReason,
              unreadCount: row.unreadCount,
              lastMessageAt: row.lastMessageAt,
              waitingHumanSince: row.waitingHumanSince,
              customer: {
                id: row.customerId,
                displayName: byCustomer.get(row.customerId)?.displayName ?? null,
              },
              lastMessage: preview.get(row.id)
                ? {
                    text: preview.get(row.id)?.text ?? '',
                    senderType: preview.get(row.id)?.senderType,
                    createdAt: preview.get(row.id)?.createdAt,
                  }
                : null,
            })),
          }
        },
        {
          auth: 'viewer',
          query: z.object({
            status: conversationStatusSchema.optional(),
            mode: conversationModeSchema.optional(),
            channelId: z.string().optional(),
            assigneeUserId: z.string().optional(),
            tag: z.string().optional(),
            before: z.string().optional(),
            limit: z.coerce.number().int().min(1).max(100).optional(),
          }),
        },
      )

      .get(
        '/:id',
        async ({ workspaceId, params, status }) => {
          const loaded = await loadState(workspaceId, params.id)
          if (!loaded) return status(404, { error: 'Conversation not found' })

          const [messages, notes, suggestions, customerRows, identityRows] = await Promise.all([
            db
              .select()
              .from(schema.messages)
              .where(eq(schema.messages.conversationId, params.id))
              .orderBy(schema.messages.createdAt)
              .limit(200),
            db
              .select()
              .from(schema.internalNotes)
              .where(eq(schema.internalNotes.conversationId, params.id))
              .orderBy(schema.internalNotes.createdAt),
            db
              .select()
              .from(schema.suggestions)
              .where(
                and(
                  eq(schema.suggestions.conversationId, params.id),
                  eq(schema.suggestions.status, 'pending'),
                ),
              )
              .orderBy(desc(schema.suggestions.createdAt))
              .limit(5),
            db
              .select()
              .from(schema.customers)
              .where(eq(schema.customers.id, loaded.row.customerId))
              .limit(1),
            db
              .select()
              .from(schema.channelIdentities)
              .where(eq(schema.channelIdentities.id, loaded.row.channelIdentityId))
              .limit(1),
          ])

          await db
            .update(schema.conversations)
            .set({ unreadCount: 0 })
            .where(eq(schema.conversations.id, params.id))

          return {
            conversation: loaded.row,
            customer: customerRows[0] ?? null,
            identity: identityRows[0] ?? null,
            messages,
            notes,
            suggestions,
          }
        },
        { auth: 'viewer', params: z.object({ id: z.string() }) },
      )

      /** An agent replies. This implicitly takes ownership so the AI does not answer next. */
      .post(
        '/:id/messages',
        async ({ workspaceId, params, body, user, status }) => {
          const loaded = await loadState(workspaceId, params.id)
          if (!loaded) return status(404, { error: 'Conversation not found' })

          const settings = await loadWorkspaceSettings(db, workspaceId)
          const stored = await storeMessage(db, {
            workspaceId,
            conversationId: params.id,
            direction: 'outbound',
            senderType: 'human',
            senderUserId: user.id,
            message: body.message,
            status: 'queued',
            redaction: settings.redaction,
          })

          await applyTransition(workspaceId, params.id, {
            type: 'human_message',
            at: new Date(),
            userId: user.id,
          })

          await runtime.queues.outbound.add('send', {
            workspaceId,
            conversationId: params.id,
            messageId: stored.id,
          })

          await runtime.publisher.publish(workspaceId, {
            type: 'message.created',
            conversationId: params.id,
            messageId: stored.id,
          })

          if (body.suggestionId) {
            await db
              .update(schema.suggestions)
              .set({ status: 'sent' })
              .where(eq(schema.suggestions.id, body.suggestionId))
          }

          return { messageId: stored.id }
        },
        {
          auth: 'agent',
          params: z.object({ id: z.string() }),
          body: z.object({
            message: normalizedMessageSchema,
            /** Set when the agent sent an AI draft, so the pair can be studied later. */
            suggestionId: z.string().optional(),
          }),
        },
      )

      .post(
        '/:id/take-over',
        async ({ workspaceId, params, user, status }) => {
          const result = await applyTransition(workspaceId, params.id, {
            type: 'human_take_over',
            at: new Date(),
            userId: user.id,
          })
          if (!result) return status(404, { error: 'Conversation not found' })
          return { mode: result.mode, assigneeUserId: result.assigneeUserId }
        },
        { auth: 'agent', params: z.object({ id: z.string() }) },
      )

      .post(
        '/:id/return-to-ai',
        async ({ workspaceId, params, body, status }) => {
          const result = await applyTransition(workspaceId, params.id, {
            type: 'human_return_to_ai',
            at: new Date(),
            note: body.note ?? null,
          })
          if (!result) return status(404, { error: 'Conversation not found' })
          return { mode: result.mode }
        },
        {
          auth: 'agent',
          params: z.object({ id: z.string() }),
          body: z.object({ note: z.string().max(1000).optional() }),
        },
      )

      .post(
        '/:id/mode',
        async ({ workspaceId, params, body, status }) => {
          const result = await applyTransition(workspaceId, params.id, {
            type: 'set_mode',
            at: new Date(),
            mode: body.mode,
          })
          if (!result) return status(404, { error: 'Conversation not found' })
          return { mode: result.mode }
        },
        {
          auth: 'agent',
          params: z.object({ id: z.string() }),
          body: z.object({ mode: conversationModeSchema }),
        },
      )

      .post(
        '/:id/status',
        async ({ workspaceId, params, body, status }) => {
          const result = await applyTransition(workspaceId, params.id, {
            type: 'set_status',
            at: new Date(),
            status: body.status,
          })
          if (!result) return status(404, { error: 'Conversation not found' })
          return { status: result.status }
        },
        {
          auth: 'agent',
          params: z.object({ id: z.string() }),
          body: z.object({ status: conversationStatusSchema }),
        },
      )

      .post(
        '/:id/assign',
        async ({ workspaceId, params, body, status }) => {
          const result = await applyTransition(workspaceId, params.id, {
            type: 'assign',
            at: new Date(),
            userId: body.userId,
          })
          if (!result) return status(404, { error: 'Conversation not found' })
          return { assigneeUserId: result.assigneeUserId }
        },
        {
          auth: 'agent',
          params: z.object({ id: z.string() }),
          body: z.object({ userId: z.string().nullable() }),
        },
      )

      .post(
        '/:id/notes',
        async ({ workspaceId, params, body, user }) => {
          const id = newId()
          await db.insert(schema.internalNotes).values({
            id,
            workspaceId,
            conversationId: params.id,
            authorType: 'human',
            authorUserId: user.id,
            body: body.body,
          })
          await runtime.publisher.publish(workspaceId, {
            type: 'conversation.updated',
            conversationId: params.id,
          })
          return { noteId: id }
        },
        {
          auth: 'agent',
          params: z.object({ id: z.string() }),
          body: z.object({ body: z.string().min(1).max(4000) }),
        },
      )

      .post(
        '/:id/suggestions/:suggestionId/discard',
        async ({ workspaceId, params }) => {
          await db
            .update(schema.suggestions)
            .set({ status: 'discarded' })
            .where(
              and(
                eq(schema.suggestions.id, params.suggestionId),
                eq(schema.suggestions.workspaceId, workspaceId),
              ),
            )
          return { ok: true }
        },
        { auth: 'agent', params: z.object({ id: z.string(), suggestionId: z.string() }) },
      )
  )
}
