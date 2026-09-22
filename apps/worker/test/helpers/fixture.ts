import { loadEnv } from '@ci/config'
import type { SlotConfig } from '@ci/core'
import { defaultWorkspaceSettings, encryptJson, encryptSecret, newId, schema } from '@ci/db'
import type { WorkspaceSettings } from '@ci/db/schema/app'
import {
  closeQueues,
  createQueues,
  createRuntime,
  type Queues,
  type Runtime,
  relayOnce,
} from '@ci/infra'
import type { HttpToolConfig, WorkspaceStatus } from '@ci/shared'
import type { Queue } from 'bullmq'
import { eq } from 'drizzle-orm'

/**
 * Integration fixtures.
 *
 * Each test builds its own workspace with a unique id and tears it down afterwards, so
 * tests share one database without sharing state and can run against the same containers
 * a developer already has up.
 */

/**
 * The product's own defaults, with the few a test needs differently.
 *
 * Built from `defaultWorkspaceSettings` rather than restated, because three hand-written
 * copies of this had drifted apart: a test could pass against business hours and a fallback
 * timer no real workspace has ever had. Business hours are emptied so a test is not
 * dependent on the hour it runs at, and the fallback timer is off so nothing fires mid-test.
 */
export const DEFAULT_SETTINGS: WorkspaceSettings = defaultWorkspaceSettings({
  persona: 'You support salon-saas, a platform salon owners use to run their business.',
  businessHours: { timezone: 'Asia/Bangkok', days: {} },
  waitingHumanFallbackMinutes: null,
  acknowledgementText: { th: 'รอสักครู่นะคะ', en: 'One moment please.' },
})

export type Fixture = {
  runtime: Runtime
  /**
   * The queues, built here rather than taken from the runtime.
   *
   * Production code cannot reach a queue at all — it promises work through the outbox — so
   * a test that wants to see what was asked for builds its own and relays into them, which
   * is what the worker process does.
   */
  queues: Queues
  workspaceId: string
  channelId: string
  userId: string
  providerId: string
  /** Present when the fixture was asked for a LINE channel. */
  lineChannelId: string | null
  /** The embed slot as core sees it, for indexing knowledge inside a test. */
  embedSlot: () => SlotConfig
  /** Define a tenant tool the AI can call. Returns its id. */
  createTool: (input: {
    name: string
    description?: string
    config: HttpToolConfig
    credential?: string
  }) => Promise<string>
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
  /** Start the workspace suspended or deleting, to prove the processors skip its work. */
  status?: WorkspaceStatus
}): Promise<Fixture> {
  const env = loadEnv()
  const workspaceId = newId()
  // Each fixture gets its own queue namespace so tests sharing one Redis cannot consume
  // each other's jobs.
  // Tool endpoints in these tests run on localhost, which the restricted client refuses by
  // design, so the fixture relaxes it here rather than in the environment.
  const runtime = createRuntime('test', env, {
    queuePrefix: `{test-${workspaceId.slice(0, 8)}}`,
    allowPrivateEgress: true,
  })
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
    ...(options.status ? { status: options.status } : {}),
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

  const queues = createQueues(runtime.redis, runtime.queuePrefix)

  return {
    runtime,
    queues,
    workspaceId,
    channelId,
    userId,
    providerId,
    lineChannelId,
    createTool: async (input) => {
      const id = newId()
      await db.insert(schema.tools).values({
        id,
        workspaceId,
        kind: 'http',
        name: input.name,
        description: input.description ?? `Call ${input.name}`,
        config: input.config,
        credentialEncrypted: input.credential
          ? await encryptSecret(input.credential, env.APP_SECRET_KEY)
          : null,
      })
      return id
    },
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
        Object.values(queues).map((q) => q.obliterate({ force: true }).catch(() => {})),
      )
      // Cascades remove channels, conversations, messages, traces and suggestions.
      await db.delete(schema.organization).where(eq(schema.organization.id, workspaceId))
      await db.delete(schema.user).where(eq(schema.user.id, userId))
      await closeQueues(queues)
      await runtime.close()
    },
  }
}

/**
 * Drain a BullMQ queue's pending jobs, returning their payloads.
 *
 * Relays first, because nothing writes to a queue directly any more: work is promised as an
 * outbox row inside the transaction that made it necessary, and the worker's relay moves it
 * across. A test that looked straight at the queue would see an empty one and conclude that
 * nothing had been asked for. `relayOnce` is what the running worker does on a timer; here
 * it is called at the moment the test wants the answer.
 */
export async function drainQueue<T>(f: Fixture, queue: Queue): Promise<T[]> {
  await relayOnce(f.runtime.db, f.queues)
  const jobs = await queue.getJobs(['waiting', 'delayed', 'prioritized'])
  const payloads = jobs.map((job) => job.data as T)
  await Promise.all(jobs.map((job) => job.remove().catch(() => {})))
  return payloads
}
