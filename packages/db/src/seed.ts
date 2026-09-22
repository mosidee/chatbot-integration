/**
 * Seed a usable workspace: organization + workspace settings, an admin user, a test
 * channel, a web channel, and optionally one provider with task slots wired to it.
 *
 * The admin is also granted platform admin, because somebody has to be able to create the
 * second tenant and there is no other way in: the running API cannot sign anybody up.
 *
 * Idempotent: re-running updates rather than duplicating.
 */
import { slugify } from '@ci/shared'
import { and, eq } from 'drizzle-orm'
import { createAuth } from './auth-config'
import { createDb } from './client'
import { encryptSecret } from './crypto'
import { newId } from './id'
import { grantPlatformAdmin } from './platform'
import * as schema from './schema'
import { createWorkspace, defaultWorkspaceSettings } from './workspace'

async function main() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is required')
  const secretKey = process.env.APP_SECRET_KEY
  if (!secretKey) throw new Error('APP_SECRET_KEY is required')

  const { db, close } = createDb(connectionString, { max: 1 })

  try {
    const workspaceName = process.env.SEED_WORKSPACE_NAME ?? 'salon-saas'
    const slug = slugify(workspaceName)

    // --- organization + workspace -------------------------------------------------
    const [existingOrg] = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.slug, slug))
      .limit(1)

    let workspaceId: string
    if (existingOrg) {
      workspaceId = existingOrg.id
      console.log(`organization ${slug} already exists`)

      // An organization from before the workspace row existed, or a half-finished seed.
      const existingWorkspace = await db
        .select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .limit(1)
      if (existingWorkspace.length === 0) {
        await db.insert(schema.workspaces).values({
          id: workspaceId,
          settings: defaultWorkspaceSettings(),
        })
        console.log('created workspace settings')
      }
    } else {
      // The same function the platform routes call, so a seeded tenant and a tenant created
      // from the console are identical, channels included.
      const created = await createWorkspace(db, { name: workspaceName, slug })
      workspaceId = created.workspaceId
      console.log(`created organization ${slug} with its channels`)
    }

    // --- admin user ---------------------------------------------------------------
    const adminEmail = process.env.SEED_ADMIN_EMAIL
    const adminPassword = process.env.SEED_ADMIN_PASSWORD
    if (adminEmail && adminPassword) {
      const existing = await db
        .select()
        .from(schema.user)
        .where(eq(schema.user.email, adminEmail))
        .limit(1)

      let userId: string
      if (existing.length === 0) {
        // Go through Better Auth so the password is hashed with its own scheme.
        const auth = createAuth(db, { allowSignUp: true })
        const created = await auth.api.signUpEmail({
          body: { email: adminEmail, password: adminPassword, name: 'Admin' },
        })
        userId = created.user.id
        console.log(`created admin user ${adminEmail}`)
      } else {
        userId = existing[0]?.id ?? ''
        console.log(`admin user ${adminEmail} already exists`)
      }

      if (userId) {
        // Scoped by organization as well as user: somebody who already belongs to another
        // workspace was previously left with no membership in this one, because the check
        // only asked whether they belonged anywhere.
        const membership = await db
          .select({ id: schema.member.id })
          .from(schema.member)
          .where(
            and(eq(schema.member.userId, userId), eq(schema.member.organizationId, workspaceId)),
          )
          .limit(1)
        if (membership.length === 0) {
          await db.insert(schema.member).values({
            id: newId(),
            organizationId: workspaceId,
            userId,
            role: 'admin',
            createdAt: new Date(),
          })
          console.log(`added ${adminEmail} to ${slug} as admin`)
        }

        /**
         * Somebody has to be able to create the second tenant.
         *
         * The running API cannot sign anybody up, so without this grant a fresh
         * installation has no route to the platform page at all. Idempotent, and it never
         * revokes: a re-run of the seed is not a statement about who else should have it.
         */
        await grantPlatformAdmin(db, { userId, grantedByUserId: null })
        console.log(`granted platform admin to ${adminEmail}`)
      }
    } else {
      console.log('SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD not set, skipping admin user')
    }

    // --- channels -----------------------------------------------------------------
    for (const [type, name] of [
      ['test', 'Simulator'],
      ['web', 'Web widget'],
    ] as const) {
      const existing = await db
        .select()
        .from(schema.channels)
        .where(eq(schema.channels.workspaceId, workspaceId))
      if (!existing.some((c) => c.type === type)) {
        await db.insert(schema.channels).values({
          id: newId(),
          workspaceId,
          type,
          name,
          webhookSecret: newId(),
        })
        console.log(`created ${type} channel`)
      }
    }

    // --- optional provider + task slots -------------------------------------------
    const providerBaseUrl = process.env.SEED_PROVIDER_BASE_URL
    const providerKey = process.env.SEED_PROVIDER_KEY
    const chatModel = process.env.SEED_CHAT_MODEL
    if (providerBaseUrl && providerKey && chatModel) {
      const providerName = process.env.SEED_PROVIDER_NAME ?? 'default'
      const existing = await db
        .select()
        .from(schema.providers)
        .where(eq(schema.providers.workspaceId, workspaceId))

      let providerId = existing.find((p) => p.name === providerName)?.id
      if (!providerId) {
        providerId = newId()
        await db.insert(schema.providers).values({
          id: providerId,
          workspaceId,
          name: providerName,
          baseUrl: providerBaseUrl,
          apiKeyEncrypted: await encryptSecret(providerKey, secretKey),
          supportsTools: true,
          supportsVision: Boolean(process.env.SEED_VISION_MODEL),
        })
        console.log(`created provider ${providerName}`)
      }

      const visionModel = process.env.SEED_VISION_MODEL ?? null
      const slots: { task: (typeof schema.aiTaskEnum.enumValues)[number]; model: string | null }[] =
        [
          { task: 'agent_chat', model: chatModel },
          { task: 'suggestion_for_human', model: chatModel },
          { task: 'summarize', model: chatModel },
          { task: 'classify_intent_and_handoff', model: chatModel },
          { task: 'vision', model: visionModel },
        ]

      for (const slot of slots) {
        if (!slot.model) continue
        await db
          .insert(schema.taskSlots)
          .values({
            id: newId(),
            workspaceId,
            task: slot.task,
            primaryProviderId: providerId,
            primaryModel: slot.model,
          })
          .onConflictDoNothing()
      }
      console.log('task slots configured')
    } else {
      console.log('SEED_PROVIDER_* not set, configure providers in the GUI')
    }

    console.log(`\nseed complete. workspace id: ${workspaceId}`)
  } finally {
    await close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
