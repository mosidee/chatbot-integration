import { sql } from 'drizzle-orm'
import { index, integer, jsonb, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * Work the database has promised and the queue has not yet been told about.
 *
 * Every workflow here used to commit its rows to Postgres and then, separately, add a job to
 * BullMQ. Two systems, no transaction between them, so a Redis hiccup in the gap lost the
 * job while keeping the row — and each place recovered differently or not at all. A webhook
 * retry found its event already stored and answered `duplicate` without noticing the job was
 * missing, so the customer's message sat unread for ever. An AI turn that stored its reply
 * and failed to enqueue delivery re-ran the whole turn: another model call, a second reply,
 * a second pass over the tenant's writes. A tenant marked `deleting` whose erasure job never
 * arrived could not be asked for again, because the status said somebody already had.
 *
 * So the promise is written here, in the same transaction as the change it belongs to, and
 * a relay in the worker moves it to BullMQ afterwards. Either both land or neither does.
 *
 * Not tenant-owned, and deliberately so. The nightly sweep belongs to no workspace, and a
 * row must outlive a cascade: a workspace erasure job deleted by the very deletion it was
 * queued to perform would leave the tenant half-erased with nothing left to say so.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true })

/**
 * Adding a job, or taking one back.
 *
 * Cancelling is not deleting the row that queued it. A waiting-human timer is scheduled by
 * one effect and cancelled by another, possibly after the relay has already handed it over,
 * so "remove this job if it got there" is itself a thing to promise transactionally.
 */
export const outboxOpEnum = pgEnum('outbox_op', ['add', 'remove'])

export const outbox = pgTable(
  'outbox',
  {
    /** UUIDv7, so ordering by id is arrival order and the relay needs no second column. */
    id: text('id').primaryKey(),
    /**
     * For logs and the health count. No foreign key: this row has to survive the workspace
     * it belongs to, which is the whole reason a tenant erasure can be trusted to finish.
     */
    workspaceId: text('workspace_id'),
    op: outboxOpEnum('op').notNull().default('add'),
    /** A `QueueName`. Text rather than an enum so adding a queue is not a migration. */
    queue: text('queue').notNull(),
    name: text('name').notNull(),
    payload: jsonb('payload').$type<unknown>().notNull(),
    /**
     * The BullMQ job id, decided by the writer and never by the relay.
     *
     * This is what makes relaying safe to repeat: BullMQ ignores an add whose id it already
     * holds, so a relay that crashed between `queue.add` and marking the row relayed adds
     * nothing the second time. Defaulted from this row's own id where the caller has no
     * natural key, which is still stable across every retry of the same row.
     */
    jobId: text('job_id').notNull(),
    delayMs: integer('delay_ms'),
    /** `removeOnComplete` and friends, passed through to BullMQ untouched. */
    options: jsonb('options').$type<Record<string, unknown>>(),
    createdAt: ts('created_at').defaultNow().notNull(),
    /** Null means the queue has not been told yet. The relay's whole working set. */
    relayedAt: ts('relayed_at'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (table) => [
    /**
     * Partial, because the pending set is tiny and the relayed set grows for ever. This is
     * the only index the relay's hot query needs.
     */
    index('outbox_pending_idx').on(table.id).where(sql`${table.relayedAt} is null`),
  ],
)
