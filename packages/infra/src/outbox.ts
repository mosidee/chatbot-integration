import type { Logger } from '@ci/core'
import { type Database, type Executor, newId, schema } from '@ci/db'
import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm'
import type { QueueName, Queues } from './queues'

/**
 * The transactional outbox, and the relay that drains it.
 *
 * Nothing in this codebase calls `queue.add` any more except `relayOnce` below. A caller
 * that wants work done writes a row, in the same transaction as whatever made the work
 * necessary, and this moves it to BullMQ afterwards. The two systems cannot disagree,
 * because only one of them is ever written to by the code that decided.
 *
 * What makes the move safe to repeat is that the writer chooses the job id. BullMQ ignores
 * an `add` for an id it already holds, so a relay that died between handing a job over and
 * marking its row does no harm on the next pass: the add is a no-op and the row is marked.
 * At-least-once delivery of the *intent*, exactly-once creation of the *job*.
 *
 * See ADR 0006.
 */

export type OutboxRequest = {
  queue: QueueName
  name: string
  payload: unknown
  /**
   * The BullMQ job id. Where a caller has a natural key — the message being delivered, the
   * customer message that prompted a turn — it belongs here, because that is what makes the
   * consumer's own retry idempotent as well as the relay's. Left out, the row's id is used,
   * which is stable across relay attempts but unique per request.
   */
  jobId?: string
  delayMs?: number
  options?: Record<string, unknown>
  workspaceId?: string | null
}

export type Outbox = {
  enqueue(executor: Executor, request: OutboxRequest): Promise<{ id: string; jobId: string }>
  cancel(executor: Executor, input: { queue: QueueName; jobId: string }): Promise<void>
}

/** How many rows one relay pass claims at a time. */
const BATCH = 100

/** Postgres channel the writers ring and the relay listens on. */
export const OUTBOX_CHANNEL = 'outbox'

/**
 * Write the intent.
 *
 * `pg_notify` runs on the same executor as the insert, which matters more than it looks:
 * inside a transaction Postgres holds the notification until commit and drops it on
 * rollback. So the relay is woken at exactly the moment the row becomes visible to it, and
 * never for a row that was rolled back.
 */
export function createOutbox(): Outbox {
  return {
    async enqueue(executor, request) {
      const id = newId()
      const jobId = request.jobId ?? `outbox-${id}`

      await executor.insert(schema.outbox).values({
        id,
        workspaceId: request.workspaceId ?? null,
        op: 'add',
        queue: request.queue,
        name: request.name,
        payload: request.payload,
        jobId,
        delayMs: request.delayMs ?? null,
        options: request.options ?? null,
      })
      await executor.execute(sql`select pg_notify(${OUTBOX_CHANNEL}, '')`)

      return { id, jobId }
    },

    /**
     * Take a job back.
     *
     * Two halves, because the job may be on either side of the relay. A pending `add` for
     * the same id is marked relayed without ever being handed over, and a `remove` is
     * written for the case where it already was. Cancelling is itself a promise: the
     * waiting-human timer is scheduled by one effect and cancelled by another, and a
     * cancellation lost in a crash would interrupt a customer a colleague is already
     * talking to.
     */
    async cancel(executor, input) {
      await executor
        .update(schema.outbox)
        .set({ relayedAt: new Date(), lastError: 'cancelled before relay' })
        .where(
          and(
            eq(schema.outbox.queue, input.queue),
            eq(schema.outbox.jobId, input.jobId),
            eq(schema.outbox.op, 'add'),
            isNull(schema.outbox.relayedAt),
          ),
        )

      await executor.insert(schema.outbox).values({
        id: newId(),
        op: 'remove',
        queue: input.queue,
        name: 'cancel',
        payload: {},
        jobId: input.jobId,
      })
      await executor.execute(sql`select pg_notify(${OUTBOX_CHANNEL}, '')`)
    },
  }
}

export type RelayResult = { relayed: number; failed: number }

/**
 * One pass: claim pending rows, hand them to BullMQ, mark them.
 *
 * `FOR UPDATE SKIP LOCKED` is what lets a second worker replica run this at the same time
 * without either duplicating the other's work or waiting on it. Rows it cannot lock belong
 * to somebody else's pass and will be gone by the next one.
 *
 * A row that fails is left pending with its error recorded, so the next pass tries it
 * again. That is the point of the table: the intent survives whatever went wrong.
 */
export async function relayOnce(
  db: Database,
  queues: Queues,
  logger?: Logger,
): Promise<RelayResult> {
  let relayed = 0
  let failed = 0

  for (;;) {
    const batch = await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(schema.outbox)
        .where(isNull(schema.outbox.relayedAt))
        .orderBy(asc(schema.outbox.id))
        .limit(BATCH)
        .for('update', { skipLocked: true })

      for (const row of rows) {
        try {
          const queue = queues[row.queue as QueueName]
          if (!queue) throw new Error(`no such queue: ${row.queue}`)

          if (row.op === 'remove') {
            const job = await queue.getJob(row.jobId)
            await job?.remove().catch(() => {
              // Already running or already gone. Every processor re-reads the state it
              // acts on, so a job that slipped through is not a problem to solve here.
            })
          } else {
            await queue.add(row.name, row.payload, {
              jobId: row.jobId,
              ...(row.delayMs !== null ? { delay: row.delayMs } : {}),
              ...(row.options ?? {}),
            })
          }

          await tx
            .update(schema.outbox)
            .set({ relayedAt: new Date(), lastError: null })
            .where(eq(schema.outbox.id, row.id))
          relayed += 1
        } catch (error) {
          failed += 1
          const message = error instanceof Error ? error.message : String(error)
          await tx
            .update(schema.outbox)
            .set({ attempts: row.attempts + 1, lastError: message })
            .where(eq(schema.outbox.id, row.id))
          logger?.warn('outbox row could not be relayed', {
            id: row.id,
            queue: row.queue,
            attempts: row.attempts + 1,
            error: message,
          })
        }
      }

      return rows.length
    })

    if (batch < BATCH) break
  }

  return { relayed, failed }
}

/** What the health endpoint reports, and what a stuck relay looks like from outside. */
export async function pendingSummary(
  db: Database,
): Promise<{ pending: number; oldestAgeMs: number }> {
  const rows = await db
    .select({
      pending: sql<number>`count(*)::int`,
      oldest: sql<Date | null>`min(${schema.outbox.createdAt})`,
    })
    .from(schema.outbox)
    .where(isNull(schema.outbox.relayedAt))

  const oldest = rows[0]?.oldest
  return {
    pending: rows[0]?.pending ?? 0,
    /**
     * Never negative.
     *
     * `created_at` is written on the database clock and subtracted from this process's
     * clock, and the two disagree by a few milliseconds — enough that a row inserted a
     * moment ago reports having waited minus six. A health endpoint saying the oldest
     * pending work is from the future reads as a broken relay rather than a working one.
     */
    oldestAgeMs: oldest ? Math.max(0, Date.now() - new Date(oldest).getTime()) : 0,
  }
}

/**
 * Delete relayed rows that are old enough to be of no interest.
 *
 * The table would otherwise grow with every message the product ever handles. A day is
 * long enough to answer "did that job ever get queued?" while somebody still cares.
 */
export async function pruneOutbox(db: Database, olderThanMs = 24 * 60 * 60 * 1000): Promise<void> {
  await db
    .delete(schema.outbox)
    .where(lt(schema.outbox.relayedAt, new Date(Date.now() - olderThanMs)))
}

export type Relay = { stop: () => Promise<void> }

/**
 * Keep the outbox drained.
 *
 * Two wake-ups, deliberately. `LISTEN` makes the ordinary case immediate — a customer's
 * message should not wait on a poll interval — and the timer is what covers everything
 * `LISTEN` cannot promise: a dropped connection, a row written by a process whose
 * notification was lost, and a connection pooler in transaction mode, which does not carry
 * notifications at all. There is no pooler in front of Postgres in this deployment today;
 * if one is ever introduced, this keeps working at the timer's pace rather than stopping.
 *
 * Passes never overlap. A second wake-up while one is running sets a flag, and the running
 * pass goes round again rather than starting a second claim against the same rows.
 */
export function startRelay(input: {
  db: Database
  /** The raw postgres-js client, which is what carries LISTEN. */
  listenClient?: { listen: (channel: string, handler: () => void) => Promise<unknown> }
  queues: Queues
  logger: Logger
  /** How often to sweep regardless of notifications. */
  intervalMs?: number
  /** Warn when the oldest pending row is older than this. */
  stallMs?: number
}): Relay {
  const intervalMs = input.intervalMs ?? 1000
  const stallMs = input.stallMs ?? 60_000

  let running = false
  let again = false
  let stopped = false

  const drain = async (): Promise<void> => {
    if (stopped) return
    if (running) {
      again = true
      return
    }
    running = true
    try {
      do {
        again = false
        const result = await relayOnce(input.db, input.queues, input.logger)
        if (result.failed > 0) {
          const { pending, oldestAgeMs } = await pendingSummary(input.db)
          if (oldestAgeMs > stallMs) {
            input.logger.error('outbox is not draining', { pending, oldestAgeMs })
          }
        }
      } while (again && !stopped)
    } catch (error) {
      // Never throw out of the loop: the timer is the only thing keeping this alive.
      input.logger.error('outbox relay pass threw', {
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => void drain(), intervalMs)
  // Node keeps the process alive for an interval; this one must not.
  timer.unref?.()

  const listening = input.listenClient
    ?.listen(OUTBOX_CHANNEL, () => void drain())
    .then(() => {
      input.logger.info('outbox relay listening', { channel: OUTBOX_CHANNEL, intervalMs })
    })
    .catch((error: unknown) => {
      input.logger.warn('outbox relay could not listen; falling back to polling', {
        intervalMs,
        error: error instanceof Error ? error.message : String(error),
      })
    })

  // Drain whatever a previous process left behind before waiting for a first notification.
  void drain()

  return {
    stop: async () => {
      stopped = true
      clearInterval(timer)
      await listening?.catch(() => {})
    },
  }
}
