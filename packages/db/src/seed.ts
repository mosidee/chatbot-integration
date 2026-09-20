/**
 * Seed a usable workspace: organization + workspace settings, an admin user, a test
 * channel, a web channel, and optionally one provider with task slots wired to it.
 *
 * Idempotent: re-running updates rather than duplicating.
 */
import { eq } from 'drizzle-orm'
import { createAuth } from './auth-config'
import { createDb } from './client'
import { encryptSecret } from './crypto'
import { newId } from './id'
import * as schema from './schema'
import type { WorkspaceSettings } from './schema/app'

const DEFAULT_SETTINGS: WorkspaceSettings = {
  defaultLanguage: 'th',
  defaultMode: 'ai',
  persona: [
    'You are a helpful customer support assistant for salon-saas, a SaaS platform that salon',
    'owners use to run their business. You answer questions from salon owners and prospects',
    'about pricing, onboarding, features, billing and troubleshooting.',
    'Be concise, warm and practical. Never invent product facts: if you are unsure or the',
    'question needs account-specific action, hand off to a human.',
  ].join(' '),
  businessHours: {
    timezone: 'Asia/Bangkok',
    days: {
      '1': { open: '09:00', close: '18:00' },
      '2': { open: '09:00', close: '18:00' },
      '3': { open: '09:00', close: '18:00' },
      '4': { open: '09:00', close: '18:00' },
      '5': { open: '09:00', close: '18:00' },
    },
  },
  retentionDays: 730,
  redaction: { cardNumbers: true, thaiNationalId: true },
  waitingHumanFallbackMinutes: 15,
  acknowledgementText: {
    th: 'สักครู่นะคะ กำลังโอนสายให้เจ้าหน้าที่ดูแลต่อค่ะ',
    en: 'One moment please, I am passing you to a colleague.',
  },
  modelPrices: {},
  externalRetrieval: null,
}

async function main() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is required')
  const secretKey = process.env.APP_SECRET_KEY
  if (!secretKey) throw new Error('APP_SECRET_KEY is required')

  const { db, close } = createDb(connectionString, { max: 1 })

  try {
    const workspaceName = process.env.SEED_WORKSPACE_NAME ?? 'salon-saas'
    const slug = workspaceName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')

    // --- organization + workspace -------------------------------------------------
    let [org] = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.slug, slug))
      .limit(1)

    if (!org) {
      const inserted = await db
        .insert(schema.organization)
        .values({ id: newId(), name: workspaceName, slug, createdAt: new Date() })
        .returning()
      org = inserted[0]
      console.log(`created organization ${slug}`)
    } else {
      console.log(`organization ${slug} already exists`)
    }
    if (!org) throw new Error('failed to create organization')

    const existingWorkspace = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, org.id))
      .limit(1)

    if (existingWorkspace.length === 0) {
      await db.insert(schema.workspaces).values({ id: org.id, settings: DEFAULT_SETTINGS })
      console.log('created workspace settings')
    }
    const workspaceId = org.id

    // --- admin user ---------------------------------------------------------------
    const adminEmail = process.env.SEED_ADMIN_EMAIL
    const adminPassword = process.env.SEED_ADMIN_PASSWORD
    if (adminEmail && adminPassword) {
      const existing = await db
        .select()
        .from(schema.user)
        .where(eq(schema.user.email, adminEmail))
        .limit(1)

      if (existing.length === 0) {
        // Go through Better Auth so the password is hashed with its own scheme.
        const auth = createAuth(db, { allowSignUp: true })
        const created = await auth.api.signUpEmail({
          body: { email: adminEmail, password: adminPassword, name: 'Admin' },
        })
        const userId = created.user.id
        await db.insert(schema.member).values({
          id: newId(),
          organizationId: workspaceId,
          userId,
          role: 'admin',
          createdAt: new Date(),
        })
        console.log(`created admin user ${adminEmail}`)
      } else {
        const userId = existing[0]?.id
        if (userId) {
          const membership = await db
            .select()
            .from(schema.member)
            .where(eq(schema.member.userId, userId))
            .limit(1)
          if (membership.length === 0) {
            await db.insert(schema.member).values({
              id: newId(),
              organizationId: workspaceId,
              userId,
              role: 'admin',
              createdAt: new Date(),
            })
          }
        }
        console.log(`admin user ${adminEmail} already exists`)
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
