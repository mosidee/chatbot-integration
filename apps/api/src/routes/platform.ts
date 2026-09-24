import { createWorkspace, grantPlatformAdmin, isUniqueViolation, schema } from '@ci/db'
import {
  INVITE_TTL_MS,
  inviteLink,
  issueInvitation,
  listPlatformAdmins,
  listTenants,
  PASSWORD_RESET_TTL_MS,
  requestWorkspaceErasure,
  suspendWorkspace,
  unsuspendWorkspace,
  writePlatformAudit,
} from '@ci/infra'
import { createTenantBodySchema, updateTenantBodySchema, type WorkspaceStatus } from '@ci/shared'
import { eq, sql } from 'drizzle-orm'
import Elysia from 'elysia'
import { z } from 'zod'
import { authPlugin } from '../auth-plugin'
import type { ApiContext } from '../context'

/**
 * The tenants themselves.
 *
 * Guarded by `platform_admins` rather than by a role, and resolving no workspace at all. A
 * platform admin is not thereby a member of anything: to read a tenant's conversations they
 * invite themselves into it like anybody else, and that membership then shows up in the
 * tenant's own member list where its admins can see it.
 */
export function platformRoutes(ctx: ApiContext) {
  const { db, env, runtime } = ctx

  /**
   * Tell whoever is looking at the console that their workspace just changed underneath.
   *
   * A suspension takes effect on the next request either way; this is so somebody halfway
   * through typing a reply finds out then rather than when the send fails.
   */
  const announce = (workspaceId: string, status: WorkspaceStatus) =>
    runtime.publisher.publish(workspaceId, { type: 'workspace.status', status })

  return (
    new Elysia({ prefix: '/platform' })
      .use(authPlugin(ctx))

      .get('/tenants', async () => ({ tenants: await listTenants(db) }), { platform: true })

      /**
       * Create a tenant, and the one link that can get into it.
       *
       * A workspace with no members is unreachable: nothing in the running API can sign
       * anybody up, so the invitation is not a convenience here, it is the only door. It is
       * shown once, like every other invitation.
       */
      .post(
        '/tenants',
        async ({ body, status, user }) => {
          let workspaceId: string
          try {
            const created = await createWorkspace(db, { name: body.name, slug: body.slug })
            workspaceId = created.workspaceId
          } catch (error) {
            if (isUniqueViolation(error)) {
              return status(409, { error: `The slug "${body.slug}" is already in use` })
            }
            throw error
          }

          const invitation = await issueInvitation(db, {
            workspaceId,
            purpose: 'invite',
            email: body.adminEmail,
            role: 'admin',
            invitedByUserId: user.id,
            ttlMs: INVITE_TTL_MS,
          })

          await writePlatformAudit(db, {
            actorUserId: user.id,
            action: 'tenant.created',
            targetId: workspaceId,
            meta: { slug: body.slug, name: body.name, adminEmail: body.adminEmail },
          })

          return {
            id: workspaceId,
            inviteLink: inviteLink(env.PUBLIC_WEB_URL, invitation.token),
            inviteExpiresAt: invitation.expiresAt,
          }
        },
        { platform: true, body: createTenantBodySchema },
      )

      .patch(
        '/tenants/:id',
        async ({ params, body, status, user }) => {
          if (
            body.name === undefined &&
            body.slug === undefined &&
            body.privateEgressOrigins === undefined
          ) {
            return { ok: true as const }
          }

          try {
            if (body.name !== undefined || body.slug !== undefined) {
              const updated = await db
                .update(schema.organization)
                .set({
                  ...(body.name !== undefined ? { name: body.name } : {}),
                  ...(body.slug !== undefined ? { slug: body.slug } : {}),
                })
                .where(eq(schema.organization.id, params.id))
                .returning({ id: schema.organization.id })
              if (updated.length === 0) return status(404, { error: 'Tenant not found' })
            }
            /**
             * Which private or plain-http origins this tenant's providers may reach. Here and
             * nowhere else: a tenant admin configures providers, and letting them approve
             * their own destinations would be the egress rule granting its own exception.
             */
            if (body.privateEgressOrigins !== undefined) {
              const updated = await db
                .update(schema.workspaces)
                .set({
                  privateEgressOrigins: [...new Set(body.privateEgressOrigins)],
                  updatedAt: new Date(),
                })
                .where(eq(schema.workspaces.id, params.id))
                .returning({ id: schema.workspaces.id })
              if (updated.length === 0) return status(404, { error: 'Tenant not found' })
            }
          } catch (error) {
            if (isUniqueViolation(error)) {
              return status(409, { error: `The slug "${body.slug}" is already in use` })
            }
            throw error
          }

          await writePlatformAudit(db, {
            actorUserId: user.id,
            action: 'tenant.updated',
            targetId: params.id,
            meta: { ...body },
          })

          return { ok: true as const }
        },
        { platform: true, params: z.object({ id: z.string() }), body: updateTenantBodySchema },
      )

      .post(
        '/tenants/:id/suspend',
        async ({ params, status, user }) => {
          const suspended = await suspendWorkspace(db, {
            workspaceId: params.id,
            actorUserId: user.id,
          })
          if (!suspended) {
            return status(409, { error: 'Only an active workspace can be suspended' })
          }
          await announce(params.id, 'suspended')
          return { status: 'suspended' as const }
        },
        { platform: true, params: z.object({ id: z.string() }) },
      )

      .post(
        '/tenants/:id/unsuspend',
        async ({ params, status, user }) => {
          const restored = await unsuspendWorkspace(db, {
            workspaceId: params.id,
            actorUserId: user.id,
          })
          if (!restored) {
            return status(409, { error: 'Only a suspended workspace can be restored' })
          }
          await announce(params.id, 'active')
          return { status: 'active' as const }
        },
        { platform: true, params: z.object({ id: z.string() }) },
      )

      /**
       * Delete a tenant, for good.
       *
       * The slug has to be typed. Everything else on this page is reversible and this is
       * not: every conversation, every customer, every uploaded document and every stored
       * image goes, and there is no restore. Asking somebody to type the name of the thing
       * they are destroying is the cheapest protection there is against destroying the
       * wrong one, and it is the same instinct as `db:reset` refusing a non-local database.
       */
      .delete(
        '/tenants/:id',
        async ({ params, body, status, user }) => {
          const rows = await db
            .select({ slug: schema.organization.slug })
            .from(schema.organization)
            .where(eq(schema.organization.id, params.id))
            .limit(1)
          const tenant = rows[0]
          if (!tenant) return status(404, { error: 'Tenant not found' })

          if (body.slug !== tenant.slug) {
            return status(400, { error: 'Type the workspace slug to confirm' })
          }

          const queued = await requestWorkspaceErasure(db, runtime.outbox, {
            workspaceId: params.id,
            actorUserId: user.id,
          })
          if (!queued) return status(409, { error: 'That workspace is already being deleted' })

          await announce(params.id, 'deleting')
          return { queued: true as const }
        },
        {
          platform: true,
          params: z.object({ id: z.string() }),
          body: z.object({ slug: z.string().min(1) }),
        },
      )

      /**
       * Account recovery, for the people a tenant admin may not reset.
       *
       * A reset link sets the password on the account, which is global: the same
       * credentials open every workspace that account belongs to. `/admin` therefore issues
       * one only for somebody whose reach is that one workspace, and sends everyone else
       * here, because a platform admin's authority is the only one that actually covers an
       * account spanning tenants.
       *
       * Still no mail transport, so this reads the same way the tenant one does: the link
       * is shown once and the operator relays it.
       */
      .post(
        '/users/reset-link',
        async ({ body, status, user }) => {
          const rows = await db
            .select({ id: schema.user.id, email: schema.user.email })
            .from(schema.user)
            .where(sql`lower(${schema.user.email}) = ${body.email}`)
            .limit(1)
          const target = rows[0]
          if (!target) return status(404, { error: 'No account with that address' })

          /**
           * An invitation belongs to a workspace, so the reset is filed under the account's
           * oldest membership. The accept route reads the purpose and the user, never the
           * workspace, so which one it is changes nothing — but an account belonging to no
           * workspace has nowhere to file it, and there is nothing to recover access to
           * either.
           */
          const memberships = await db
            .select({ organizationId: schema.member.organizationId })
            .from(schema.member)
            .where(eq(schema.member.userId, target.id))
            .orderBy(schema.member.createdAt)
            .limit(1)
          const workspaceId = memberships[0]?.organizationId
          if (!workspaceId) {
            return status(409, { error: 'That account belongs to no workspace' })
          }

          const invitation = await issueInvitation(db, {
            workspaceId,
            purpose: 'password_reset',
            email: target.email.toLowerCase(),
            userId: target.id,
            invitedByUserId: user.id,
            issuerScope: 'platform',
            ttlMs: PASSWORD_RESET_TTL_MS,
          })

          await writePlatformAudit(db, {
            actorUserId: user.id,
            action: 'user.reset_link_issued',
            targetType: 'user',
            targetId: target.id,
            meta: { email: target.email.toLowerCase() },
          })

          return {
            link: inviteLink(env.PUBLIC_WEB_URL, invitation.token),
            expiresAt: invitation.expiresAt,
          }
        },
        {
          platform: true,
          body: z.object({ email: z.email().transform((value) => value.trim().toLowerCase()) }),
        },
      )

      // ---- platform admins ---------------------------------------------------------
      .get('/admins', async () => ({ admins: await listPlatformAdmins(db) }), { platform: true })

      .post(
        '/admins',
        async ({ body, status, user }) => {
          const rows = await db
            .select({ id: schema.user.id })
            .from(schema.user)
            .where(sql`lower(${schema.user.email}) = ${body.email}`)
            .limit(1)
          const target = rows[0]
          if (!target) {
            // Deliberately not an invitation: a platform admin is not scoped to a tenant,
            // so there is no workspace to invite them into. They need an account first.
            return status(404, { error: 'No account with that address' })
          }

          await grantPlatformAdmin(db, { userId: target.id, grantedByUserId: user.id })
          await writePlatformAudit(db, {
            actorUserId: user.id,
            action: 'platform_admin.granted',
            targetType: 'user',
            targetId: target.id,
            meta: { email: body.email },
          })

          return { userId: target.id }
        },
        {
          platform: true,
          body: z.object({ email: z.email().transform((value) => value.trim().toLowerCase()) }),
        },
      )

      .delete(
        '/admins/:userId',
        async ({ params, status, user }) => {
          /**
           * The last one cannot go. Locked over the whole set rather than the row being
           * removed, because the question is about the count: two admins revoking each
           * other at the same instant would each see one other and both be allowed through,
           * and nobody could ever create a tenant again without a database console.
           *
           * The delete runs inside the same transaction as the lock. Held apart, the lock
           * is released before the row goes and both revocations are allowed through —
           * exactly the outcome it exists to prevent.
           */
          const outcome = await db.transaction(async (tx) => {
            const admins = await tx
              .select({ userId: schema.platformAdmins.userId })
              .from(schema.platformAdmins)
              .for('update')
            if (admins.length === 1 && admins[0]?.userId === params.userId) {
              return { error: 'last_admin' as const }
            }

            const removed = await tx
              .delete(schema.platformAdmins)
              .where(eq(schema.platformAdmins.userId, params.userId))
              .returning({ userId: schema.platformAdmins.userId })
            if (removed.length === 0) return { error: 'not_an_admin' as const }

            await writePlatformAudit(tx, {
              actorUserId: user.id,
              action: 'platform_admin.revoked',
              targetType: 'user',
              targetId: params.userId,
            })

            return { error: null }
          })

          if (outcome.error === 'last_admin') {
            return status(409, { error: 'The platform needs at least one admin' })
          }
          if (outcome.error === 'not_an_admin') {
            return status(404, { error: 'Not a platform admin' })
          }

          return { ok: true as const }
        },
        { platform: true, params: z.object({ userId: z.string() }) },
      )
  )
}
