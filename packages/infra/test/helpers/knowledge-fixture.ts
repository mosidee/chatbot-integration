import { loadEnv } from '@ci/config'
import type { SlotConfig } from '@ci/core'
import { createDb, type Database, newId, schema } from '@ci/db'
import { eq } from 'drizzle-orm'

/**
 * A workspace with customers and conversations, for retrieval tests.
 * Each test builds its own and tears it down, so tests share one database safely.
 */

export type KnowledgeFixture = {
  db: Database
  workspaceId: string
  sourceId: string
  customerA: { id: string; conversationId: string }
  customerB: { id: string; conversationId: string }
  embedSlot: (baseUrl: string) => SlotConfig
  cleanup: () => Promise<void>
}

export async function createKnowledgeFixture(): Promise<KnowledgeFixture> {
  const env = loadEnv()
  const { db, close } = createDb(env.DATABASE_URL, { max: 4 })

  const workspaceId = newId()
  const slug = `kb-${workspaceId}`

  await db.insert(schema.organization).values({
    id: workspaceId,
    name: slug,
    slug,
    createdAt: new Date(),
  })
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    settings: {
      defaultLanguage: 'th',
      defaultMode: 'ai',
      persona: 'test',
      businessHours: { timezone: 'Asia/Bangkok', days: {} },
      retentionDays: 730,
      redaction: { cardNumbers: true, thaiNationalId: true },
      waitingHumanFallbackMinutes: null,
      acknowledgementText: { th: 'รอสักครู่', en: 'One moment' },
      modelPrices: {},
      externalRetrieval: null,
      identity: {
        widgetToken: { enabled: true },
        verificationLink: { enabled: false, url: null, secretEncrypted: null, ttlMinutes: 15 },
      },
    },
  })

  const channelId = newId()
  await db.insert(schema.channels).values({
    id: channelId,
    workspaceId,
    type: 'test',
    name: 'Simulator',
    webhookSecret: newId(),
  })

  const makeCustomer = async (name: string) => {
    const customerId = newId()
    await db.insert(schema.customers).values({
      id: customerId,
      workspaceId,
      displayName: name,
      primaryLanguage: 'th',
      fields: {},
    })
    const identityId = newId()
    await db.insert(schema.channelIdentities).values({
      id: identityId,
      workspaceId,
      channelId,
      externalId: `${name}-${customerId.slice(0, 6)}`,
      customerId,
      profile: {},
    })
    const conversationId = newId()
    await db.insert(schema.conversations).values({
      id: conversationId,
      workspaceId,
      channelId,
      customerId,
      channelIdentityId: identityId,
      mode: 'ai',
      status: 'open',
    })
    return { id: customerId, conversationId }
  }

  const sourceId = newId()
  await db.insert(schema.knowledgeSources).values({
    id: sourceId,
    workspaceId,
    kind: 'qa',
    title: 'Pilot FAQ',
    status: 'pending',
  })

  return {
    db,
    workspaceId,
    sourceId,
    customerA: await makeCustomer('CustomerA'),
    customerB: await makeCustomer('CustomerB'),
    embedSlot: (baseUrl: string): SlotConfig => ({
      task: 'embed',
      primary: {
        provider: {
          id: 'mock-embed',
          name: 'mock',
          baseUrl,
          apiKey: 'k',
          headers: {},
          supportsTools: false,
          supportsVision: false,
        },
        model: 'mock-embed-model',
      },
      fallback: null,
      params: { maxRetries: 0 },
    }),
    cleanup: async () => {
      await db.delete(schema.organization).where(eq(schema.organization.id, workspaceId))
      await close()
    },
  }
}
