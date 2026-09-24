import { type Database, type Executor, newId, schema } from '@ci/db'
import type { InvitationPurpose, UserRoleName } from '@ci/shared'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'

/**
 * Letting somebody in.
 *
 * There is no mail transport in this product, and adding one to ship user management would
 * have meant a provider, a domain, deliverability and a queue before the first person could
 * be invited. So the console shows the link once and the admin passes it on however they
 * already talk to their colleague. The security property that matters is the same either
 * way: the link is the credential, it works once, and it expires.
 *
 * Only the hash of the token is stored, for the reason every other credential here is
 * encrypted. A link is a password that happens to live in a URL, and a database that can
 * hand back working invitation links is a database that can let somebody into a tenant.
 */

/** 256 bits from the CSPRNG. Guessing is not a strategy and never becomes one. */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Buffer.from(bytes).toString('base64url')
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export type IssuedInvitation = {
  id: string
  /** Shown once, to the admin who will pass it on. It cannot be read back afterwards. */
  token: string
  expiresAt: Date
}

/**
 * Mint a link, and stop any earlier one for the same person and purpose.
 *
 * Two live invitations to the same address is how somebody ends up holding a link that
 * still works long after the admin thought they had replaced it. The same reasoning as
 * `mintVerificationCode`, which does this for the customer-facing proof.
 */
export async function issueInvitation(
  db: Database,
  input: {
    workspaceId: string
    purpose: InvitationPurpose
    email: string
    role?: UserRoleName | null
    userId?: string | null
    invitedByUserId?: string | null
    /** `platform` only from the platform routes; see `workspaceInvitations.issuerScope`. */
    issuerScope?: 'workspace' | 'platform'
    ttlMs: number
  },
): Promise<IssuedInvitation> {
  const email = input.email.trim().toLowerCase()

  await db
    .update(schema.workspaceInvitations)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(schema.workspaceInvitations.workspaceId, input.workspaceId),
        eq(schema.workspaceInvitations.purpose, input.purpose),
        eq(schema.workspaceInvitations.email, email),
        isNull(schema.workspaceInvitations.usedAt),
      ),
    )

  const id = newId()
  const token = newToken()
  const expiresAt = new Date(Date.now() + input.ttlMs)

  await db.insert(schema.workspaceInvitations).values({
    id,
    workspaceId: input.workspaceId,
    purpose: input.purpose,
    email,
    role: input.role ?? null,
    userId: input.userId ?? null,
    tokenHash: await hashToken(token),
    invitedByUserId: input.invitedByUserId ?? null,
    issuerScope: input.issuerScope ?? 'workspace',
    expiresAt,
  })

  return { id, token, expiresAt }
}

export type InvitationRow = {
  id: string
  workspaceId: string
  workspaceName: string
  purpose: InvitationPurpose
  email: string
  role: string | null
  userId: string | null
  issuerScope: 'workspace' | 'platform'
  expiresAt: Date
}

/**
 * How far an account reaches: how many workspaces, and whether it administers the platform.
 *
 * A password reset sets the password on the account, which opens all of that. So this is
 * what decides who may issue one, and it is asked again when the link is spent.
 */
export async function accountReach(
  db: Executor,
  userId: string,
): Promise<{ memberships: number; platformAdmin: boolean; workspaceIds: string[] }> {
  const rows = await db
    .select({
      workspaceIds: sql<
        string[]
      >`coalesce(array_agg(distinct ${schema.member.organizationId}), '{}')`,
      platformAdmin: sql<boolean>`exists (select 1 from ${schema.platformAdmins} where ${schema.platformAdmins.userId} = ${userId})`,
    })
    .from(schema.member)
    .where(eq(schema.member.userId, userId))
  const workspaceIds = (rows[0]?.workspaceIds ?? []).filter(Boolean)
  return {
    memberships: workspaceIds.length,
    platformAdmin: Boolean(rows[0]?.platformAdmin),
    workspaceIds,
  }
}

/**
 * Read a link without spending it.
 *
 * The page the person lands on has to tell them which workspace they are joining and
 * whether they need to choose a password, all before they have done anything. Spending the
 * token to render a page would mean a refresh, or a prefetch, burns the invitation.
 */
export async function findInvitation(db: Database, token: string): Promise<InvitationRow | null> {
  const rows = await db
    .select({
      id: schema.workspaceInvitations.id,
      workspaceId: schema.workspaceInvitations.workspaceId,
      workspaceName: schema.organization.name,
      purpose: schema.workspaceInvitations.purpose,
      email: schema.workspaceInvitations.email,
      role: schema.workspaceInvitations.role,
      userId: schema.workspaceInvitations.userId,
      issuerScope: schema.workspaceInvitations.issuerScope,
      expiresAt: schema.workspaceInvitations.expiresAt,
    })
    .from(schema.workspaceInvitations)
    .innerJoin(
      schema.organization,
      eq(schema.organization.id, schema.workspaceInvitations.workspaceId),
    )
    .where(
      and(
        eq(schema.workspaceInvitations.tokenHash, await hashToken(token)),
        isNull(schema.workspaceInvitations.usedAt),
        sql`${schema.workspaceInvitations.expiresAt} > now()`,
      ),
    )
    .limit(1)

  return rows[0] ?? null
}

/**
 * Spend a link, or refuse.
 *
 * Claimed in the statement that checks it, so two people opening the same link at once
 * cannot both be let in, and judged on the database clock for the same reason the rest of
 * this codebase is: the row was written with one.
 */
export async function consumeInvitation(
  db: Executor,
  token: string,
): Promise<Omit<InvitationRow, 'workspaceName'> | null> {
  const rows = await db
    .update(schema.workspaceInvitations)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        eq(schema.workspaceInvitations.tokenHash, await hashToken(token)),
        isNull(schema.workspaceInvitations.usedAt),
        sql`${schema.workspaceInvitations.expiresAt} > now()`,
      ),
    )
    .returning({
      id: schema.workspaceInvitations.id,
      workspaceId: schema.workspaceInvitations.workspaceId,
      purpose: schema.workspaceInvitations.purpose,
      email: schema.workspaceInvitations.email,
      role: schema.workspaceInvitations.role,
      userId: schema.workspaceInvitations.userId,
      issuerScope: schema.workspaceInvitations.issuerScope,
      expiresAt: schema.workspaceInvitations.expiresAt,
    })

  return rows[0] ?? null
}

export type PendingInvitation = {
  id: string
  email: string
  role: string | null
  expiresAt: Date
  createdAt: Date
  invitedByName: string | null
}

/** Invitations still worth chasing: unspent, unexpired, and to join rather than to reset. */
export async function listPendingInvitations(
  db: Database,
  workspaceId: string,
): Promise<PendingInvitation[]> {
  const inviter = schema.user
  return db
    .select({
      id: schema.workspaceInvitations.id,
      email: schema.workspaceInvitations.email,
      role: schema.workspaceInvitations.role,
      expiresAt: schema.workspaceInvitations.expiresAt,
      createdAt: schema.workspaceInvitations.createdAt,
      invitedByName: inviter.name,
    })
    .from(schema.workspaceInvitations)
    .leftJoin(inviter, eq(inviter.id, schema.workspaceInvitations.invitedByUserId))
    .where(
      and(
        eq(schema.workspaceInvitations.workspaceId, workspaceId),
        eq(schema.workspaceInvitations.purpose, 'invite'),
        isNull(schema.workspaceInvitations.usedAt),
        sql`${schema.workspaceInvitations.expiresAt} > now()`,
      ),
    )
    .orderBy(desc(schema.workspaceInvitations.createdAt))
}

/** Revoking is spending it without letting anybody in. */
export async function revokeInvitation(
  db: Database,
  workspaceId: string,
  id: string,
): Promise<boolean> {
  const rows = await db
    .update(schema.workspaceInvitations)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        eq(schema.workspaceInvitations.id, id),
        eq(schema.workspaceInvitations.workspaceId, workspaceId),
        isNull(schema.workspaceInvitations.usedAt),
      ),
    )
    .returning({ id: schema.workspaceInvitations.id })
  return rows.length > 0
}

/** Where the person is sent. The console is the only thing that can render the page. */
export function inviteLink(publicWebUrl: string, token: string): string {
  return `${publicWebUrl.replace(/\/$/, '')}/invite/${token}`
}

/** Seven days to join; a day to recover an account, because that one is issued on request. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const PASSWORD_RESET_TTL_MS = 24 * 60 * 60 * 1000
