import { loadEnv } from '@ci/config'
import type { EffectPorts, Logger } from '@ci/core'
import {
  type AiTurnJob,
  createRedis,
  createRuntime,
  type InboundJob,
  type OutboundJob,
  QUEUE_NAMES,
  type Runtime,
  type SuggestionJob,
  type WaitingHumanTimeoutJob,
} from '@ci/infra'
import { type Job, Worker } from 'bullmq'
import { createEffectPorts } from './ports'
import { processAiTurn } from './processors/ai-turn'
import { processInbound } from './processors/inbound'
import { processOutbound } from './processors/outbound'
import { processSuggestion } from './processors/suggestion'
import { processWaitingHumanTimeout } from './processors/waiting-human'

/**
 * The worker process.
 *
 * Deliberately separate from the API so the two scale independently: webhooks are bursty
 * and must answer in milliseconds, while AI turns run for seconds and ingestion for
 * minutes. Concurrency is set per queue for the same reason.
 */

const CONCURRENCY = {
  inbound: 10,
  ai_turn: 5,
  suggestion: 5,
  outbound: 10,
  waiting_human: 5,
} as const

function makeWorker<T>(
  name: string,
  runtime: Runtime,
  ports: EffectPorts,
  logger: Logger,
  concurrency: number,
  handler: (runtime: Runtime, ports: EffectPorts, logger: Logger, payload: T) => Promise<void>,
): Worker {
  const worker = new Worker(
    name,
    async (job: Job<T>) => {
      const startedAt = Date.now()
      await handler(runtime, ports, logger, job.data)
      logger.info('job completed', { queue: name, jobId: job.id, ms: Date.now() - startedAt })
    },
    {
      // Workers hold blocking connections, so they get their own rather than sharing the
      // queue client.
      connection: createRedis(runtime.env.REDIS_URL, { forQueue: true }),
      concurrency,
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
  ]

  logger.info('worker started', { queues: workers.length })

  const shutdown = async (signal: string) => {
    logger.info('shutting down', { signal })
    // Close workers first so in-flight jobs finish before their dependencies disappear.
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
