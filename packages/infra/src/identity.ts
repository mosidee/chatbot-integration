import type { BoundIdentity } from '@ci/core'
import { type Database, newId, schema } from '@ci/db'
import type { IdentityProof, Language, VerifiedIdentity } from '@ci/shared'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { loadWorkspaceSettings, storeMessage, type TurnContext } from './repo'
import type { Runtime } from './runtime'

/**
 * Proving who a customer is.
 *
 * A channel identity says which LINE account is writing, which is continuity, not proof.
 * Binding an account id into a tool call needs proof, and there are two ways to get it: a
 * token the host application signed for its logged-in user, or a one-time link the person
 * followed and confirmed inside that application.
 *
 * Both are switched separately by the workspace. A proof that is switched off still
 * identifies the visitor — the same person keeps one history — but it stops counting as
 * evidence, so nothing is bound to it. See decision 21 in docs/REQUIREMENTS.md.
 */

/**
 * What the system will bind into this turn's tool calls.
 *
 * The subject survives only if the proof that produced it is still accepted. Turning a
 * proof off therefore withdraws every tool that depends on it, immediately, without
 * touching a stored row.
 */
export function boundIdentityFor(
  context: Pick<TurnContext, 'conversation' | 'identity'>,
  settings: Awaited<ReturnType<typeof loadWorkspaceSettings>>,
): BoundIdentity {
  const { conversation, identity } = context
  const accepted = identityProofAccepted(identity.verifiedVia, settings)

  return {
    workspaceId: conversation.workspaceId,
    conversationId: conversation.id,
    customerId: conversation.customerId,
    subject: accepted ? identity.verifiedSubject : null,
    attributes: accepted ? identity.verifiedAttributes : {},
  }
}

export function identityProofAccepted(
  via: IdentityProof | null,
  settings: Awaited<ReturnType<typeof loadWorkspaceSettings>>,
): boolean {
  if (!via) return false
  return via === 'widget_token'
    ? settings.identity.widgetToken.enabled
    : settings.identity.verificationLink.enabled
}

/** Write a proof onto the channel identity. Idempotent: the newest proof simply wins. */
export async function recordVerifiedIdentity(
  db: Database,
  input: {
    workspaceId: string
    channelIdentityId: string
    verified: VerifiedIdentity
  },
): Promise<void> {
  await db
    .update(schema.channelIdentities)
    .set({
      verifiedSubject: input.verified.subject,
      verifiedAttributes: input.verified.attributes,
      verifiedVia: input.verified.via,
      verifiedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.channelIdentities.id, input.channelIdentityId),
        eq(schema.channelIdentities.workspaceId, input.workspaceId),
      ),
    )
}

/**
 * A code with enough entropy that guessing is not a strategy.
 *
 * `newId()` is time-ordered and therefore partly predictable, which is fine for a primary
 * key and not for a one-time secret handed out over a public chat.
 */
function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function mintVerificationCode(
  db: Database,
  input: {
    workspaceId: string
    conversationId: string
    channelIdentityId: string
    ttlMinutes: number
  },
): Promise<{ code: string; expiresAt: Date }> {
  // Any earlier code for this person stops working. Two live links sent minutes apart is
  // how somebody proves the wrong identity onto the wrong conversation.
  await db
    .update(schema.identityVerifications)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(schema.identityVerifications.workspaceId, input.workspaceId),
        eq(schema.identityVerifications.channelIdentityId, input.channelIdentityId),
        isNull(schema.identityVerifications.usedAt),
      ),
    )

  const code = newCode()
  const expiresAt = new Date(Date.now() + input.ttlMinutes * 60_000)

  await db.insert(schema.identityVerifications).values({
    id: newId(),
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    channelIdentityId: input.channelIdentityId,
    code,
    expiresAt,
  })

  return { code, expiresAt }
}

export type ConsumedVerification = {
  workspaceId: string
  conversationId: string
  channelIdentityId: string
}

/**
 * Look a code up without spending it.
 *
 * Needed because the caller cannot check the confirmation token until it knows which
 * workspace the code belongs to, and burning the code to find that out would let a bad
 * token — a bug in the tenant's page, or anybody who read the code out of the chat and
 * posted nonsense — destroy the customer's only link. Spending still happens in the atomic
 * update below, so this lookup grants nothing on its own.
 */
export async function findVerificationCode(
  db: Database,
  code: string,
): Promise<ConsumedVerification | null> {
  const rows = await db
    .select({
      workspaceId: schema.identityVerifications.workspaceId,
      conversationId: schema.identityVerifications.conversationId,
      channelIdentityId: schema.identityVerifications.channelIdentityId,
    })
    .from(schema.identityVerifications)
    .where(
      and(
        eq(schema.identityVerifications.code, code),
        isNull(schema.identityVerifications.usedAt),
        sql`${schema.identityVerifications.expiresAt} > now()`,
      ),
    )
    .limit(1)

  return rows[0] ?? null
}

/**
 * Spend a code, or refuse.
 *
 * Claimed in the same statement that checks it, so two requests racing the same code
 * cannot both win. Expiry is judged on the database clock for the same reason
 * `reviewed_at` is: the row was written with `now()` and two clocks a second apart would
 * decide differently.
 */
export async function consumeVerificationCode(
  db: Database,
  code: string,
): Promise<ConsumedVerification | null> {
  const rows = await db
    .update(schema.identityVerifications)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        eq(schema.identityVerifications.code, code),
        isNull(schema.identityVerifications.usedAt),
        sql`${schema.identityVerifications.expiresAt} > now()`,
      ),
    )
    .returning({
      workspaceId: schema.identityVerifications.workspaceId,
      conversationId: schema.identityVerifications.conversationId,
      channelIdentityId: schema.identityVerifications.channelIdentityId,
    })

  return rows[0] ?? null
}

const LINK_TEXT: Record<Language, (url: string) => string> = {
  th: (url) => `เพื่อดูข้อมูลบัญชีของคุณ รบกวนกดลิงก์นี้เพื่อยืนยันตัวตนค่ะ ลิงก์ใช้ได้ครั้งเดียว: ${url}`,
  en: (url) =>
    `To look up your account, please confirm it is you by opening this one-time link: ${url}`,
}

export type VerificationLinkResult =
  | { ok: true; messageId: string; code: string }
  | { ok: false; reason: 'disabled' | 'not_configured' | 'conversation_not_found' }

/**
 * Send this customer a one-time link.
 *
 * The message goes out the same way any other outbound message does, so it is stored,
 * redacted, delivered by the channel adapter and visible in the thread. An agent watching
 * the conversation sees exactly what the customer was sent.
 */
export async function sendVerificationLink(
  runtime: Runtime,
  input: { workspaceId: string; conversationId: string },
): Promise<VerificationLinkResult> {
  const { db, queues } = runtime
  const settings = await loadWorkspaceSettings(db, input.workspaceId)
  const link = settings.identity.verificationLink

  if (!link.enabled) return { ok: false, reason: 'disabled' }
  if (!link.url) return { ok: false, reason: 'not_configured' }

  const rows = await db
    .select({
      channelIdentityId: schema.conversations.channelIdentityId,
      customerId: schema.conversations.customerId,
    })
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.id, input.conversationId),
        eq(schema.conversations.workspaceId, input.workspaceId),
      ),
    )
    .limit(1)
  const conversation = rows[0]
  if (!conversation) return { ok: false, reason: 'conversation_not_found' }

  const customerRows = await db
    .select({ primaryLanguage: schema.customers.primaryLanguage })
    .from(schema.customers)
    .where(
      and(
        eq(schema.customers.id, conversation.customerId),
        eq(schema.customers.workspaceId, input.workspaceId),
      ),
    )
    .limit(1)

  const { code } = await mintVerificationCode(db, {
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    channelIdentityId: conversation.channelIdentityId,
    ttlMinutes: link.ttlMinutes,
  })

  const url = new URL(link.url)
  url.searchParams.set('code', code)

  const language: Language = customerRows[0]?.primaryLanguage ?? settings.defaultLanguage
  const text = (LINK_TEXT[language] ?? LINK_TEXT.en)(url.toString())

  const stored = await storeMessage(db, {
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    direction: 'outbound',
    senderType: 'system',
    message: { kind: 'text', text },
    status: 'queued',
    redaction: settings.redaction,
  })

  await queues.outbound.add('send', {
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    messageId: stored.id,
  })

  return { ok: true, messageId: stored.id, code }
}
