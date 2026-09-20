import { getAdapter, type WebhookRequest } from '@ci/channels'
import { type Database, decryptJson, newId, schema } from '@ci/db'
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
  | { ok: false; reason: 'channel_not_found' | 'invalid_signature' }

/** Stable id for an identical retried delivery. */
async function fingerprint(rawBody: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawBody))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function ingestWebhook(
  runtime: Runtime,
  db: Database,
  channelId: string,
  request: WebhookRequest,
): Promise<IngestOutcome> {
  const rows = await db
    .select()
    .from(schema.channels)
    .where(eq(schema.channels.id, channelId))
    .limit(1)
  const channel = rows[0]
  if (!channel?.enabled) return { ok: false, reason: 'channel_not_found' }

  const adapter = getAdapter(channel.type)
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

  const id = newId()
  const inserted = await db
    .insert(schema.inboundEvents)
    .values({
      id,
      workspaceId: channel.workspaceId,
      channelId,
      platformEventId,
      payload: request,
    })
    .onConflictDoNothing()
    .returning({ id: schema.inboundEvents.id })

  if (inserted.length === 0) {
    return { ok: true, inboundEventId: id, duplicate: true }
  }

  await runtime.queues.inbound.add('process', {
    workspaceId: channel.workspaceId,
    channelId,
    inboundEventId: id,
  })

  return { ok: true, inboundEventId: id, duplicate: false }
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
