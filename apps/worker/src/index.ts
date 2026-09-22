import { loadEnv } from '@ci/config'
import type { EffectPorts, Logger } from '@ci/core'
import {
  type AiTurnJob,
  type CustomerErasureJob,
  createEffectPorts,
  createRedis,
  createRuntime,
  type InboundJob,
  type JobMeta,
  type KnowledgeIngestJob,
  type OutboundJob,
  pendingSummary,
  pruneOutbox,
  QUEUE_NAMES,
  type RetentionJob,
  type Runtime,
  type SuggestionJob,
  startRelay,
  type WaitingHumanTimeoutJob,
  type WorkspaceErasureJob,
} from '@ci/infra'
import { type Job, Worker } from 'bullmq'

import { processAiTurn } from './processors/ai-turn'
import { processInbound } from './processors/inbound'
import { processKnowledgeIngest } from './processors/knowledge-ingest'
import { processOutbound } from './processors/outbound'
import {
  processCustomerErasure,
  processRetention,
  processWorkspaceErasure,
} from './processors/retention'
import { processSuggestion } from './processors/suggestion'
import { processSummarize, type SummarizeJob } from './processors/summarize'
import { processWaitingHumanTimeout } from './processors/waiting-human'

/**
 * The worker process.
 *
 * Deliberately separate from the API so the two scale independently: webhooks are bursty
 * and must answer in milliseconds, while AI turns run for seconds and ingestion for
 * minutes. Concurrency is set per queue for the same reason.
 */

/** How long a promise may sit unrelayed before this worker calls itself unhealthy. */
const OUTBOX_STALL_MS = 60_000

const CONCURRENCY = {
  inbound: 10,
  ai_turn: 5,
  suggestion: 5,
  outbound: 10,
  waiting_human: 5,
  // Summaries are background work; they must never crowd out a customer waiting on a reply.
  summarize: 2,
  knowledge_ingest: 2,
  // Deletion is not urgent and touches object storage; one at a time keeps it out of the
  // way of anything a customer is waiting on.
  retention: 1,
  customer_erasure: 1,
  // One at a time, and never more: it deletes a whole tenant's rows and then its media.
  workspace_erasure: 1,
} as const

function makeWorker<T>(
  name: string,
  runtime: Runtime,
  ports: EffectPorts,
  logger: Logger,
  concurrency: number,
  handler: (
    runtime: Runtime,
    ports: EffectPorts,
    logger: Logger,
    payload: T,
    meta: JobMeta,
  ) => Promise<void>,
): Worker {
  const worker = new Worker(
    name,
    async (job: Job<T>) => {
      const startedAt = Date.now()
      await handler(runtime, ports, logger, job.data, {
        jobId: job.id ?? `${name}-${job.timestamp}`,
      })
      logger.info('job completed', { queue: name, jobId: job.id, ms: Date.now() - startedAt })
    },
    {
      // Workers hold blocking connections, so they get their own rather than sharing the
      // queue client.
      connection: createRedis(runtime.env.REDIS_URL, { forQueue: true }),
      concurrency,
      // Must match the queue namespace, or the worker listens to the wrong keys.
      ...(runtime.queuePrefix ? { prefix: runtime.queuePrefix } : {}),
    },
  )

  worker.on('failed', (job, error) => {
    logger.error('job failed', {
      queue: name,
      jobId: job?.id,
      attempt: job?.attemptsMade,
      error: error.message,
    })
  })

  return worker
}

async function main() {
  const env = loadEnv()
  const runtime = createRuntime('worker', env)
  const logger = runtime.logger
  const ports = createEffectPorts(runtime, logger)

  const workers = [
    makeWorker<InboundJob>(
      QUEUE_NAMES.inbound,
      runtime,
      ports,
      logger,
      CONCURRENCY.inbound,
      processInbound,
    ),
    makeWorker<AiTurnJob>(
      QUEUE_NAMES.aiTurn,
      runtime,
      ports,
      logger,
      CONCURRENCY.ai_turn,
      processAiTurn,
    ),
    makeWorker<SuggestionJob>(
      QUEUE_NAMES.suggestion,
      runtime,
      ports,
      logger,
      CONCURRENCY.suggestion,
      processSuggestion,
    ),
    makeWorker<OutboundJob>(
      QUEUE_NAMES.outbound,
      runtime,
      ports,
      logger,
      CONCURRENCY.outbound,
      processOutbound,
    ),
    makeWorker<WaitingHumanTimeoutJob>(
      QUEUE_NAMES.waitingHuman,
      runtime,
      ports,
      logger,
      CONCURRENCY.waiting_human,
      processWaitingHumanTimeout,
    ),
    makeWorker<SummarizeJob>(
      QUEUE_NAMES.summarize,
      runtime,
      ports,
      logger,
      CONCURRENCY.summarize,
      processSummarize,
    ),
    makeWorker<RetentionJob>(
      QUEUE_NAMES.retention,
      runtime,
      ports,
      logger,
      CONCURRENCY.retention,
      processRetention,
    ),
    makeWorker<CustomerErasureJob>(
      QUEUE_NAMES.customerErasure,
      runtime,
      ports,
      logger,
      CONCURRENCY.customer_erasure,
      processCustomerErasure,
    ),
    makeWorker<WorkspaceErasureJob>(
      QUEUE_NAMES.workspaceErasure,
      runtime,
      ports,
      logger,
      CONCURRENCY.workspace_erasure,
      processWorkspaceErasure,
    ),
    makeWorker<KnowledgeIngestJob>(
      QUEUE_NAMES.knowledgeIngest,
      runtime,
      ports,
      logger,
      CONCURRENCY.knowledge_ingest,
      processKnowledgeIngest,
    ),
  ]

  /**
   * The relay: the one thing in this codebase that writes to BullMQ.
   *
   * Everywhere else, work is promised as a row in `outbox` inside the transaction that made
   * it necessary — see ADR 0006. This moves those promises across, woken by the notification
   * Postgres sends at commit and swept on a timer besides. It runs in the worker rather than
   * the API because the API can be stopped without stopping the product, and because a
   * second replica of it costs nothing: rows are claimed with SKIP LOCKED.
   */
  const relay = startRelay({
    db: runtime.db,
    listenClient: runtime.db.$client,
    queues: runtime.queues,
    logger,
  })

  /**
   * The nightly sweep.
   *
   * Registered by the worker rather than by a host cron so the schedule travels with the
   * code and exists wherever the worker runs. A scheduler keyed by name is replaced on each
   * start, so restarting or deploying never leaves two of them behind.
   *
   * Registering a scheduler is not enqueueing work, which is why it still speaks to the
   * queue directly: it describes when jobs should come into being rather than asking for
   * one, and there is nothing in the database it has to agree with.
   */
  await runtime.queues.retention.upsertJobScheduler(
    'retention-nightly',
    { pattern: '17 3 * * *', tz: 'Asia/Bangkok' },
    { name: 'retention', data: {} },
  )
  logger.info('retention scheduled', { pattern: '17 3 * * *', tz: 'Asia/Bangkok' })

  /**
   * A health endpoint, not an API.
   *
   * The worker otherwise serves no HTTP, which leaves container orchestrators and test
   * runners with no way to tell whether it is up. It reports the dependencies it actually
   * needs rather than merely that the process is alive.
   */
  const health = Bun.serve({
    port: env.WORKER_HEALTH_PORT,
    async fetch(request) {
      if (!new URL(request.url).pathname.startsWith('/healthz')) {
        return new Response('not found', { status: 404 })
      }
      const [dbOk, redisOk, outbox] = await Promise.all([
        runtime.db
          .execute('select 1')
          .then(() => true)
          .catch(() => false),
        runtime.redis
          .ping()
          .then(() => true)
          .catch(() => false),
        pendingSummary(runtime.db).catch(() => ({ pending: -1, oldestAgeMs: -1 })),
      ])
      /**
       * A backlog of promises nobody has relayed is this service failing at its job, even
       * with both dependencies answering. Nothing downstream would notice on its own: the
       * rows are safe, the customers are simply not being answered.
       */
      const draining = outbox.oldestAgeMs >= 0 && outbox.oldestAgeMs <= OUTBOX_STALL_MS
      const healthy = dbOk && redisOk && draining
      return Response.json(
        {
          status: healthy ? 'ok' : 'degraded',
          db: dbOk,
          redis: redisOk,
          queues: workers.length,
          outbox,
        },
        { status: healthy ? 200 : 503 },
      )
    },
  })

  logger.info('worker started', {
    queues: workers.length,
    healthPort: health.port,
    outboxRelay: true,
  })

  /**
   * Housekeeping for the outbox: relayed rows are kept a day, long enough to answer "did
   * that ever get queued?" while somebody still cares, and then dropped. Hourly, because a
   * busy tenant writes one of these per message.
   */
  const pruning = setInterval(
    () =>
      void pruneOutbox(runtime.db).catch((error: unknown) => {
        logger.warn('pruning the outbox failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      }),
    60 * 60 * 1000,
  )
  pruning.unref?.()

  const shutdown = async (signal: string) => {
    logger.info('shutting down', { signal })
    // Close workers first so in-flight jobs finish before their dependencies disappear.
    health.stop(true)
    clearInterval(pruning)
    await relay.stop()
    await Promise.allSettled(workers.map((w) => w.close()))
    await runtime.close()
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
