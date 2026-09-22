import { type Executor, newId, schema, type Transaction } from '@ci/db'
import {
  INVITE_TTL_MS,
  inviteLink,
  issueInvitation,
  listPendingInvitations,
  PASSWORD_RESET_TTL_MS,
  revokeInvitation,
} from '@ci/infra'
import { createInvitationBodySchema, updateMemberBodySchema } from '@ci/shared'
import { and, eq, sql } from 'drizzle-orm'
import Elysia from 'elysia'
import { z } from 'zod'
import { authPlugin } from '../auth-plugin'
import type { ApiContext } from '../context'

/**
 * The people in one workspace.
 *
 * Admin-only throughout: this is the surface that decides who can read a tenant's
 * conversations, which is the most consequential thing an admin does that is not a
 * credential.
 *
 * Nothing here deletes an account. Removing somebody takes away their membership of this
 * workspace and no more, because the account may belong to other tenants and because their
 * name is attached to messages they sent. An account is deleted by deleting the person, and
 * that is not an operation one tenant's admin gets to perform.
 */
export function adminRoutes(ctx: ApiContext) {
  const { db, env } = ctx

  /**
   * Refuse to remove the last admin, having locked the whole set first.
   *
   * The lock is over every admin row rather than the one being changed, because the
   * question is about the count. Two admins demoting each other at the same instant would
   * each see one other admin and each be allowed through, and the workspace would be left
   * with nobody who can invite anyone.
   */
  const wouldStrandWorkspace = async (
    tx: Transaction,
    workspaceId: string,
    targetUserId: string,
  ): Promise<boolean> => {
    const admins = await tx
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, workspaceId), eq(schema.member.role, 'admin')))
      .for('update')

    return admins.length === 1 && admins[0]?.userId === targetUserId
  }

  const audit = async (
    executor: Executor,
    input: {
      workspaceId: string
      actorUserId: string
      action: string
      targetId: string
      meta?: Record<string, unknown>
    },
  ) => {
    await executor.insert(schema.auditLog).values({
      id: newId(),
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      action: input.action,
      targetType: 'member',
      targetId: input.targetId,
      meta: input.meta ?? {},
    })
  }

  return (
    new Elysia({ prefix: '/admin' })
      .use(authPlugin(ctx))

      .get(
        '/members',
        async ({ workspaceId, user }) => {
          const members = await db
            .select({
              userId: schema.member.userId,
              role: schema.member.role,
              name: schema.user.name,
              email: schema.user.email,
              image: schema.user.image,
              joinedAt: schema.member.createdAt,
            })
            .from(schema.member)
            .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
            .where(eq(schema.member.organizationId, workspaceId))
            .orderBy(schema.member.createdAt)

          return {
            members: members.map((member) => ({
              ...member,
              isSelf: member.userId === user.id,
            })),
            invitations: await listPendingInvitations(db, workspaceId),
          }
        },
        { auth: 'admin' },
      )

      .patch(
        '/members/:userId',
        async ({ workspaceId, params, body, status, user }) => {
          const existing = await db
            .select({ role: schema.member.role })
            .from(schema.member)
            .where(
              and(
                eq(schema.member.organizationId, workspaceId),
                eq(schema.member.userId, params.userId),
              ),
            )
            .limit(1)
          if (existing.length === 0) return status(404, { error: 'Not a member' })

          if (body.role && body.role !== 'admin') {
            const stranded = await db.transaction((tx) =>
              wouldStrandWorkspace(tx, workspaceId, params.userId),
            )
            if (stranded) {
              return status(409, { error: 'A workspace needs at least one admin' })
            }
          }

          if (body.role) {
            await db
              .update(schema.member)
              .set({ role: body.role })
              .where(
                and(
                  eq(schema.member.organizationId, workspaceId),
                  eq(schema.member.userId, params.userId),
                ),
              )
          }

          // Only after the membership check above, so this cannot rename a stranger.
          if (body.name) {
            await db
              .update(schema.user)
              .set({ name: body.name, updatedAt: new Date() })
              .where(eq(schema.user.id, params.userId))
          }

          await audit(db, {
            workspaceId,
            actorUserId: user.id,
            action: 'member.updated',
            targetId: params.userId,
            meta: {
              ...(body.role ? { role: body.role, was: existing[0]?.role } : {}),
              ...(body.name ? { renamed: true } : {}),
            },
          })

          return { ok: true as const }
        },
        {
          auth: 'admin',
          params: z.object({ userId: z.string() }),
          body: updateMemberBodySchema,
        },
      )

      .delete(
        '/members/:userId',
        async ({ workspaceId, params, status, user }) => {
          const stranded = await db.transaction((tx) =>
            wouldStrandWorkspace(tx, workspaceId, params.userId),
          )
          if (stranded) return status(409, { error: 'A workspace needs at least one admin' })

          const removed = await db
            .delete(schema.member)
            .where(
              and(
                eq(schema.member.organizationId, workspaceId),
                eq(schema.member.userId, params.userId),
              ),
            )
            .returning({ id: schema.member.id })
          if (removed.length === 0) return status(404, { error: 'Not a member' })

          await audit(db, {
            workspaceId,
            actorUserId: user.id,
            action: 'member.removed',
            targetId: params.userId,
          })

          return { ok: true as const }
        },
        { auth: 'admin', params: z.object({ userId: z.string() }) },
      )

      /**
       * Invite somebody, and hand the link back once.
       *
       * The link is returned in this response and never again, which is why the console
       * shows it with an instruction to copy it. Storing it so it could be shown twice
       * would mean storing a working credential.
       */
      .post(
        '/invitations',
        async ({ workspaceId, body, status, user }) => {
          const existingMember = await db
            .select({ userId: schema.member.userId })
            .from(schema.member)
            .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
            .where(
              and(
                eq(schema.member.organizationId, workspaceId),
                sql`lower(${schema.user.email}) = ${body.email}`,
              ),
            )
            .limit(1)
          if (existingMember.length > 0) {
            return status(409, { error: 'That person is already a member' })
          }

          const account = await db
            .select({ id: schema.user.id })
            .from(schema.user)
            .where(sql`lower(${schema.user.email}) = ${body.email}`)
            .limit(1)

          const invitation = await issueInvitation(db, {
            workspaceId,
            purpose: 'invite',
            email: body.email,
            role: body.role,
            userId: account[0]?.id ?? null,
            invitedByUserId: user.id,
            ttlMs: INVITE_TTL_MS,
          })

          await audit(db, {
            workspaceId,
            actorUserId: user.id,
            action: 'member.invited',
            targetId: invitation.id,
            meta: { email: body.email, role: body.role },
          })

          return {
            id: invitation.id,
            link: inviteLink(env.PUBLIC_WEB_URL, invitation.token),
            expiresAt: invitation.expiresAt,
            /** The page they land on differs, so the console can say which to expect. */
            existingAccount: account.length > 0,
          }
        },
        { auth: 'admin', body: createInvitationBodySchema },
      )

      .delete(
        '/invitations/:id',
        async ({ workspaceId, params, status, user }) => {
          const revoked = await revokeInvitation(db, workspaceId, params.id)
          if (!revoked) return status(404, { error: 'Invitation not found' })

          await audit(db, {
            workspaceId,
            actorUserId: user.id,
            action: 'invitation.revoked',
            targetId: params.id,
          })

          return { ok: true as const }
        },
        { auth: 'admin', params: z.object({ id: z.string() }) },
      )

      /**
       * A way back in for somebody locked out.
       *
       * Issued by their admin rather than requested by email, because there is no mail
       * transport here to prove an address with. That makes the admin the one who decides
       * the person asking really is the person, which is a judgement they are better placed
       * to make than a mail server is anyway.
       */
      .post(
        '/members/:userId/reset-link',
        async ({ workspaceId, params, status, user }) => {
          const rows = await db
            .select({ email: schema.user.email })
            .from(schema.member)
            .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
            .where(
              and(
                eq(schema.member.organizationId, workspaceId),
                eq(schema.member.userId, params.userId),
              ),
            )
            .limit(1)
          const target = rows[0]
          if (!target) return status(404, { error: 'Not a member' })

          const invitation = await issueInvitation(db, {
            workspaceId,
            purpose: 'password_reset',
            email: target.email,
            userId: params.userId,
            invitedByUserId: user.id,
            ttlMs: PASSWORD_RESET_TTL_MS,
          })

          await audit(db, {
            workspaceId,
            actorUserId: user.id,
            action: 'member.reset_link_issued',
            targetId: params.userId,
          })

          return {
            link: inviteLink(env.PUBLIC_WEB_URL, invitation.token),
            expiresAt: invitation.expiresAt,
          }
        },
        { auth: 'admin', params: z.object({ userId: z.string() }) },
      )
  )
}
