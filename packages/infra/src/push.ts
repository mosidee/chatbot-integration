import type { Logger, NotifyReason } from '@ci/core'
import { type Database, schema } from '@ci/db'
import {
  isPushServiceEndpoint,
  type Language,
  type NormalizedMessage,
  type PushPayload,
  typedText,
} from '@ci/shared'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import webpush from 'web-push'

/**
 * Web Push to agents' devices (ADR 0010).
 *
 * Queued through the outbox by `notifyAgents`, so a notification is promised in the same
 * transaction as whatever made it necessary and never for a change that rolled back. The
 * job decides everything else when it runs — whether the conversation still needs anybody,
 * who that is, what to say — because a push delivered minutes late about a conversation a
 * colleague has already picked up is noise on somebody's lock screen.
 */

export type PushJob = {
  workspaceId: string
  conversationId: string
  reason: NotifyReason
  /** The customer message behind it, for the text shown. */
  triggerMessageId?: string
}

export type VapidKeys = { publicKey: string; privateKey: string }

export function vapidKeys(env: {
  VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string
}): VapidKeys | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY }
}

/**
 * The VAPID `sub` claim, which Apple and Google see on every request. The console's own
 * address rather than anybody's email: enough for a push service to know whom to contact,
 * and it names no person. It must be https or mailto, which a development console on
 * `http://localhost` is not; there a placeholder stands in, since nothing there is
 * reachable by a push service's operator anyway.
 */
export function vapidSubject(env: { PUBLIC_WEB_URL: string }): string {
  return env.PUBLIC_WEB_URL.startsWith('https://')
    ? env.PUBLIC_WEB_URL
    : 'mailto:push@example.invalid'
}

/**
 * One job per occasion. The trigger message where there is one, since it is the same on
 * every retry of the job that asked; otherwise the instant the effect carries.
 */
export function pushJobId(input: {
  conversationId: string
  reason: NotifyReason
  triggerMessageId?: string
  at: Date
}): string {
  return `push-${input.reason}-${input.conversationId}-${input.triggerMessageId ?? input.at.getTime()}`
}

export type PushDeps = {
  db: Database
  vapid: VapidKeys
  /** From `vapidSubject`. */
  subject: string
  logger: Logger
  /** Replaced in tests; production posts to the push services directly. */
  fetch?: typeof fetch
}

export type PushOutcome = {
  skipped?: string
  sent: number
  gone: number
  failed: number
}

/** How long a push service keeps a notification for a device that is offline. */
const TTL_SECONDS = 60 * 60

/** Enough to recognise the message on a lock screen, not to read the conversation there. */
const SNIPPET = 120

const COPY: Record<Language, Record<NotifyReason, string> & { media: string }> = {
  th: {
    handoff: 'รอพนักงานตอบ',
    timeout: 'ลูกค้ายังรอพนักงานอยู่',
    customer_message: 'ข้อความใหม่',
    draft_ready: 'มีคำตอบรออนุมัติ',
    media: 'ส่งไฟล์หรือรูปภาพ',
  },
  en: {
    handoff: 'Waiting for a person',
    timeout: 'Still waiting for a person',
    customer_message: 'New message',
    draft_ready: 'A reply is waiting for approval',
    media: 'Sent a file or photo',
  },
}

export async function sendPush(deps: PushDeps, job: PushJob): Promise<PushOutcome> {
  const { db } = deps
  const none = (skipped: string): PushOutcome => ({ skipped, sent: 0, gone: 0, failed: 0 })

  const rows = await db
    .select({
      mode: schema.conversations.mode,
      status: schema.conversations.status,
      assigneeUserId: schema.conversations.assigneeUserId,
      customerName: schema.customers.displayName,
      workspaceName: schema.organization.name,
      slug: schema.organization.slug,
      settings: schema.workspaces.settings,
    })
    .from(schema.conversations)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.conversations.customerId))
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.conversations.workspaceId))
    .innerJoin(schema.organization, eq(schema.organization.id, schema.conversations.workspaceId))
    .where(
      and(
        eq(schema.conversations.id, job.conversationId),
        eq(schema.conversations.workspaceId, job.workspaceId),
      ),
    )
    .limit(1)
  const conversation = rows[0]
  if (!conversation) return none('conversation gone')
  if (conversation.status !== 'open') return none('resolved since')

  // Whether it still needs somebody. A handoff a colleague has already taken is answered.
  const stillOwed =
    job.reason === 'draft_ready'
      ? conversation.mode === 'ai_supervised'
      : job.reason === 'customer_message'
        ? conversation.mode === 'human' || conversation.mode === 'waiting_human'
        : conversation.mode === 'waiting_human'
  if (!stillOwed) return none(`no longer owed (${conversation.mode})`)

  /**
   * Who. Somebody holding the conversation is the one its customer is talking to; anything
   * waiting for a person goes to everyone who could be that person. Membership is read now,
   * not when the device subscribed, so a colleague removed since is not told, and a viewer,
   * who cannot answer, never is.
   */
  const onlyAssignee =
    job.reason === 'customer_message' && conversation.mode === 'human'
      ? conversation.assigneeUserId
      : null

  const subscriptions = await db
    .select({
      id: schema.pushSubscriptions.id,
      endpoint: schema.pushSubscriptions.endpoint,
      p256dh: schema.pushSubscriptions.p256dh,
      auth: schema.pushSubscriptions.auth,
    })
    .from(schema.pushSubscriptions)
    .innerJoin(
      schema.member,
      and(
        eq(schema.member.userId, schema.pushSubscriptions.userId),
        eq(schema.member.organizationId, schema.pushSubscriptions.workspaceId),
      ),
    )
    .where(
      and(
        eq(schema.pushSubscriptions.workspaceId, job.workspaceId),
        inArray(schema.member.role, ['agent', 'admin']),
        onlyAssignee ? eq(schema.pushSubscriptions.userId, onlyAssignee) : undefined,
      ),
    )
  if (subscriptions.length === 0) return none('nobody subscribed')

  const language: Language = conversation.settings.defaultLanguage === 'en' ? 'en' : 'th'
  const copy = COPY[language]
  const said = await customerWords(db, job)
  const body =
    job.reason === 'customer_message' || job.reason === 'handoff'
      ? `${copy[job.reason]}: ${said ?? copy.media}`
      : copy[job.reason]

  const waiting = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.workspaceId, job.workspaceId),
        eq(schema.conversations.status, 'open'),
        eq(schema.conversations.mode, 'waiting_human'),
      ),
    )

  const payload: PushPayload = {
    title: `${conversation.customerName ?? (language === 'th' ? 'ลูกค้า' : 'Customer')} · ${conversation.workspaceName}`,
    body,
    // One notification per conversation on a device: the newest replaces the last.
    tag: job.conversationId,
    url: `/${conversation.slug}?tab=${conversation.mode === 'waiting_human' ? 'waiting' : 'open'}&c=${job.conversationId}`,
    badge: waiting[0]?.n ?? 0,
  }

  const outcome: PushOutcome = { sent: 0, gone: 0, failed: 0 }
  let transient = 0

  for (const subscription of subscriptions) {
    const result = await postPush(deps, subscription, payload, job.conversationId)
    if (result === 'sent') outcome.sent += 1
    else if (result === 'gone') {
      await forget(db, job.workspaceId, subscription.id)
      outcome.gone += 1
    } else {
      outcome.failed += 1
      if (result === 'transient') transient += 1
    }
  }

  /**
   * Retried only when nothing arrived anywhere and every failure might pass. A retry sends
   * to every device again, so once one has shown the notification a second pass would buzz
   * it twice for a conversation somebody else's phone missed — and a missed push is covered
   * by the inbox, which is where everybody is going anyway.
   */
  if (outcome.sent === 0 && transient > 0 && transient === outcome.failed) {
    throw new Error(`push failed for every device (${transient})`)
  }
  return outcome
}

type Subscription = { id: string; endpoint: string; p256dh: string; auth: string }

/**
 * One encrypted post to one device's push service.
 *
 * `gone` means the device will never take another (unsubscribed, app removed from the home
 * screen, or an endpoint off the list); `transient` is a failure worth retrying.
 */
async function postPush(
  deps: PushDeps,
  subscription: Subscription,
  payload: PushPayload,
  topic: string,
): Promise<'sent' | 'gone' | 'transient' | 'refused'> {
  // Checked when it was saved, and again here: a row written before the rule, or by hand,
  // must not become a way to make the worker post somewhere else.
  if (!isPushServiceEndpoint(subscription.endpoint)) return 'gone'
  const service = new URL(subscription.endpoint).hostname

  const request = webpush.generateRequestDetails(
    {
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth },
    },
    JSON.stringify(payload),
    {
      vapidDetails: { subject: deps.subject, ...deps.vapid },
      TTL: TTL_SECONDS,
      urgency: 'high',
      // A device that was offline gets the latest word on a conversation, not every one.
      // At most 32 URL-safe characters: a UUID without its dashes is exactly that.
      ...(/^[A-Za-z0-9_-]{1,32}$/.test(topic.replaceAll('-', ''))
        ? { topic: topic.replaceAll('-', '') }
        : {}),
      contentEncoding: 'aes128gcm',
    },
  )

  try {
    const response = await (deps.fetch ?? fetch)(request.endpoint, {
      method: request.method,
      headers: request.headers as Record<string, string>,
      body: request.body as Uint8Array<ArrayBuffer>,
      // The endpoint's host was checked; a redirect would be a host that was not.
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    await response.body?.cancel()
    if (response.ok) return 'sent'
    // The browser unsubscribed, or the app was removed from the home screen.
    if (response.status === 404 || response.status === 410) return 'gone'
    deps.logger.warn('push refused', { status: response.status, service })
    return response.status === 429 || response.status >= 500 ? 'transient' : 'refused'
  } catch (error) {
    deps.logger.warn('push failed', {
      service,
      error: error instanceof Error ? error.message : String(error),
    })
    return 'transient'
  }
}

async function forget(db: Database, workspaceId: string, id: string): Promise<void> {
  await db
    .delete(schema.pushSubscriptions)
    .where(
      and(
        eq(schema.pushSubscriptions.id, id),
        eq(schema.pushSubscriptions.workspaceId, workspaceId),
      ),
    )
}

/**
 * The console's "send a test" button: one notification to the device asking, so somebody
 * setting up a phone learns at once whether it works rather than at the next handoff.
 */
export async function sendTestPush(
  deps: PushDeps,
  input: { workspaceId: string; userId: string; endpoint: string; language: Language },
): Promise<'sent' | 'not_subscribed' | 'gone' | 'failed'> {
  const rows = await deps.db
    .select({
      id: schema.pushSubscriptions.id,
      endpoint: schema.pushSubscriptions.endpoint,
      p256dh: schema.pushSubscriptions.p256dh,
      auth: schema.pushSubscriptions.auth,
      workspaceName: schema.organization.name,
      slug: schema.organization.slug,
    })
    .from(schema.pushSubscriptions)
    .innerJoin(
      schema.organization,
      eq(schema.organization.id, schema.pushSubscriptions.workspaceId),
    )
    .where(
      and(
        eq(schema.pushSubscriptions.workspaceId, input.workspaceId),
        eq(schema.pushSubscriptions.userId, input.userId),
        eq(schema.pushSubscriptions.endpoint, input.endpoint),
      ),
    )
    .limit(1)
  const subscription = rows[0]
  if (!subscription) return 'not_subscribed'

  const result = await postPush(
    deps,
    subscription,
    {
      title: subscription.workspaceName,
      body:
        input.language === 'en'
          ? 'Notifications are working on this device.'
          : 'การแจ้งเตือนใช้งานได้บนอุปกรณ์นี้แล้ว',
      tag: 'test',
      url: `/${subscription.slug}`,
      badge: 0,
    },
    'test',
  )
  if (result === 'gone') await forget(deps.db, input.workspaceId, subscription.id)
  return result === 'sent' ? 'sent' : result === 'gone' ? 'gone' : 'failed'
}

/** What the customer said, in their words, short enough for a lock screen. */
async function customerWords(db: Database, job: PushJob): Promise<string | null> {
  const rows = await db
    .select({ content: schema.messages.content })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.workspaceId, job.workspaceId),
        eq(schema.messages.conversationId, job.conversationId),
        eq(schema.messages.senderType, 'customer'),
        job.triggerMessageId ? eq(schema.messages.id, job.triggerMessageId) : undefined,
      ),
    )
    .orderBy(desc(schema.messages.id))
    .limit(1)
  const content = rows[0]?.content as NormalizedMessage | undefined
  const text = content ? typedText(content)?.trim() : null
  if (!text) return null
  return text.length > SNIPPET ? `${text.slice(0, SNIPPET - 1)}…` : text
}
