import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { loadEnv } from '@ci/config'
import { newId, schema } from '@ci/db'
import { and, eq, isNull } from 'drizzle-orm'
import { pendingSummary, pruneOutbox, relayOnce } from '../src/outbox'
import { closeQueues, createQueues } from '../src/queues'
import { createRuntime } from '../src/runtime'

/**
 * The promise between Postgres and Redis.
 *
 * Everything that wants work done writes a row here, in the transaction that made the work
 * necessary, and the relay moves it to BullMQ afterwards. What these tests pin down is the
 * pair of properties that makes that worth doing: a promise cannot survive a rolled-back
 * transaction, and a job cannot be created twice however many times the relay tries.
 */

const env = loadEnv()
const runtime = createRuntime('test', env, {
  queuePrefix: `{outbox-${Math.random().toString(36).slice(2, 8)}}`,
  allowPrivateEgress: true,
})
const { db, outbox } = runtime
/** Built here: nothing in the product can reach a queue, which is the point of the table. */
const queues = createQueues(runtime.redis, runtime.queuePrefix)

afterAll(async () => {
  await Promise.all(Object.values(queues).map((q) => q.obliterate({ force: true }).catch(() => {})))
  await db.delete(schema.outbox)
  await closeQueues(queues)
  await runtime.close()
})

beforeEach(async () => {
  await db.delete(schema.outbox)
  await Promise.all(Object.values(queues).map((q) => q.drain(true).catch(() => {})))
})

const pending = () =>
  db.select().from(schema.outbox).where(isNull(schema.outbox.relayedAt)).orderBy(schema.outbox.id)

const waiting = (name: 'summarize' | 'retention' | 'waiting_human') =>
  queues[name].getJobs(['waiting', 'delayed', 'prioritized'])

describe('promising work', () => {
  test('writes a row and nothing else', async () => {
    await outbox.enqueue(db, {
      queue: 'summarize',
      name: 'run',
      payload: { hello: 'world' },
    })

    const rows = await pending()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.queue).toBe('summarize')
    // Untouched until somebody relays it.
    expect(await waiting('summarize')).toHaveLength(0)
  })

  /**
   * The property the whole table exists for. A promise made by work that was rolled back
   * was never made: Postgres drops both the row and the notification it sent.
   */
  test('leaves nothing behind when its transaction rolls back', async () => {
    await db
      .transaction(async (tx) => {
        await outbox.enqueue(tx, { queue: 'summarize', name: 'run', payload: { doomed: true } })
        throw new Error('the work this belonged to failed')
      })
      .catch(() => {})

    expect(await pending()).toHaveLength(0)
    await relayOnce(db, queues)
    expect(await waiting('summarize')).toHaveLength(0)
  })

  test('takes the job id the caller chose, and invents a stable one otherwise', async () => {
    const named = await outbox.enqueue(db, {
      queue: 'summarize',
      name: 'run',
      payload: {},
      jobId: 'summary-abc',
    })
    const unnamed = await outbox.enqueue(db, { queue: 'summarize', name: 'run', payload: {} })

    expect(named.jobId).toBe('summary-abc')
    expect(unnamed.jobId).toBe(`outbox-${unnamed.id}`)
  })
})

describe('relaying', () => {
  test('moves a promise to the queue exactly once and marks it', async () => {
    await outbox.enqueue(db, {
      queue: 'summarize',
      name: 'run',
      payload: { conversationId: 'c1' },
      jobId: 'summary-c1',
    })

    const first = await relayOnce(db, queues)
    expect(first).toEqual({ relayed: 1, failed: 0 })
    expect(await pending()).toHaveLength(0)

    const jobs = await waiting('summarize')
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.data).toMatchObject({ conversationId: 'c1' })

    // Nothing left to do, and nothing added by asking again.
    expect(await relayOnce(db, queues)).toEqual({ relayed: 0, failed: 0 })
    expect(await waiting('summarize')).toHaveLength(1)
  })

  test('carries a delay across', async () => {
    await outbox.enqueue(db, {
      queue: 'waiting_human',
      name: 'timeout',
      payload: { conversationId: 'c2' },
      jobId: 'waiting-human-c2',
      delayMs: 60_000,
    })
    await relayOnce(db, queues)

    const job = await queues.waiting_human.getJob('waiting-human-c2')
    expect(job?.opts.delay).toBe(60_000)
  })

  /**
   * The relay's own crash safety. It cannot mark a row and create a job atomically — that
   * is the very gap this table exists to close, one level down — so it must be safe to
   * repeat. A stable job id is what makes the second attempt a no-op.
   */
  test('re-adding after a crash between the add and the mark creates no second job', async () => {
    await outbox.enqueue(db, {
      queue: 'summarize',
      name: 'run',
      payload: { conversationId: 'c3' },
      jobId: 'summary-c3',
    })
    await relayOnce(db, queues)

    // Exactly what a relay that died before its update would leave behind.
    await db
      .update(schema.outbox)
      .set({ relayedAt: null })
      .where(eq(schema.outbox.jobId, 'summary-c3'))

    const second = await relayOnce(db, queues)
    expect(second.relayed).toBe(1)
    expect(await waiting('summarize')).toHaveLength(1)
  })

  test('leaves a row it cannot deliver, with the reason, and tries again next pass', async () => {
    await db.insert(schema.outbox).values({
      id: newId(),
      op: 'add',
      queue: 'no-such-queue',
      name: 'run',
      payload: {},
      jobId: 'orphan-1',
    })

    const first = await relayOnce(db, queues)
    expect(first).toEqual({ relayed: 0, failed: 1 })

    const rows = await pending()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.attempts).toBe(1)
    expect(rows[0]?.lastError).toContain('no such queue')

    const second = await relayOnce(db, queues)
    expect(second.failed).toBe(1)
    expect((await pending())[0]?.attempts).toBe(2)
  })

  /**
   * Two workers may run this at once. `SKIP LOCKED` is what stops them either duplicating
   * each other's work or queueing behind it.
   */
  test('two passes at the same time relay each row once', async () => {
    for (let index = 0; index < 20; index += 1) {
      await outbox.enqueue(db, {
        queue: 'summarize',
        name: 'run',
        payload: { index },
        jobId: `summary-parallel-${index}`,
      })
    }

    const [a, b] = await Promise.all([relayOnce(db, queues), relayOnce(db, queues)])

    expect(a.relayed + b.relayed).toBe(20)
    expect(a.failed + b.failed).toBe(0)
    expect(await pending()).toHaveLength(0)
    expect(await waiting('summarize')).toHaveLength(20)
  })
})

describe('taking a promise back', () => {
  test('a job cancelled before the relay never reaches the queue', async () => {
    await outbox.enqueue(db, {
      queue: 'waiting_human',
      name: 'timeout',
      payload: { conversationId: 'c4' },
      jobId: 'waiting-human-c4',
      delayMs: 60_000,
    })
    await outbox.cancel(db, { queue: 'waiting_human', jobId: 'waiting-human-c4' })

    await relayOnce(db, queues)
    expect(await queues.waiting_human.getJob('waiting-human-c4')).toBeUndefined()
  })

  test('a job cancelled after the relay is removed from the queue', async () => {
    await outbox.enqueue(db, {
      queue: 'waiting_human',
      name: 'timeout',
      payload: { conversationId: 'c5' },
      jobId: 'waiting-human-c5',
      delayMs: 60_000,
    })
    await relayOnce(db, queues)
    expect(await queues.waiting_human.getJob('waiting-human-c5')).toBeTruthy()

    await outbox.cancel(db, { queue: 'waiting_human', jobId: 'waiting-human-c5' })
    await relayOnce(db, queues)
    expect(await queues.waiting_human.getJob('waiting-human-c5')).toBeUndefined()
  })
})

describe('keeping the table honest', () => {
  test('reports what is waiting and how long it has waited', async () => {
    expect(await pendingSummary(db)).toMatchObject({ pending: 0, oldestAgeMs: 0 })

    await outbox.enqueue(db, { queue: 'summarize', name: 'run', payload: {} })
    const summary = await pendingSummary(db)
    expect(summary.pending).toBe(1)
    expect(summary.oldestAgeMs).toBeGreaterThanOrEqual(0)

    await relayOnce(db, queues)
    expect(await pendingSummary(db)).toMatchObject({ pending: 0 })
  })

  test('prunes what it has relayed and keeps what it has not', async () => {
    await outbox.enqueue(db, { queue: 'summarize', name: 'run', payload: { old: true } })
    await relayOnce(db, queues)
    await db
      .update(schema.outbox)
      .set({ relayedAt: new Date(Date.now() - 48 * 60 * 60 * 1000) })
      .where(eq(schema.outbox.queue, 'summarize'))

    await outbox.enqueue(db, { queue: 'retention', name: 'retention', payload: { fresh: true } })

    await pruneOutbox(db)

    const remaining = await db.select().from(schema.outbox)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.queue).toBe('retention')
  })

  test('a promise carries the workspace it was made for', async () => {
    const workspaceId = newId()
    await outbox.enqueue(db, {
      queue: 'retention',
      name: 'retention',
      payload: { workspaceId },
      workspaceId,
    })

    const rows = await db
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.workspaceId, workspaceId), isNull(schema.outbox.relayedAt)))
    expect(rows).toHaveLength(1)
  })
})
