# ADR 0006: work is promised in Postgres and relayed to the queue

Accepted 2026-09-22.

## Context

Every workflow in this product committed rows to Postgres and then, separately, added a job
to BullMQ. Two systems, no transaction spanning them, and a gap between the two calls in
which the process could die or Redis could refuse. An audit found four places where that gap
lost work, each recovering differently or not at all:

- **Webhook ingestion** inserted the inbound event, then enqueued. A failure between them
  left the event stored with no job. The platform's retry found the event, answered
  `duplicate`, and queued nothing — so the customer's message sat unread while every part of
  the system believed it had been handled.
- **Inbound processing** stored the message, then published, then applied effects. A crash
  in the middle let the retry find the stored message, call it a duplicate and skip effects
  that had never run. The AI turn that message was owed simply never happened.
- **The AI turn** ran the tenant's writes and stored its reply before enqueueing delivery. A
  throw in that tail re-ran the whole job: a second model call, a second reply to the
  customer, a second pass over the writes.
- **Workspace erasure** set the status to `deleting` and then enqueued. A failed enqueue left
  a tenant marked for deletion that could not be asked for again, because the status said
  somebody already had.

These are not four bugs. They are one shape, four times.

## Decision

**Work is asked for by writing a row, in the same transaction as the change that made the
work necessary.** A relay in the worker moves those rows to BullMQ afterwards. Nothing else
in the product calls a queue: `Runtime` does not carry one, so the rule is enforced by there
being nothing to break it with rather than by a comment asking nicely.

The table is `outbox`. It is not tenant-owned and has no foreign key to a workspace: the
nightly sweep belongs to no tenant, and a workspace-erasure job must outlive the cascade it
is queued to perform.

**The writer chooses the job id.** This is what makes relaying safe to repeat. BullMQ ignores
an `add` for an id it already holds, so a relay that dies between handing a job over and
marking its row adds nothing on the next pass. At-least-once delivery of the intent,
exactly-once creation of the job. Where a caller has a natural key it uses it — the message
being delivered, the customer message that prompted a turn — because that same id then makes
the *consumer's* retry idempotent too.

**Two wake-ups.** `pg_notify` runs on the same executor as the insert, so Postgres holds the
notification until commit and drops it on rollback: the relay is woken exactly when the row
becomes visible and never for one that was rolled back. Measured at 29ms when the fallback timer was
30 seconds, which is how we know the notification and not the timer is doing the work. The
sweep is now one second, and runs regardless, covering a dropped connection, a lost notification, and a
connection pooler in transaction mode, which does not carry notifications at all. There is no
pooler in front of Postgres in this deployment; if one is introduced, this degrades to the
timer's pace rather than stopping.

**Rows are claimed with `FOR UPDATE SKIP LOCKED`,** so a second worker replica relays
alongside the first without duplicating its work or queueing behind it.

A row that cannot be delivered is left pending with its error and attempt count recorded, and
tried again next pass. The worker's health endpoint reports the pending count and the age of
the oldest row, and calls itself degraded past a minute: a backlog of promises nobody is
relaying is this service failing at its job while both its dependencies answer normally.

## Consequences

An outbox re-delivers reliably, which makes a non-idempotent consumer produce duplicates
*more* often rather than less. Two consumers needed fixing in the same change:

- The AI turn writes its job id onto the reply as `turn_key`, behind a unique index. A retry
  that finds one knows an earlier attempt already answered and resumes at delivery. It also
  re-reads the conversation's mode before the model call, before the tenant's systems are
  written to, and before the reply is stored, and finally under a lock on the conversation row
  as the reply is committed, because a colleague can take the conversation over during any of
  them. (Since 2026-09-24 the same points also ask whether a newer customer message has made
  this turn redundant: `newerTurnOwed`.)
- Outbound keeps delivery state monotonic. Publishing to the console moved out of the `try`
  that wraps the send, the early return covers `read`, split messages checkpoint each part
  in `sent_parts`, and the LINE reply token is claimed conditionally rather than cleared.

Registering the nightly job *scheduler* still talks to the queue directly, in the worker. It
describes when jobs should come into being rather than asking for one, and there is nothing
in the database it has to agree with.

Tests relay explicitly. `drainQueue` in the worker fixture calls `relayOnce` first, because a
test that looked straight at BullMQ would see an empty queue and conclude nothing had been
asked for.

The table grows by one row per unit of work, so relayed rows older than a day are pruned
hourly. A day is long enough to answer "did that ever get queued?" while somebody still cares.

**What this does not promise.** Exactly-once *tool writes* to a tenant's own systems still
rest on that tenant honouring the idempotency key we send: a retried turn resends the same
key, and what happens then is their endpoint's decision. And a platform send is at-least-once
in the limit, because LINE and Messenger offer no idempotency key of their own — the
checkpointing above narrows the window rather than closing it.

## Alternatives considered

**Stable job ids plus a sweeper.** Each of the four failures has a cheap targeted fix, and
every enqueue in this codebase already corresponds to a durable row: an unprocessed event, a
`queued` message, an incomplete erasure. Deterministic ids plus a periodic sweep over those
rows would give most of the guarantee for a tenth of the change, with no relay to keep alive
and no added latency. It was rejected because it is a convention rather than a rule: a new
queue is correct only if its author remembers both halves, and the failure mode of
forgetting is silent. The outbox makes the guarantee structural.

**Redis transactions.** `MULTI`/`EXEC` makes several Redis commands atomic with each other.
It cannot make any of them atomic with a Postgres commit, which is the only thing that
matters here.

**Letting BullMQ own the state.** Storing domain state in job data and treating the queue as
the source of truth. It inverts the dependency the wrong way: Redis is the component we are
willing to lose, and the database is the one we are not.
