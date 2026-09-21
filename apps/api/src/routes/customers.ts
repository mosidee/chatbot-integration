import { schema } from '@ci/db'
import { acceptMergeSuggestion, listMergeSuggestions, rejectMergeSuggestion } from '@ci/infra'
import { and, desc, eq, inArray } from 'drizzle-orm'
import Elysia from 'elysia'
import { z } from 'zod'
import { authPlugin } from '../auth-plugin'
import type { ApiContext } from '../context'

/**
 * Customer-level actions: today, deciding whether two records are one person.
 *
 * Keyed by customer rather than by conversation, because a merge is about the person and
 * not about wherever the agent happened to notice. Accepting is destructive and cannot be
 * undone, so it needs the agent role; looking is open to anyone who can read the inbox.
 */
export function customerRoutes(ctx: ApiContext) {
  const { db, runtime } = ctx

  /** Enough about the other record for a person to judge the match without leaving the page. */
  const describe = async (workspaceId: string, customerIds: string[]) => {
    if (customerIds.length === 0) return new Map<string, unknown>()

    const [customers, identities, conversations] = await Promise.all([
      db
        .select()
        .from(schema.customers)
        .where(
          and(
            eq(schema.customers.workspaceId, workspaceId),
            inArray(schema.customers.id, customerIds),
          ),
        ),
      db
        .select({
          customerId: schema.channelIdentities.customerId,
          externalId: schema.channelIdentities.externalId,
          displayName: schema.channelIdentities.displayName,
        })
        .from(schema.channelIdentities)
        .where(
          and(
            eq(schema.channelIdentities.workspaceId, workspaceId),
            inArray(schema.channelIdentities.customerId, customerIds),
          ),
        ),
      db
        .select({
          customerId: schema.conversations.customerId,
          id: schema.conversations.id,
          lastMessageAt: schema.conversations.lastMessageAt,
        })
        .from(schema.conversations)
        .where(
          and(
            eq(schema.conversations.workspaceId, workspaceId),
            inArray(schema.conversations.customerId, customerIds),
          ),
        )
        .orderBy(desc(schema.conversations.lastMessageAt)),
    ])

    return new Map(
      customers.map((customer) => [
        customer.id,
        {
          id: customer.id,
          displayName: customer.displayName,
          fields: customer.fields,
          summary: customer.summary,
          identities: identities
            .filter((row) => row.customerId === customer.id)
            .map((row) => ({ externalId: row.externalId, displayName: row.displayName })),
          conversations: conversations.filter((row) => row.customerId === customer.id).length,
          lastMessageAt:
            conversations.find((row) => row.customerId === customer.id)?.lastMessageAt ?? null,
        },
      ]),
    )
  }

  return (
    new Elysia({ prefix: '/customers' })
      .use(authPlugin(ctx))

      /** Everything still awaiting a decision about this customer, with both sides described. */
      .get(
        '/:id/merge-suggestions',
        async ({ workspaceId, params }) => {
          const suggestions = await listMergeSuggestions(db, workspaceId, params.id)
          const described = await describe(workspaceId, [
            ...new Set(suggestions.flatMap((s) => [s.customerId, s.otherCustomerId])),
          ])

          return {
            suggestions: suggestions.map((suggestion) => ({
              id: suggestion.id,
              matchKey: suggestion.matchKey,
              matchValue: suggestion.matchValue,
              createdAt: suggestion.createdAt,
              /** The record that would keep its id. */
              survivor: described.get(suggestion.customerId) ?? null,
              /** The record that would be absorbed into it. */
              absorbed: described.get(suggestion.otherCustomerId) ?? null,
            })),
          }
        },
        { auth: 'viewer', params: z.object({ id: z.string() }) },
      )

      /**
       * Yes, these are one person. Irreversible: the absorbed record's history moves and
       * the record itself is gone.
       */
      .post(
        '/:id/merge-suggestions/:suggestionId/accept',
        async ({ workspaceId, params, user, status }) => {
          const merged = await acceptMergeSuggestion(db, workspaceId, params.suggestionId, user.id)
          if (!merged) return status(404, { error: 'Merge suggestion not found' })

          // Conversations changed hands, so every open inbox needs to hear about it.
          await runtime.publisher.publish(workspaceId, {
            type: 'conversation.updated',
            conversationId: params.id,
          })
          return { merged }
        },
        {
          auth: 'agent',
          params: z.object({ id: z.string(), suggestionId: z.string() }),
        },
      )

      /** No, and never ask again about these two. */
      .post(
        '/:id/merge-suggestions/:suggestionId/reject',
        async ({ workspaceId, params, user, status }) => {
          const rejected = await rejectMergeSuggestion(
            db,
            workspaceId,
            params.suggestionId,
            user.id,
          )
          if (!rejected) return status(404, { error: 'Merge suggestion not found' })
          return { ok: true }
        },
        {
          auth: 'agent',
          params: z.object({ id: z.string(), suggestionId: z.string() }),
        },
      )
  )
}
