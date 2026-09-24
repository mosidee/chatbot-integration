import { newId, schema } from '@ci/db'
import { accountReach, consumeInvitation, findInvitation } from '@ci/infra'
import { acceptInvitationBodySchema, type UserRoleName } from '@ci/shared'
import { eq, sql } from 'drizzle-orm'
import Elysia from 'elysia'
import { z } from 'zod'
import type { ApiContext } from '../context'

/**
 * Where an invitation link is opened.
 *
 * Public by necessity: somebody joining for the first time has no account yet, so there is
 * nothing to authenticate them with. The token is what stands in, and it is enough on its
 * own precisely because it is unguessable, single-use and short-lived.
 *
 * The address is never taken from the request. It comes from the stored row, so a link
 * cannot be redirected at somebody else's mailbox by anyone who holds it.
 */
export function invitationRoutes(ctx: ApiContext) {
  const { db, auth, authSignUp, runtime } = ctx

  /** Better Auth sets the session cookie on its own response; we pass it along verbatim. */
  const withCookies = (payload: unknown, headers: Headers): Response => {
    const response = new Response(JSON.stringify(payload), {
      headers: { 'content-type': 'application/json' },
    })
    for (const cookie of headers.getSetCookie()) {
      response.headers.append('set-cookie', cookie)
    }
    return response
  }

  const GONE = { error: 'That link is not valid any more' }

  /**
   * Join the workspace, having already been let through the door.
   *
   * The spend and the membership share a transaction. Apart, a failure between them leaves
   * somebody with an account, no membership, and a link that will never work again, which
   * is the one outcome with no way out but an admin issuing another.
   */
  const claim = async (token: string, userId: string) => {
    return db.transaction(async (tx) => {
      const invitation = await consumeInvitation(tx, token)
      if (!invitation) return null

      /**
       * One membership per person per workspace, held by `member_org_user_uq` (migration
       * 0012; not in the generated auth schema, which `auth:generate` rewrites). Checking
       * first and inserting after let two links accepted at once both insert.
       */
      await tx
        .insert(schema.member)
        .values({
          id: newId(),
          organizationId: invitation.workspaceId,
          userId,
          role: (invitation.role as UserRoleName | null) ?? 'agent',
          createdAt: new Date(),
        })
        .onConflictDoNothing()

      return invitation
    })
  }

  return (
    new Elysia({ name: 'invitation-routes' })

      /**
       * What the landing page needs before anybody types anything.
       *
       * Reads without spending: a refresh, or a mail client prefetching the URL, must not
       * burn the invitation.
       */
      .get(
        '/:token',
        async ({ params, status }) => {
          const invitation = await findInvitation(db, params.token)
          if (!invitation) return status(404, GONE)

          const account = await db
            .select({ id: schema.user.id })
            .from(schema.user)
            .where(sql`lower(${schema.user.email}) = ${invitation.email}`)
            .limit(1)

          return {
            purpose: invitation.purpose,
            email: invitation.email,
            role: invitation.role,
            workspaceName: invitation.workspaceName,
            /** Decides whether they are asked for a password or asked to sign in. */
            existingAccount: account.length > 0,
          }
        },
        { params: z.object({ token: z.string().min(1) }) },
      )

      .post(
        '/:token/accept',
        async ({ params, body, status, request }) => {
          const invitation = await findInvitation(db, params.token)
          if (!invitation) return status(404, GONE)

          const account = await db
            .select({ id: schema.user.id })
            .from(schema.user)
            .where(sql`lower(${schema.user.email}) = ${invitation.email}`)
            .limit(1)
          const existingUserId = account[0]?.id ?? null

          // ---- a new account ---------------------------------------------------------
          if (invitation.purpose === 'invite' && !existingUserId) {
            if (!body.name || !body.password) {
              return status(422, { error: 'A name and a password are needed to join' })
            }

            /**
             * Created before the token is spent, and deliberately so.
             *
             * Better Auth owns this write and cannot join our transaction. If it fails —
             * a password it will not accept, an address that raced us — the invitation is
             * still unspent and the person can simply try again. The reverse order would
             * burn the link on every rejected password.
             */
            let created: Awaited<ReturnType<typeof authSignUp.api.signUpEmail>>
            let headers: Headers
            try {
              const result = await authSignUp.api.signUpEmail({
                body: { email: invitation.email, password: body.password, name: body.name },
                returnHeaders: true,
              })
              created = result.response
              headers = result.headers
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              return status(400, { error: `That account could not be created: ${message}` })
            }

            const claimed = await claim(params.token, created.user.id)
            if (!claimed) return status(409, { error: 'That link has already been used' })

            return withCookies(
              { workspaceId: claimed.workspaceId, userId: created.user.id },
              headers,
            )
          }

          // ---- an account that already exists ----------------------------------------
          if (invitation.purpose === 'invite') {
            const session = await auth.api.getSession({ headers: request.headers })
            if (!session) {
              return status(401, {
                error: 'Sign in with this address to accept the invitation',
                code: 'sign_in_required',
              })
            }
            if (session.user.email.toLowerCase() !== invitation.email) {
              return status(403, { error: 'This invitation was issued to another address' })
            }

            const claimed = await claim(params.token, session.user.id)
            if (!claimed) return status(409, { error: 'That link has already been used' })

            // Put them in the workspace they just joined rather than wherever they were.
            const active = await ctx.auth.api.setActiveOrganization({
              body: { organizationId: claimed.workspaceId },
              headers: request.headers,
              returnHeaders: true,
            })

            return withCookies(
              { workspaceId: claimed.workspaceId, userId: session.user.id },
              active.headers,
            )
          }

          // ---- a password reset ------------------------------------------------------
          if (!body.password) return status(422, { error: 'A new password is needed' })
          if (!existingUserId) return status(404, GONE)
          // The account the link was issued for, not whichever one now holds the address.
          if (invitation.userId && invitation.userId !== existingUserId) {
            return status(404, GONE)
          }

          /**
           * Is the issuer's authority still enough?
           *
           * A workspace admin may reset an account that reaches their workspace alone. That
           * was true when the link was issued; by now the person may belong to a second
           * tenant, administer the platform, or have left this workspace. Spending the link
           * then would set a password the issuer had no authority over, so it is refused
           * and a platform admin has to issue one instead.
           */
          if (invitation.issuerScope === 'workspace') {
            const reach = await accountReach(db, existingUserId)
            if (
              reach.memberships !== 1 ||
              reach.platformAdmin ||
              reach.workspaceIds[0] !== invitation.workspaceId
            ) {
              return status(409, {
                error:
                  'This link no longer covers this account. Ask a platform admin for a new one.',
                code: 'reset_requires_platform' as const,
              })
            }
          }

          const spent = await consumeInvitation(db, params.token)
          if (!spent) return status(409, { error: 'That link has already been used' })

          await setPassword(ctx, existingUserId, body.password)

          // Every session of theirs just ended; so should every socket those sessions held.
          for (const workspaceId of (await accountReach(db, existingUserId)).workspaceIds) {
            await runtime.publisher
              .publish(workspaceId, { type: 'auth.changed', userId: existingUserId })
              .catch(() => {})
          }

          /**
           * Signed in straight away, because the alternative is a sign-in form that the
           * person reaches by typing the password they have just chosen a second time.
           */
          const signedIn = await auth.api.signInEmail({
            body: { email: invitation.email, password: body.password },
            returnHeaders: true,
          })

          return withCookies(
            { workspaceId: spent.workspaceId, userId: existingUserId },
            signedIn.headers,
          )
        },
        {
          params: z.object({ token: z.string().min(1) }),
          body: acceptInvitationBodySchema,
        },
      )
  )
}

/**
 * Replace somebody's password from the server.
 *
 * Not `auth.api.setPassword`: that one refuses an account that already has a password,
 * which is every account this is ever used for. Better Auth's own password reset goes
 * through the internal adapter, so this does the same thing it does.
 *
 * Every existing session is dropped afterwards. Somebody asking for a way back in has
 * either lost their password or lost control of it, and the second case is the one worth
 * designing for.
 */
async function setPassword(ctx: ApiContext, userId: string, password: string): Promise<void> {
  const auth = await ctx.auth.$context
  const hash = await auth.password.hash(password)

  const account = await auth.internalAdapter.findCredentialAccount(userId)
  if (account) {
    await auth.internalAdapter.updatePassword(userId, hash)
  } else {
    // A person who has only ever signed in with Google has no credential account yet.
    await auth.internalAdapter.createAccount({
      userId,
      providerId: 'credential',
      accountId: userId,
      password: hash,
    })
  }

  await auth.internalAdapter.deleteUserSessions(userId)
}
