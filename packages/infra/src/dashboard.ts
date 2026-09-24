import { type Database, schema } from '@ci/db'
import { and, eq, sql } from 'drizzle-orm'
import { countReviewQueue } from './review'

/**
 * The numbers an operator needs to decide whether the pilot is working.
 *
 * Deliberately few. Volume says whether anyone is using it, the answered share says
 * whether the AI is carrying its weight, the handoff reasons say what to write next in the
 * knowledge base, first response time says what customers actually experience, and cost
 * says what it is worth. Anything else is a chart nobody acts on.
 *
 * Every figure is scoped to one workspace and computed in Postgres, because the alternative
 * is loading a pilot's worth of messages into memory to count them.
 */

export type DashboardDay = {
  day: string
  conversations: number
  customerMessages: number
  answered: number
  handoffs: number
  cost: number
}

export type DashboardSummary = {
  since: string
  days: DashboardDay[]
  totals: {
    conversations: number
    customerMessages: number
    answered: number
    handoffs: number
    errors: number
    cost: number
    tokensIn: number
    tokensOut: number
  }
  /** Seconds from a customer's first message to the first reply. Null with no data yet. */
  firstResponse: { medianSeconds: number | null; conversations: number }
  /** Median wait from a handoff to the first thing a colleague said, per handoff event. */
  handoffWait: {
    medianSeconds: number | null
    /** Handoffs a colleague has answered, which the median is over. */
    events: number
    /** Handoffs in the window nobody has replied to yet. */
    unanswered: number
  }
  handoffReasons: { reason: string; conversations: number }[]
  channels: { channel: string; type: string; conversations: number }[]
  waitingNow: number
  /**
   * What people thought of the AI's answers. The reasons are the second list of things to
   * fix, beside the handoff reasons: one says where the AI gave up, the other where it
   * should have.
   */
  feedback: { up: number; down: number; reasons: { reason: string; count: number }[] }
  /** Conversations the AI handled that nobody has looked at yet. Not bounded by the window. */
  reviewQueueNow: number
  /** The timezone the days were counted in, so the console can say so. */
  timezone: string
}

/** A timezone Postgres and Intl both accept, or UTC. */
function safeTimezone(timezone: string | undefined): string {
  if (!timezone) return 'UTC'
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone })
    return /^[A-Za-z0-9_+\-/]+$/.test(timezone) ? timezone : 'UTC'
  } catch {
    return 'UTC'
  }
}

export async function loadDashboard(
  db: Database,
  input: {
    workspaceId: string
    days: number
    now?: Date
    /**
     * The workspace's own timezone (`businessHours.timezone`). Days are its days: a
     * Bangkok salon's Monday starts at midnight in Bangkok, which is 17:00 on Sunday in
     * UTC, and bucketing by UTC put its busiest evening on the wrong day.
     */
    timezone?: string
  },
): Promise<DashboardSummary> {
  const now = input.now ?? new Date()
  const tz = safeTimezone(input.timezone)
  const [windowStart] = [
    ...(await db.execute<{ since: string }>(sql`
      SELECT ((date_trunc('day', ${now.toISOString()}::timestamptz AT TIME ZONE ${tz})
               - make_interval(days => ${input.days - 1})) AT TIME ZONE ${tz})::text AS since
    `)),
  ]
  const since = new Date(windowStart?.since ?? now)
  /**
   * As text, not as a Date.
   *
   * The query builder serialises a Date; a raw `sql` template hands the parameter straight
   * to postgres-js, which refuses anything that is not a string or a buffer. The failure is
   * a runtime error naming the argument type rather than anything about dates.
   */
  const sinceIso = since.toISOString()
  const workspaceId = input.workspaceId

  const [
    conversationsPerDay,
    messagesPerDay,
    tracesPerDay,
    firstResponse,
    handoffWait,
    handoffsPerDay,
    reasons,
    channels,
    ratings,
    downReasons,
  ] = await Promise.all([
    db.execute<{ day: string; count: number }>(sql`
        SELECT to_char(date_trunc('day', created_at AT TIME ZONE ${tz}), 'YYYY-MM-DD') AS day, count(*)::int AS count
        FROM ${schema.conversations}
        WHERE workspace_id = ${workspaceId} AND created_at >= ${sinceIso}::timestamptz
        GROUP BY 1
      `),
    db.execute<{ day: string; count: number }>(sql`
        SELECT to_char(date_trunc('day', created_at AT TIME ZONE ${tz}), 'YYYY-MM-DD') AS day, count(*)::int AS count
        FROM ${schema.messages}
        WHERE workspace_id = ${workspaceId} AND created_at >= ${sinceIso}::timestamptz AND direction = 'inbound'
        GROUP BY 1
      `),
    db.execute<{
      day: string
      outcome: string
      count: number
      delivered: number
      cost: string | null
      tokens_in: number | null
      tokens_out: number | null
    }>(sql`
        SELECT to_char(date_trunc('day', t.created_at AT TIME ZONE ${tz}), 'YYYY-MM-DD') AS day,
               outcome,
               count(*)::int AS count,
               -- A turn that wrote a reply is not an answered customer until the reply
               -- reached them: withheld by a takeover, failed, or still queued, it is not.
               (count(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM ${schema.messages} m
                  WHERE m.workspace_id = ${workspaceId}
                    AND m.ai_trace_id = t.id
                    AND m.status IN ('sent', 'delivered', 'read')
               )))::int AS delivered,
               coalesce(sum(cost_estimate), 0)::text AS cost,
               coalesce(sum(tokens_in), 0)::int AS tokens_in,
               coalesce(sum(tokens_out), 0)::int AS tokens_out
        FROM ${schema.aiTraces} t
        WHERE t.workspace_id = ${workspaceId} AND t.created_at >= ${sinceIso}::timestamptz
        GROUP BY 1, 2
      `),
    /**
     * The middle conversation rather than the mean: one conversation that sat all weekend
     * would otherwise make a fast week look slow.
     */
    db.execute<{ median: number | null; conversations: number }>(sql`
        WITH bounds AS (
          SELECT conversation_id,
                 min(created_at) FILTER (WHERE direction = 'inbound') AS asked,
                 -- When a reply reached them, not when one was written: a queued, failed or
                 -- withheld reply answers nobody.
                 min(coalesce(sent_at, created_at)) FILTER (
                   WHERE direction = 'outbound' AND status IN ('sent', 'delivered', 'read')
                 ) AS answered
          FROM ${schema.messages}
          WHERE workspace_id = ${workspaceId} AND created_at >= ${sinceIso}::timestamptz
          GROUP BY conversation_id
        )
        SELECT percentile_cont(0.5) WITHIN GROUP (
                 ORDER BY extract(epoch FROM (answered - asked))
               ) AS median,
               count(*)::int AS conversations
        FROM bounds
        WHERE asked IS NOT NULL AND answered IS NOT NULL AND answered >= asked
      `),
    /**
     * How long people wait for a person, which is the number the first-response figure
     * above cannot answer.
     *
     * That one counts any outbound message, and the AI replies in seconds, so it reads
     * "four seconds" on a week where three customers waited overnight for a colleague.
     * This measures each handoff to the first thing a human said after it.
     *
     * Per event rather than per conversation: one thread can be handed off more than once,
     * and a second wait is a second wait. The `>= 0` guard is the same one the query above
     * needs — `occurred_at` comes from the application clock and `created_at` from the
     * database's, so a handoff and the reply to it can cross by milliseconds.
     */
    db.execute<{ median: number | null; events: number; unanswered: number }>(sql`
        WITH waits AS (
          SELECT h.id,
                 extract(epoch FROM (
                   (SELECT min(coalesce(m.sent_at, m.created_at))
                    FROM ${schema.messages} m
                    WHERE m.workspace_id = ${workspaceId}
                      AND m.conversation_id = h.conversation_id
                      AND m.sender_type = 'human'
                      AND m.status IN ('sent', 'delivered', 'read')
                      AND m.created_at >= h.occurred_at)
                   - h.occurred_at
                 )) AS seconds
          FROM ${schema.handoffEvents} h
          WHERE h.workspace_id = ${workspaceId} AND h.occurred_at >= ${sinceIso}::timestamptz
        )
        -- The median is over answered waits only, and the unanswered ones are counted beside
        -- it rather than dropped. Leaving them out silently made the figure look best exactly
        -- when the longest waits were still going on.
        SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds)
                 FILTER (WHERE seconds IS NOT NULL AND seconds >= 0) AS median,
               (count(*) FILTER (WHERE seconds IS NOT NULL AND seconds >= 0))::int AS events,
               (count(*) FILTER (WHERE seconds IS NULL))::int AS unanswered
        FROM waits
      `),
    db.execute<{ day: string; count: number }>(sql`
        SELECT to_char(date_trunc('day', occurred_at AT TIME ZONE ${tz}), 'YYYY-MM-DD') AS day, count(*)::int AS count
        FROM ${schema.handoffEvents}
        WHERE workspace_id = ${workspaceId} AND occurred_at >= ${sinceIso}::timestamptz
        GROUP BY 1
      `),
    /**
     * Handoffs that happened in the window, read from the event log rather than from the
     * conversation's current state. `conversations.handoff_reason` is cleared the moment a
     * person hands the conversation back, so reading it emptied this list as agents worked
     * through their queue — the one list whose whole job is to say what the AI could not
     * handle. Counted by when the handoff happened, so a conversation opened months ago
     * that gave up yesterday is counted yesterday.
     */
    db.execute<{ reason: string; count: number }>(sql`
        SELECT reason::text AS reason, count(*)::int AS count
        FROM ${schema.handoffEvents}
        WHERE workspace_id = ${workspaceId}
          AND occurred_at >= ${sinceIso}::timestamptz
        GROUP BY 1
        ORDER BY 2 DESC
      `),
    db.execute<{ channel: string; type: string; count: number }>(sql`
        SELECT ch.name AS channel, ch.type::text AS type, count(*)::int AS count
        FROM ${schema.conversations} c
        JOIN ${schema.channels} ch ON ch.id = c.channel_id
        WHERE c.workspace_id = ${workspaceId} AND c.created_at >= ${sinceIso}::timestamptz
        GROUP BY 1, 2
        ORDER BY 3 DESC
      `),
    db.execute<{ rating: string; count: number }>(sql`
        SELECT rating::text AS rating, count(*)::int AS count
        FROM ${schema.feedback}
        WHERE workspace_id = ${workspaceId} AND created_at >= ${sinceIso}::timestamptz
        GROUP BY 1
      `),
    db.execute<{ reason: string; count: number }>(sql`
        SELECT reason::text AS reason, count(*)::int AS count
        FROM ${schema.feedback}
        WHERE workspace_id = ${workspaceId}
          AND created_at >= ${sinceIso}::timestamptz
          AND rating = 'down'
          AND reason IS NOT NULL
        GROUP BY 1
        ORDER BY 2 DESC
      `),
  ])

  const [[waiting], reviewQueueNow] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.workspaceId, workspaceId),
          eq(schema.conversations.mode, 'waiting_human'),
          // Resolving does not change the mode, so a conversation somebody closed while it
          // was waiting would otherwise be counted as waiting forever.
          eq(schema.conversations.status, 'open'),
        ),
      ),
    countReviewQueue(db, workspaceId),
  ])

  // Every day in the window, including the quiet ones. A gap in a chart reads as missing
  // data rather than as nothing having happened.
  const days: DashboardDay[] = []
  // The workspace's calendar dates, named the way Postgres named its buckets. Midday of
  // each day, so a daylight-saving change cannot tip a label onto the neighbouring date.
  const dayName = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  for (let index = 0; index < input.days; index += 1) {
    const day = dayName.format(new Date(since.getTime() + (index * 24 + 12) * 60 * 60 * 1000))
    const traces = [...tracesPerDay].filter((row) => row.day === day)

    days.push({
      day,
      conversations: [...conversationsPerDay].find((row) => row.day === day)?.count ?? 0,
      customerMessages: [...messagesPerDay].find((row) => row.day === day)?.count ?? 0,
      answered: traces
        .filter((row) => row.outcome === 'sent')
        .reduce((sum, row) => sum + row.delivered, 0),
      // From the event log, not from traces: a handoff triggered by media the AI cannot
      // read never ran a turn, so it has no trace and would otherwise be invisible here
      // while still appearing in the reasons beside it.
      handoffs: [...handoffsPerDay].find((row) => row.day === day)?.count ?? 0,
      cost: traces.reduce((sum, row) => sum + Number(row.cost ?? 0), 0),
    })
  }

  const allTraces = [...tracesPerDay]
  const totalFor = (outcome: string) =>
    allTraces.filter((row) => row.outcome === outcome).reduce((sum, row) => sum + row.count, 0)

  return {
    since: since.toISOString(),
    days,
    totals: {
      conversations: days.reduce((sum, day) => sum + day.conversations, 0),
      customerMessages: days.reduce((sum, day) => sum + day.customerMessages, 0),
      answered: allTraces
        .filter((row) => row.outcome === 'sent')
        .reduce((sum, row) => sum + row.delivered, 0),
      handoffs: days.reduce((sum, day) => sum + day.handoffs, 0),
      errors: totalFor('error'),
      cost: allTraces.reduce((sum, row) => sum + Number(row.cost ?? 0), 0),
      tokensIn: allTraces.reduce((sum, row) => sum + (row.tokens_in ?? 0), 0),
      tokensOut: allTraces.reduce((sum, row) => sum + (row.tokens_out ?? 0), 0),
    },
    handoffWait: {
      medianSeconds: [...handoffWait][0]?.median ?? null,
      events: [...handoffWait][0]?.events ?? 0,
      unanswered: [...handoffWait][0]?.unanswered ?? 0,
    },
    firstResponse: {
      medianSeconds: [...firstResponse][0]?.median ?? null,
      conversations: [...firstResponse][0]?.conversations ?? 0,
    },
    handoffReasons: [...reasons].map((row) => ({ reason: row.reason, conversations: row.count })),
    channels: [...channels].map((row) => ({
      channel: row.channel,
      type: row.type,
      conversations: row.count,
    })),
    waitingNow: waiting?.count ?? 0,
    feedback: {
      up: [...ratings].find((row) => row.rating === 'up')?.count ?? 0,
      down: [...ratings].find((row) => row.rating === 'down')?.count ?? 0,
      reasons: [...downReasons].map((row) => ({ reason: row.reason, count: row.count })),
    },
    reviewQueueNow,
    timezone: tz,
  }
}
