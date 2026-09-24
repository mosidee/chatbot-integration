import {
  resolveWebVisitor,
  signPayload,
  verifySignedPayload,
  webChannelAdapter,
} from '@ci/channels'
import { detectLanguage } from '@ci/core'
import { schema } from '@ci/db'
import { ingestInternal, withMediaLinks } from '@ci/infra'
import type { ConversationMode, Language } from '@ci/shared'
import { identityAttributesSchema } from '@ci/shared'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
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

/**
 * How much of the conversation a returning visitor is handed.
 *
 * Enough to see where they left off, not the whole history: the widget is a corner of
 * somebody else's page, and a thread that has been running for months belongs in the
 * console, not in a 380-pixel card.
 */
const RESUME_PAGE = 30

/** What the visitor is told is happening, which is less than the console is told. */
export type WidgetState = 'ai' | 'waiting' | 'human'

/**
 * Four conversation modes become three.
 *
 * `ai_supervised` reads as `ai` on purpose: a customer does not need to know that a
 * colleague is approving each reply before it reaches them, and telling them would make a
 * careful workspace look slower than a careless one.
 */
function widgetState(mode: ConversationMode): WidgetState {
  if (mode === 'human') return 'human'
  if (mode === 'waiting_human') return 'waiting'
  return 'ai'
}

/**
 * The one line the widget shows about who is answering.
 *
 * Written here rather than in the widget so it can be in the tenant's language, and so the
 * bundle on a customer's website carries no copy that has to be translated to change.
 */
function stateText(state: WidgetState, language: Language): string | null {
  if (state === 'ai') return null
  const copy = {
    th: {
      waiting: 'กำลังส่งต่อให้เจ้าหน้าที่ กรุณารอสักครู่นะคะ',
      human: 'เจ้าหน้าที่กำลังดูแลคุณอยู่',
    },
    en: {
      waiting: 'Passing you to a colleague. One moment.',
      human: 'A colleague is with you.',
    },
  }
  return (copy[language] ?? copy.en)[state]
}

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

/** Only the parts of a stored attachment the widget is allowed to see. */
type WidgetAttachment = {
  storageKey: string | null
  sourceUrl: string | null
  mime: string
  fileName: string | null
}

/** The widget channel, its config, and the secret its session tokens are signed with. */
export async function loadWidgetChannel(ctx: ApiContext, channelId: string) {
  const { db, runtime } = ctx
  const rows = await db
    .select({
      channel: schema.channels,
      status: schema.workspaces.status,
      settings: schema.workspaces.settings,
    })
    .from(schema.channels)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.channels.workspaceId))
    .where(and(eq(schema.channels.id, channelId), eq(schema.channels.type, 'web')))
    .limit(1)
  const channel = rows[0]?.channel
  if (!channel?.enabled) return null

  // The tenant's own language, so the few sentences this route composes itself match the
  // rest of their site rather than defaulting to ours.
  const language: Language = rows[0]?.settings?.defaultLanguage ?? 'th'

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
    return { channel, config: null, language, suspended: status === 'suspended' } as const
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

  return {
    channel,
    config: webChannelAdapter.parseConfig(raw),
    language,
    suspended: false,
  } as const
}

/**
 * Which pages may frame this channel's widget, as a CSP `frame-ancestors` value.
 *
 * The embedding restriction belongs at the frame. The session request comes from inside
 * the iframe, so its `Origin` is ours, never the host page's, and checking it against the
 * host allowlist refused every legitimate visitor as soon as the list was non-empty.
 * Null when the channel allows any page, or does not exist (the page then fails anyway).
 */
export async function widgetFrameAncestors(
  ctx: ApiContext,
  channelId: string,
): Promise<string | null> {
  const loaded = await loadWidgetChannel(ctx, channelId)
  const allowed = loaded?.config?.allowedOrigins ?? []
  if (allowed.length === 0) return null
  const origins = allowed.flatMap((entry) => {
    try {
      return [new URL(entry).origin]
    } catch {
      return []
    }
  })
  return ["'self'", ...origins].join(' ')
}

export function widgetRoutes(ctx: ApiContext) {
  const { db, runtime, env } = ctx

  const loadChannel = (channelId: string) => loadWidgetChannel(ctx, channelId)

  /**
   * Who may start a session.
   *
   * Our own iframe always may: that is where the widget runs, whatever page framed it, and
   * which pages may frame it is `widgetFrameAncestors`' job. A host page calling the API
   * directly is held to the channel's list, as before. An empty list allows anyone.
   */
  const ownOrigins = new Set(
    [env.PUBLIC_API_URL, env.PUBLIC_WEB_URL, env.WEBHOOK_BASE_URL].flatMap((value) => {
      try {
        return [new URL(value).origin]
      } catch {
        return []
      }
    }),
  )
  function sessionOriginAllowed(allowed: string[], origin: string | null): boolean {
    if (allowed.length === 0) return true
    if (!origin) return false
    return ownOrigins.has(origin) || allowed.includes(origin)
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

  /** The last thing this visitor typed, which is the evidence for what language they read. */
  /** A message's files as links the visitor can open without a session. */
  async function widgetAttachments(content: unknown, workspaceId: string) {
    const withLinks = await withMediaLinks(
      { kind: 'file', ...(content as object) } as {
        kind: string
        attachments?: WidgetAttachment[]
      },
      {
        workspaceId,
        secret: env.APP_SECRET_KEY,
        baseUrl: env.WEBHOOK_BASE_URL,
        ttlDays: env.MEDIA_LINK_TTL_DAYS,
      },
    ).catch(() => ({ attachments: [] as WidgetAttachment[] }))
    // A link that cannot be signed — a key outside the workspace — is left out, not shown dead.
    return (withLinks.attachments ?? [])
      .filter((attachment) => Boolean(attachment.sourceUrl))
      .map((attachment) => ({
        url: attachment.sourceUrl as string,
        mime: attachment.mime,
        fileName: attachment.fileName,
      }))
  }

  async function lastCustomerText(
    workspaceId: string,
    conversationId: string,
  ): Promise<string | null> {
    const rows = await db
      .select({ text: schema.messages.text })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.workspaceId, workspaceId),
          eq(schema.messages.conversationId, conversationId),
          eq(schema.messages.senderType, 'customer'),
        ),
      )
      .orderBy(desc(schema.messages.createdAt))
      .limit(1)
    return rows[0]?.text ?? null
  }

  /** The conversation this visitor owns, or null. Never taken from the request. */
  async function conversationFor(
    channelId: string,
    externalId: string,
  ): Promise<{ id: string; workspaceId: string; mode: ConversationMode } | null> {
    const rows = await db
      .select({
        id: schema.conversations.id,
        workspaceId: schema.conversations.workspaceId,
        mode: schema.conversations.mode,
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
          if (!sessionOriginAllowed(loaded.config.allowedOrigins, request.headers.get('origin'))) {
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

          /**
           * Internal ingestion, not the public webhook.
           *
           * This request has already proved itself: `readSession` verified the session this
           * API signed, after checking the host application's token and the embedding
           * origin at `/session`. There is no platform signature to check because there is
           * no platform — both ends are ours.
           *
           * It also used to be refused outright. The old call went through the web
           * adapter's `verifyWebhook` with an empty header map, so any tenant that filled in
           * `allowedOrigins` got sessions and then a rejection on every message they tried
           * to send.
           */
          const outcome = await ingestInternal(runtime, db, {
            channelId: params.channelId,
            expectedType: 'web',
            body: {
              /**
               * The resolved identity from the signed session, prefix and all, never the
               * raw id from the request body. The prefix is what keeps an anonymous
               * browser and a logged-in account apart, and it has to be the same string
               * the conversation is looked up by afterwards.
               */
              visitorId: session.externalId,
              message: { kind: 'text', text: body.text },
              /**
               * Chosen by the browser, once per message, so a send it retries after a
               * dropped response is the same event and is stored once. Scoped by the
               * visitor, so one visitor's ids cannot collide with another's.
               */
              eventId: body.clientMessageId
                ? `widget-${session.externalId}-${body.clientMessageId}`
                : `widget-${crypto.randomUUID()}`,
            },
            /**
             * Beside the body, out of reach of anything a caller could send. From the
             * session we signed: a widget that could assert its own identity would be no
             * proof at all, and a body that could carry one was exactly the hole.
             */
            ...(session.verified ? { trusted: { verified: session.verified } } : {}),
          })
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
          body: z.object({
            text: z.string().min(1).max(4000),
            clientMessageId: z
              .string()
              .regex(/^[A-Za-z0-9_-]{8,64}$/)
              .optional(),
          }),
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

          /**
           * The poll answers the same way the other two routes do.
           *
           * Without this a widget already open on a suspended tenant's site goes on
           * rendering the conversation every few seconds and only discovers anything is
           * wrong when the person tries to send. Whether the chat looks alive is decided
           * here, not on the send path.
           */
          const loaded = await loadChannel(params.channelId)
          if (!loaded) return status(404, { error: 'Unknown widget channel' })
          if (!loaded.config) {
            return loaded.suspended
              ? status(403, { error: 'This workspace is suspended', code: 'workspace_suspended' })
              : status(404, { error: 'Unknown widget channel' })
          }

          const conversation = await conversationFor(params.channelId, session.externalId)
          if (!conversation) {
            return { messages: [], conversationId: null, state: 'ai' as const, stateText: null }
          }

          const since = query.since ? new Date(query.since) : null
          const resuming = !since || Number.isNaN(since.getTime())

          /**
           * The newest page first, then forwards from a cursor.
           *
           * A visitor who has been chatting for months has more than the hundred rows this
           * ever returns, and ascending order handed them the oldest hundred: the cursor
           * then stuck at message one hundred and every later poll returned the same
           * window, so the conversation looked dead while replies piled up behind it.
           * Opening the widget shows the end of the conversation, which is where they
           * left off.
           */
          /**
           * When a row became part of the visitor's conversation: an inbound one when it
           * arrived, a reply when it was sent. Paging by this rather than `created_at` is
           * what lets a queued reply stay hidden without being skipped for good once a later
           * row has moved the cursor past it.
           */
          const visibleAt = sql<Date>`coalesce(${schema.messages.sentAt}, ${schema.messages.createdAt})`
          const rows = await db
            .select({
              id: schema.messages.id,
              senderType: schema.messages.senderType,
              direction: schema.messages.direction,
              content: schema.messages.content,
              visibleAt: sql<string>`${visibleAt}`,
            })
            .from(schema.messages)
            .where(
              and(
                eq(schema.messages.workspaceId, conversation.workspaceId),
                eq(schema.messages.conversationId, conversation.id),
                // Internal events are not part of a customer's view of their own
                // conversation. Excluded in SQL rather than afterwards, or a burst of them
                // eats the page and the visitor is handed fewer messages than were asked for.
                // Through coalesce: a row with no kind is not an event, and a bare `<>` against
                // NULL is NULL, which would have hidden it.
                sql`coalesce(${schema.messages.content}->>'kind', '') <> 'event'`,
                /**
                 * Only what actually reached them. A queued reply may yet be withdrawn, and a
                 * failed one — a reply blocked because a colleague took over — never went
                 * out at all: showing it here said on the web what the takeover had stopped.
                 */
                sql`(${schema.messages.direction} = 'inbound' OR ${schema.messages.status} IN ('sent', 'delivered', 'read'))`,
                ...(resuming
                  ? []
                  : [sql`${visibleAt} > ${(since as Date).toISOString()}::timestamptz`]),
              ),
            )
            .orderBy(
              ...(resuming
                ? [sql`${visibleAt} desc`, desc(schema.messages.id)]
                : [sql`${visibleAt} asc`, asc(schema.messages.id)]),
            )
            .limit(resuming ? RESUME_PAGE : 100)

          if (resuming) rows.reverse()

          const state = widgetState(conversation.mode)

          /**
           * The language to say it in: the visitor's, not the tenant's.
           *
           * Only looked up when there is something to say, which is while somebody is being
           * fetched. The AI answering needs no line of its own, and that is almost every
           * poll, so the common path stays one query.
           */
          const language =
            state === 'ai'
              ? loaded.language
              : (detectLanguage(
                  await lastCustomerText(conversation.workspaceId, conversation.id),
                ) ?? loaded.language)

          return {
            conversationId: conversation.id,
            /**
             * Whether anyone is answering, and what to say about it.
             *
             * The widget carries no copy of its own for this: the words are chosen here, so
             * a visitor writing English is not told in Thai that a colleague is coming while
             * the reply beside it is in English.
             */
            state,
            stateText: stateText(state, language),
            messages: await Promise.all(
              rows.map(async (row) => ({
                id: row.id,
                // The iframe app still keys its bubbles on this. It is served with the API, so
                // the two always move together; `sender` is the richer answer.
                from: row.direction === 'inbound' ? 'you' : 'support',
                /**
                 * Who actually wrote it.
                 *
                 * A visitor reading a thread that changes tone mid-way deserves to know
                 * why. `system` is the product speaking rather than either.
                 */
                sender:
                  row.direction === 'inbound'
                    ? ('you' as const)
                    : row.senderType === 'human'
                      ? ('agent' as const)
                      : row.senderType === 'system'
                        ? ('system' as const)
                        : ('ai' as const),
                text: (row.content as { text?: string | null }).text ?? '',
                /**
                 * Files an agent sent, as links the widget can render.
                 *
                 * Signed here, at read time, from the storage key: the outbound job signs a
                 * link for the platform and never stores it, so a file an agent sent never
                 * reached the widget, and a stored link would have expired anyway.
                 */
                attachments: await widgetAttachments(row.content, conversation.workspaceId),
                // Milliseconds, so a `since` built from it sits a hair before the row and the
                // next poll may return it again. The widget drops a repeat by id; a skip is
                // the failure that would matter, and rounding down cannot cause one.
                at: new Date(row.visibleAt).toISOString(),
              })),
            ),
          }
        },
        {
          params: z.object({ channelId: z.string() }),
          query: z.object({ since: z.string().optional() }),
        },
      )
  )
}
