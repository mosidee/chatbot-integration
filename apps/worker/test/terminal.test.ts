import { describe, expect, test } from 'bun:test'
import { Queue, UnrecoverableError, Worker } from 'bullmq'
import { isTerminalFailure } from '../src/terminal'

/**
 * Whether BullMQ has given up on a job. A job that stalled out is failed with an
 * `UnrecoverableError` on its first attempt, which the attempts check alone missed: the
 * message stayed queued and an AI turn ended with nobody told.
 */
describe('a job BullMQ has given up on', () => {
  test('is one on its last attempt, or failed as unrecoverable on any', () => {
    const job = (attemptsMade: number) => ({ attemptsMade, opts: { attempts: 3 } })
    expect(isTerminalFailure(job(1), new Error('transient'))).toBe(false)
    expect(isTerminalFailure(job(3), new Error('transient'))).toBe(true)
    expect(
      isTerminalFailure(job(1), new UnrecoverableError('job stalled more than allowable limit')),
    ).toBe(true)
  })

  test('agrees with what BullMQ itself does with an unrecoverable failure', async () => {
    const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379')
    const connection = {
      host: url.hostname,
      port: Number(url.port || 6379),
      maxRetriesPerRequest: null,
    }
    const name = `terminal-${Date.now()}`
    const queue = new Queue(name, { connection })
    const seen = await new Promise<{ attemptsMade: number; state: string; terminal: boolean }>(
      (resolve) => {
        const worker = new Worker(
          name,
          async () => {
            throw new UnrecoverableError('gone for good')
          },
          { connection },
        )
        worker.on('failed', async (job, error) => {
          if (!job) return
          resolve({
            attemptsMade: job.attemptsMade,
            state: await job.getState(),
            terminal: isTerminalFailure(job, error),
          })
          await worker.close()
        })
        void queue.add('x', {}, { attempts: 3 })
      },
    )
    await queue.obliterate({ force: true })
    await queue.close()
    expect(seen.state).toBe('failed')
    expect(seen.attemptsMade).toBeLessThan(3)
    expect(seen.terminal).toBe(true)
  })
})
