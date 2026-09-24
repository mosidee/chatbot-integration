import { getAdapter, type WebhookRequest } from '@ci/channels'
import { type Database, decryptJson, newId, schema } from '@ci/db'
import type { VerifiedIdentity } from '@ci/shared'
import { and, eq } from 'drizzle-orm'
import type { Runtime } from './runtime'

/**
 * Webhook ingestion.
 *
 * Verify the signature, persist the raw request, enqueue, return. Nothing else: LINE and
 * Meta retry or disable endpoints that answer slowly, so parsing and AI work happen in the
 * worker. The raw request is stored rather than a parsed form so a payload we misread can
 * be replayed after the adapter is fixed.
 */

export type IngestOutcome =
  | { ok: true; inboundEventId: string; duplicate: boolean }
  | { ok: false; reason: 'channel_not_found' | 'invalid_signature' | 'workspace_suspended' }

/** Stable id for an identical retried delivery. */
async function fingerprint(rawBody: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawBody))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * The identity we proved before ingestion, carried beside the body rather than inside it.
 *
 * Only `ingestInternal` can set it, and only the widget session route passes one: it has
 * just verified the host application's token and signed a session of its own. A body can
 * never name it, which is the whole point — see `web-channel.ts`.
 */
export type TrustedEnvelope = {
  verified?: VerifiedIdentity & { via: 'widget_token' }
}

export async function ingestWebhook(
  runtime: Runtime,
  db: Database,
  channelId: string,
  request: WebhookRequest,
): Promise<IngestOutcome> {
  const rows = await db
    .select({ channel: schema.channels, status: schema.workspaces.status })
    .from(schema.channels)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.channels.workspaceId))
    .where(eq(schema.channels.id, channelId))
    .limit(1)
  const channel = rows[0]?.channel
  if (!channel?.enabled) return { ok: false, reason: 'channel_not_found' }

  /**
   * A tenant that is not active accepts nothing, and is told so before the signature is
   * checked so that no raw payload is persisted for a workspace nobody may read.
   *
   * A workspace being deleted reads as a channel that does not exist, because in a moment
   * it will not. A suspended one is distinguished so the route can answer the platform
   * politely: LINE and Meta disable an endpoint that errors, and a suspension is meant to
   * be reversible without the operator having to re-register their webhooks.
   */
  const status = rows[0]?.status
  if (status === 'suspended') return { ok: false, reason: 'workspace_suspended' }
  if (status !== 'active') return { ok: false, reason: 'channel_not_found' }

  const adapter = getAdapter(channel.type)

  /**
   * The public route serves only channels whose adapter can prove where a request came
   * from, which means a platform signature over the exact bytes received.
   *
   * The web and test channels cannot. Their callers are our own widget and console, which
   * authenticate before they reach ingestion, so they come in through `ingestInternal`
   * instead. Reaching them here reads as a channel that does not exist rather than as a
   * refusal, because a web channel id is public — it is printed in the embed code on the
   * host's own page — and an honest error would confirm which ids are real.
   */
  if (!adapter.capabilities.publicWebhook) return { ok: false, reason: 'channel_not_found' }

  const config = adapter.parseConfig(
    channel.configEncrypted
      ? await decryptJson<unknown>(channel.configEncrypted, runtime.env.APP_SECRET_KEY)
      : {},
  )

  if (!(await adapter.verifyWebhook(request, config))) {
    return { ok: false, reason: 'invalid_signature' }
  }

  const platformEventId = await fingerprint(request.rawBody)

  const existing = await db
    .select({ id: schema.inboundEvents.id })
    .from(schema.inboundEvents)
    .where(
      and(
        eq(schema.inboundEvents.channelId, channelId),
        eq(schema.inboundEvents.platformEventId, platformEventId),
      ),
    )
    .limit(1)

  if (existing[0]) {
    return { ok: true, inboundEventId: existing[0].id, duplicate: true }
  }

  return persistAndQueue(runtime, db, {
    id: newId(),
    workspaceId: channel.workspaceId,
    channelId,
    platformEventId,
    /**
     * The body only. Headers were for the signature, which was checked on the live request
     * above, and they carry a platform's tokens and whatever proxies added; the query holds
     * nothing a parser reads. What is kept is what the worker parses, and it is emptied
     * once the worker has parsed it (see the inbound processor).
     */
    payload: { rawBody: request.rawBody, headers: {}, query: {} },
  })
}

/**
 * Store the event and promise the work, in one transaction.
 *
 * Held apart, a Redis failure between them lost the job and kept the row, and the platform's
 * retry then found the row, answered `duplicate`, and queued nothing: the customer's message
 * sat unread for ever with every part of the system believing it had been handled.
 */
async function persistAndQueue(
  runtime: Runtime,
  db: Database,
  event: {
    id: string
    workspaceId: string
    channelId: string
    platformEventId: string
    payload: unknown
  },
): Promise<IngestOutcome> {
  const duplicate = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.inboundEvents)
      .values({
        id: event.id,
        workspaceId: event.workspaceId,
        channelId: event.channelId,
        platformEventId: event.platformEventId,
        payload: event.payload,
      })
      .onConflictDoNothing()
      .returning({ id: schema.inboundEvents.id })

    if (inserted.length === 0) return true

    await runtime.outbox.enqueue(tx, {
      queue: 'inbound',
      name: 'process',
      workspaceId: event.workspaceId,
      payload: {
        workspaceId: event.workspaceId,
        channelId: event.channelId,
        inboundEventId: event.id,
      },
      jobId: `inbound-${event.id}`,
    })
    return false
  })

  return { ok: true, inboundEventId: event.id, duplicate }
}

/**
 * Ingestion for a caller we have already authenticated ourselves.
 *
 * The widget and the simulator are not platforms: there is no signature to check, because
 * we are both ends of the conversation. The widget presents a session this API signed, and
 * the simulator sits behind an agent's console session. Both are verified by their route
 * before they get here, so this one does no verification of its own — and, crucially, it is
 * the only door through which a proved identity can arrive, in `trusted`, out of reach of
 * anything a caller can put in a body.
 *
 * `expectedType` is belt and braces: a caller passing somebody else's channel id gets
 * nothing, even if that channel were somehow internal too.
 */
export async function ingestInternal(
  runtime: Runtime,
  db: Database,
  input: {
    channelId: string
    expectedType: 'web' | 'test'
    body: unknown
    trusted?: TrustedEnvelope
  },
): Promise<IngestOutcome> {
  const rows = await db
    .select({ channel: schema.channels, status: schema.workspaces.status })
    .from(schema.channels)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.channels.workspaceId))
    .where(eq(schema.channels.id, input.channelId))
    .limit(1)
  const channel = rows[0]?.channel
  if (!channel?.enabled) return { ok: false, reason: 'channel_not_found' }
  if (channel.type !== input.expectedType) return { ok: false, reason: 'channel_not_found' }

  const status = rows[0]?.status
  if (status === 'suspended') return { ok: false, reason: 'workspace_suspended' }
  if (status !== 'active') return { ok: false, reason: 'channel_not_found' }

  /**
   * A body without an event id gets this one, written into the body before it is stored.
   * The adapter used to invent a random id at parse time, inside the worker, so a retried
   * job parsed the same body into a new event and stored the message twice.
   */
  const platformEventId = await fingerprint(JSON.stringify(input.body))
  const body =
    input.body && typeof input.body === 'object' && !('eventId' in input.body && input.body.eventId)
      ? { ...(input.body as object), eventId: platformEventId }
      : input.body
  const rawBody = JSON.stringify(body)

  const existing = await db
    .select({ id: schema.inboundEvents.id })
    .from(schema.inboundEvents)
    .where(
      and(
        eq(schema.inboundEvents.channelId, input.channelId),
        eq(schema.inboundEvents.platformEventId, platformEventId),
      ),
    )
    .limit(1)
  if (existing[0]) {
    return { ok: true, inboundEventId: existing[0].id, duplicate: true }
  }

  return persistAndQueue(runtime, db, {
    id: newId(),
    workspaceId: channel.workspaceId,
    channelId: input.channelId,
    platformEventId,
    // No headers and no query: there is no signature to re-check and nothing else in a
    // request from our own console or widget is worth keeping.
    payload: { rawBody, headers: {}, query: {}, ...(input.trusted ?? {}) },
  })
}

export function toWebhookRequest(
  rawBody: string,
  headers: Record<string, string | undefined>,
  query: Record<string, string | undefined>,
): WebhookRequest {
  const cleanHeaders: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') cleanHeaders[key.toLowerCase()] = value
  }
  const cleanQuery: Record<string, string> = {}
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string') cleanQuery[key] = value
  }
  return { rawBody, headers: cleanHeaders, query: cleanQuery }
}
