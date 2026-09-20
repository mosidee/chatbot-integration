import { loadEnv } from '@ci/config'
import type { SlotConfig } from '@ci/core'
import { encryptJson, encryptSecret, newId, schema } from '@ci/db'
import type { WorkspaceSettings } from '@ci/db/schema/app'
import { createRuntime, type Runtime } from '@ci/infra'
import type { Queue } from 'bullmq'
import { eq } from 'drizzle-orm'

/**
 * Integration fixtures.
 *
 * Each test builds its own workspace with a unique id and tears it down afterwards, so
 * tests share one database without sharing state and can run against the same containers
 * a developer already has up.
 */

export const DEFAULT_SETTINGS: WorkspaceSettings = {
  defaultLanguage: 'th',
  defaultMode: 'ai',
  persona: 'You support salon-saas, a platform salon owners use to run their business.',
  businessHours: { timezone: 'Asia/Bangkok', days: {} },
  retentionDays: 730,
  redaction: { cardNumbers: true, thaiNationalId: true },
  waitingHumanFallbackMinutes: null,
  acknowledgementText: { th: 'รอสักครู่นะคะ', en: 'One moment please.' },
  modelPrices: {},
  externalRetrieval: null,
}

export type Fixture = {
  runtime: Runtime
  workspaceId: string
  channelId: string
  userId: string
  providerId: string
  /** Present when the fixture was asked for a LINE channel. */
  lineChannelId: string | null
  /** The embed slot as core sees it, for indexing knowledge inside a test. */
  embedSlot: () => SlotConfig
  cleanup: () => Promise<void>
}

export async function createFixture(options: {
  providerBaseUrl: string
  fallbackBaseUrl?: string
  settings?: Partial<WorkspaceSettings>
  chatModel?: string
  visionBaseUrl?: string
  /** Configures the embed slot, which turns on knowledge retrieval and recall. */
  embedBaseUrl?: string
  /** Also create a LINE channel, for exercising the real adapter path. */
  lineChannel?: { channelSecret: string; channelAccessToken: string }
}): Promise<Fixture> {
  const env = loadEnv()
  const workspaceId = newId()
  // Each fixture gets its own queue namespace so tests sharing one Redis cannot consume
  // each other's jobs.
  const runtime = createRuntime('test', env, { queuePrefix: `{test-${workspaceId.slice(0, 8)}}` })
  const { db } = runtime
  const slug = `test-${workspaceId}`

  await db.insert(schema.organization).values({
    id: workspaceId,
    name: slug,
    slug,
    createdAt: new Date(),
  })
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    settings: { ...DEFAULT_SETTINGS, ...options.settings },
  })

  const userId = newId()
  await db.insert(schema.user).values({
    id: userId,
    name: 'Test Agent',
    email: `${slug}@example.com`,
    emailVerified: true,
  })
  await db.insert(schema.member).values({
    id: newId(),
    organizationId: workspaceId,
    userId,
    role: 'admin',
    createdAt: new Date(),
  })

  const channelId = newId()
  await db.insert(schema.channels).values({
    id: channelId,
    workspaceId,
    type: 'test',
    name: 'Simulator',
    webhookSecret: newId(),
  })

  let lineChannelId: string | null = null
  if (options.lineChannel) {
    lineChannelId = newId()
    await db.insert(schema.channels).values({
      id: lineChannelId,
      workspaceId,
      type: 'line',
      name: 'LINE OA',
      webhookSecret: newId(),
      configEncrypted: await encryptJson(options.lineChannel, env.APP_SECRET_KEY),
    })
  }

  const providerId = newId()
  await db.insert(schema.providers).values({
    id: providerId,
    workspaceId,
    name: 'mock',
    baseUrl: options.providerBaseUrl,
    apiKeyEncrypted: await encryptSecret('test-key', env.APP_SECRET_KEY),
    supportsTools: true,
    supportsVision: true,
  })

  let fallbackProviderId: string | null = null
  if (options.fallbackBaseUrl) {
    fallbackProviderId = newId()
    await db.insert(schema.providers).values({
      id: fallbackProviderId,
      workspaceId,
      name: 'mock-fallback',
      baseUrl: options.fallbackBaseUrl,
      apiKeyEncrypted: await encryptSecret('test-key', env.APP_SECRET_KEY),
      supportsTools: true,
      supportsVision: true,
    })
  }

  const model = options.chatModel ?? 'mock-model'
  for (const task of ['agent_chat', 'suggestion_for_human'] as const) {
    await db.insert(schema.taskSlots).values({
      id: newId(),
      workspaceId,
      task,
      primaryProviderId: providerId,
      primaryModel: model,
      fallbackProviderId,
      fallbackModel: fallbackProviderId ? model : null,
      // Fail over immediately rather than retrying a provider the test made fail.
      params: { maxRetries: 0 },
    })
  }

  if (options.embedBaseUrl) {
    const embedProviderId = newId()
    await db.insert(schema.providers).values({
      id: embedProviderId,
      workspaceId,
      name: 'mock-embed',
      baseUrl: options.embedBaseUrl,
      apiKeyEncrypted: await encryptSecret('test-key', env.APP_SECRET_KEY),
      supportsTools: false,
      supportsVision: false,
    })
    await db.insert(schema.taskSlots).values({
      id: newId(),
      workspaceId,
      task: 'embed',
      primaryProviderId: embedProviderId,
      primaryModel: 'mock-embed-model',
      params: { maxRetries: 0 },
    })
  }

  if (options.visionBaseUrl) {
    const visionProviderId = newId()
    await db.insert(schema.providers).values({
      id: visionProviderId,
      workspaceId,
      name: 'mock-vision',
      baseUrl: options.visionBaseUrl,
      apiKeyEncrypted: await encryptSecret('test-key', env.APP_SECRET_KEY),
      supportsTools: false,
      supportsVision: true,
    })
    await db.insert(schema.taskSlots).values({
      id: newId(),
      workspaceId,
      task: 'vision',
      primaryProviderId: visionProviderId,
      primaryModel: 'mock-vision-model',
      params: { maxRetries: 0 },
    })
  }

  const embedBaseUrl = options.embedBaseUrl

  return {
    runtime,
    workspaceId,
    channelId,
    userId,
    providerId,
    lineChannelId,
    embedSlot: (): SlotConfig => ({
      task: 'embed',
      primary: embedBaseUrl
        ? {
            provider: {
              id: 'mock-embed',
              name: 'mock-embed',
              baseUrl: embedBaseUrl,
              apiKey: 'test-key',
              headers: {},
              supportsTools: false,
              supportsVision: false,
            },
            model: 'mock-embed-model',
          }
        : null,
      fallback: null,
      params: { maxRetries: 0 },
    }),
    cleanup: async () => {
      // Drop this fixture's queues before the workspace, so no stray job outlives it.
      await Promise.allSettled(
        Object.values(runtime.queues).map((q) => q.obliterate({ force: true })),
      )
      // Cascades remove channels, conversations, messages, traces and suggestions.
      await db.delete(schema.organization).where(eq(schema.organization.id, workspaceId))
      await db.delete(schema.user).where(eq(schema.user.id, userId))
      await runtime.close()
    },
  }
}

/** Drain a BullMQ queue's pending jobs, returning their payloads. */
export async function drainQueue<T>(queue: Queue): Promise<T[]> {
  const jobs = await queue.getJobs(['waiting', 'delayed', 'prioritized'])
  const payloads = jobs.map((job) => job.data as T)
  await Promise.all(jobs.map((job) => job.remove().catch(() => {})))
  return payloads
}
