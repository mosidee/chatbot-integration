import {
  resolveWebVisitor,
  signPayload,
  verifySignedPayload,
  webChannelAdapter,
} from '@ci/channels'
import { schema } from '@ci/db'
import { ingestWebhook, toWebhookRequest } from '@ci/infra'
import { identityAttributesSchema } from '@ci/shared'
import { and, asc, eq, gt } from 'drizzle-orm'
import Elysia from 'elysia'
import { z } from 'zod'
import type { ApiContext } from '../context'

/**
 * The embeddable widget's own API.
 *
 * Public by necessity: the caller is a customer's browser on somebody else's website, with
 * no console account and no session cookie. What stands in for authentication is a session
 * token we mint after deciding who the visitor is, signed with the channel's own secret and
 * carrying the one conversation that visitor may read. Nothing here takes a conversation id
 * from the request, because a widget that accepted one would hand every conversation in the
 * workspace to anyone who could guess an id.
 *
 * Identification comes from the host application: salon-saas signs a short-lived token for
 * its logged-in user and the widget presents it. A bad or expired token degrades to
 * anonymous rather than refusing, because somebody with a stale session still deserves
 * support.
 */

const SESSION_TTL_SECONDS = 12 * 60 * 60

const sessionClaimsSchema = z.object({
  channelId: z.string().min(1),
  externalId: z.string().min(1),
  identified: z.boolean(),
  /**
   * The proof the host token carried, kept in the session so later messages need not
   * present the token again.
   *
   * Optional, and it must stay optional: a session lasts twelve hours, so at any deploy
   * there are signed sessions in flight that predate this claim. Requiring it would fail
   * their verification and drop those visitors to a fresh anonymous identity mid-chat.
   */
  verified: z
    .object({
      subject: z.string().min(1),
      attributes: identityAttributesSchema,
      via: z.literal('widget_token'),
    })
    .optional(),
  exp: z.number().int(),
})

type SessionClaims = z.infer<typeof sessionClaimsSchema>

export function widgetRoutes(ctx: ApiContext) {
  const { db, runtime } = ctx

  /** The widget channel, its config, and the secret its session tokens are signed with. */
  async function loadChannel(channelId: string) {
    const rows = await db
      .select({ channel: schema.channels, status: schema.workspaces.status })
      .from(schema.channels)
      .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.channels.workspaceId))
      .where(and(eq(schema.channels.id, channelId), eq(schema.channels.type, 'web')))
      .limit(1)
    const channel = rows[0]?.channel
    if (!channel?.enabled) return null

    /**
     * A widget on a suspended tenant's site stops working, and says so plainly.
     *
     * Unlike a webhook there is a person on the other end of this, reading the page, so
     * pretending everything is fine and silently dropping their message would be worse than
     * telling them the chat is unavailable. A tenant being deleted reads as no channel at
     * all, because in a moment it will not exist.
     */
    const status = rows[0]?.status
    if (status !== 'active') {
      return { channel, config: null, suspended: status === 'suspended' } as const
    }

    // The web adapter directly rather than through the registry: the registry erases its
    // config type, and this route needs the origin list from it.
    const { decryptJson } = await import('@ci/db')
    const raw = channel.configEncrypted
      ? await decryptJson<Record<string, unknown>>(
          channel.configEncrypted,
          runtime.env.APP_SECRET_KEY,
        )
      : {}

    return { channel, config: webChannelAdapter.parseConfig(raw), suspended: false } as const
  }

  /** The origin rule is the channel's, so a pilot can allow none and production can list them. */
  function originAllowed(allowed: string[], origin: string | undefined): boolean {
    if (allowed.length === 0) return true
    return typeof origin === 'string' && allowed.includes(origin)
  }

  async function readSession(
    channelId: string,
    header: string | undefined,
  ): Promise<SessionClaims | null> {
    if (!header) return null
    const loaded = await loadChannel(channelId)
    if (!loaded?.channel.webhookSecret) return null
    try {
      const claims = await verifySignedPayload(
        header,
        loaded.channel.webhookSecret,
        sessionClaimsSchema,
      )
      return claims.channelId === channelId ? claims : null
    } catch {
      return null
    }
  }

  /** The conversation this visitor owns, or null. Never taken from the request. */
  async function conversationFor(
    channelId: string,
    externalId: string,
  ): Promise<{ id: string; workspaceId: string } | null> {
    const rows = await db
      .select({
        id: schema.conversations.id,
        workspaceId: schema.conversations.workspaceId,
      })
      .from(schema.conversations)
      .innerJoin(
        schema.channelIdentities,
        eq(schema.channelIdentities.id, schema.conversations.channelIdentityId),
      )
      .where(
        and(
          eq(schema.channelIdentities.channelId, channelId),
          eq(schema.channelIdentities.externalId, externalId),
        ),
      )
      .orderBy(asc(schema.conversations.createdAt))
      .limit(1)
    return rows[0] ?? null
  }

  return (
    // The prefix comes from the group in app.ts, so this adds none of its own.
    new Elysia({ name: 'widget-routes' })
      /**
       * Start or resume a visitor's session. The only endpoint that accepts a host token.
       */
      .post(
        '/:channelId/session',
        async ({ params, body, request, status }) => {
          const loaded = await loadChannel(params.channelId)
          if (!loaded) return status(404, { error: 'Unknown widget channel' })
          if (!loaded.config) {
            return loaded.suspended
              ? status(403, { error: 'This workspace is suspended', code: 'workspace_suspended' })
              : status(404, { error: 'Unknown widget channel' })
          }
          if (
            !originAllowed(loaded.config.allowedOrigins, request.headers.get('origin') ?? undefined)
          ) {
            return status(403, { error: 'This origin may not embed the widget' })
          }
          if (!loaded.channel.webhookSecret) {
            return status(500, { error: 'Widget channel has no secret' })
          }

          const visitor = await resolveWebVisitor(
            { visitorId: body.visitorId, ...(body.token ? { token: body.token } : {}) },
            loaded.config,
          )

          const session = await signPayload(
            {
              channelId: params.channelId,
              externalId: visitor.externalId,
              identified: visitor.identified,
              ...(visitor.verified ? { verified: visitor.verified } : {}),
              exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
            } satisfies SessionClaims,
            loaded.channel.webhookSecret,
          )

          return {
            session,
            identified: visitor.identified,
            displayName: visitor.displayName,
          }
        },
        {
          params: z.object({ channelId: z.string() }),
          body: z.object({
            visitorId: z.string().min(1).max(200),
            token: z.string().max(4000).optional(),
          }),
        },
      )

      /** Send one message as the visitor this session belongs to. */
      .post(
        '/:channelId/messages',
        async ({ params, body, headers, status }) => {
          const session = await readSession(params.channelId, headers['x-widget-session'])
          if (!session) return status(401, { error: 'No widget session' })

          const outcome = await ingestWebhook(
            runtime,
            db,
            params.channelId,
            toWebhookRequest(
              JSON.stringify({
                /**
                 * The resolved identity from the signed session, prefix and all, never the
                 * raw id from the request body. The prefix is what keeps an anonymous
                 * browser and a logged-in account apart, and it has to be the same string
                 * the conversation is looked up by afterwards.
                 */
                visitorId: session.externalId,
                message: { kind: 'text', text: body.text },
                eventId: `widget-${crypto.randomUUID()}`,
                // From the session we signed, never from the request body: a widget that
                // could assert its own identity would be no proof at all.
                ...(session.verified ? { verified: session.verified } : {}),
              }),
              {},
              {},
            ),
          )
          if (!outcome.ok) {
            // The same answer the session endpoint gives, so a widget that was already open
            // when the tenant was suspended learns the same thing a fresh one does.
            if (outcome.reason === 'workspace_suspended') {
              return status(403, {
                error: 'This workspace is suspended',
                code: 'workspace_suspended',
              })
            }
            return status(400, { error: outcome.reason })
          }
          return { received: true }
        },
        {
          params: z.object({ channelId: z.string() }),
          body: z.object({ text: z.string().min(1).max(4000) }),
        },
      )

      /**
       * Everything said in this visitor's conversation, optionally since a cursor.
       *
       * Polled rather than pushed. The console has a socket because an agent keeps it open
       * all day; a widget is open for a few minutes, and a poll works through every corporate
       * proxy without a reconnection story.
       */
      .get(
        '/:channelId/messages',
        async ({ params, query, headers, status }) => {
          const session = await readSession(params.channelId, headers['x-widget-session'])
          if (!session) return status(401, { error: 'No widget session' })

          const conversation = await conversationFor(params.channelId, session.externalId)
          if (!conversation) return { messages: [], conversationId: null }

          const since = query.since ? new Date(query.since) : null
          const rows = await db
            .select({
              id: schema.messages.id,
              senderType: schema.messages.senderType,
              direction: schema.messages.direction,
              content: schema.messages.content,
              createdAt: schema.messages.createdAt,
            })
            .from(schema.messages)
            .where(
              and(
                eq(schema.messages.conversationId, conversation.id),
                ...(since && !Number.isNaN(since.getTime())
                  ? [gt(schema.messages.createdAt, since)]
                  : []),
              ),
            )
            .orderBy(asc(schema.messages.createdAt))
            .limit(100)

          return {
            conversationId: conversation.id,
            messages: rows
              // Internal events are not part of a customer's view of their own conversation.
              .filter((row) => (row.content as { kind?: string }).kind !== 'event')
              .map((row) => ({
                id: row.id,
                // The customer does not need to know whether a person or the AI answered.
                from: row.direction === 'inbound' ? 'you' : 'support',
                text: (row.content as { text?: string | null }).text ?? '',
                at: row.createdAt.toISOString(),
              })),
          }
        },
        {
          params: z.object({ channelId: z.string() }),
          query: z.object({ since: z.string().optional() }),
        },
      )
  )
}
