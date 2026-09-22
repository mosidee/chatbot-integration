import { verifyVisitorToken } from '@ci/channels'
import { decryptSecret, schema } from '@ci/db'
import {
  CONFIRMED_TEXT,
  consumeVerificationCode,
  customerLanguage,
  findVerificationCode,
  loadWorkspaceSettings,
  recordVerifiedIdentity,
  storeMessage,
} from '@ci/infra'
import { attributesFromClaims } from '@ci/shared'
import { and, eq } from 'drizzle-orm'
import Elysia from 'elysia'
import { z } from 'zod'
import type { ApiContext } from '../context'

/**
 * Where a one-time verification link comes back.
 *
 * Public by necessity, like the widget's own API: the caller is the tenant's application,
 * not the console, and it has no session with us. What stands in for authentication is the
 * pair of secrets — a code only the person who received the link has, and a token signed
 * with a secret only the tenant has. Neither alone proves anything.
 *
 * The flow: the AI or an agent sends the customer a link to the tenant's page. That page
 * requires its own login, then signs a token naming the logged-in user and posts it here
 * with the code from the link. We then know which LINE or Messenger identity belongs to
 * which account.
 */
export function identityRoutes(ctx: ApiContext) {
  const { db, runtime, env } = ctx

  return new Elysia({ name: 'identity-routes' }).post(
    '/confirm',
    async ({ body, status }) => {
      // Looked up without spending, because the token cannot be checked until we know
      // which workspace's secret signed it. Burning the code first would let a bad token
      // destroy the customer's only link, and anyone who can read the chat can read the
      // code out of it.
      const pending = await findVerificationCode(db, body.code)
      if (!pending) {
        return status(404, { error: 'That link is not valid any more' })
      }

      const settings = await loadWorkspaceSettings(db, pending.workspaceId)
      const link = settings.identity.verificationLink
      if (!link.enabled || !link.secretEncrypted) {
        // Turning the proof off must stop it working immediately, including for a code
        // that was already in somebody's hands.
        return status(404, { error: 'That link is not valid any more' })
      }

      const secret = await decryptSecret(link.secretEncrypted, env.APP_SECRET_KEY)

      let claims: Awaited<ReturnType<typeof verifyVisitorToken>>
      try {
        claims = await verifyVisitorToken(body.token, secret)
      } catch {
        // The code is still unspent, so an honest retry works.
        return status(401, { error: 'That confirmation could not be verified' })
      }

      // Only now is it spent, and in one statement that both checks and claims it, so two
      // requests racing the same code cannot both win.
      const consumed = await consumeVerificationCode(db, body.code)
      if (!consumed) {
        return status(404, { error: 'That link is not valid any more' })
      }

      const attributes = attributesFromClaims(claims)

      await recordVerifiedIdentity(db, {
        workspaceId: consumed.workspaceId,
        channelIdentityId: consumed.channelIdentityId,
        verified: { subject: claims.sub, attributes, via: 'verification_link' },
      })

      // Written into the thread so an agent reading it later can see when this person
      // became a known account, and so the customer is told it worked — in the language the
      // link itself was written in, which is the customer's and not the workspace's.
      const rows = await db
        .select({
          customerId: schema.conversations.customerId,
          mode: schema.conversations.mode,
        })
        .from(schema.conversations)
        .where(
          and(
            eq(schema.conversations.id, consumed.conversationId),
            eq(schema.conversations.workspaceId, consumed.workspaceId),
          ),
        )
        .limit(1)
      const conversation = rows[0]
      if (!conversation) return status(404, { error: 'That link is not valid any more' })

      const language = await customerLanguage(
        db,
        consumed.workspaceId,
        conversation.customerId,
        settings.defaultLanguage,
      )

      const stored = await storeMessage(db, {
        workspaceId: consumed.workspaceId,
        conversationId: consumed.conversationId,
        direction: 'outbound',
        senderType: 'system',
        message: { kind: 'text', text: CONFIRMED_TEXT[language] ?? CONFIRMED_TEXT.en },
        status: 'queued',
        redaction: settings.redaction,
      })

      await runtime.queues.outbound.add('send', {
        workspaceId: consumed.workspaceId,
        conversationId: consumed.conversationId,
        messageId: stored.id,
      })

      await runtime.publisher.publish(consumed.workspaceId, {
        type: 'conversation.updated',
        conversationId: consumed.conversationId,
      })

      // Whatever the customer asked before proving who they were is still unanswered, so
      // the AI gets another turn with the identity it was missing. The processor re-reads
      // the mode, so a conversation a human has taken over is left alone.
      if (conversation.mode === 'ai') {
        await runtime.queues.ai_turn.add('run', {
          workspaceId: consumed.workspaceId,
          conversationId: consumed.conversationId,
          deliver: 'send',
        })
      }

      return { ok: true }
    },
    {
      body: z.object({
        code: z.string().min(1).max(200),
        /** Signed by the tenant with the secret configured for this workspace. */
        token: z.string().min(1).max(4000),
      }),
    },
  )
}
