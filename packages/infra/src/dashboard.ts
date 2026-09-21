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
}

function startOfWindow(days: number, now: Date): Date {
  const since = new Date(now)
  since.setUTCHours(0, 0, 0, 0)
  since.setUTCDate(since.getUTCDate() - (days - 1))
  return since
}

export async function loadDashboard(
  db: Database,
  input: { workspaceId: string; days: number; now?: Date },
): Promise<DashboardSummary> {
  const now = input.now ?? new Date()
  const since = startOfWindow(input.days, now)
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
    handoffsPerDay,
    reasons,
    channels,
    ratings,
    downReasons,
  ] = await Promise.all([
    db.execute<{ day: string; count: number }>(sql`
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*)::int AS count
        FROM ${schema.conversations}
        WHERE workspace_id = ${workspaceId} AND created_at >= ${sinceIso}::timestamptz
        GROUP BY 1
      `),
    db.execute<{ day: string; count: number }>(sql`
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*)::int AS count
        FROM ${schema.messages}
        WHERE workspace_id = ${workspaceId} AND created_at >= ${sinceIso}::timestamptz AND direction = 'inbound'
        GROUP BY 1
      `),
    db.execute<{
      day: string
      outcome: string
      count: number
      cost: string | null
      tokens_in: number | null
      tokens_out: number | null
    }>(sql`
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
               outcome,
               count(*)::int AS count,
               coalesce(sum(cost_estimate), 0)::text AS cost,
               coalesce(sum(tokens_in), 0)::int AS tokens_in,
               coalesce(sum(tokens_out), 0)::int AS tokens_out
        FROM ${schema.aiTraces}
        WHERE workspace_id = ${workspaceId} AND created_at >= ${sinceIso}::timestamptz
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
                 min(created_at) FILTER (WHERE direction = 'outbound') AS answered
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
    db.execute<{ day: string; count: number }>(sql`
        SELECT to_char(date_trunc('day', occurred_at), 'YYYY-MM-DD') AS day, count(*)::int AS count
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
        ),
      ),
    countReviewQueue(db, workspaceId),
  ])

  // Every day in the window, including the quiet ones. A gap in a chart reads as missing
  // data rather than as nothing having happened.
  const days: DashboardDay[] = []
  for (let index = 0; index < input.days; index += 1) {
    const date = new Date(since)
    date.setUTCDate(date.getUTCDate() + index)
    const day = date.toISOString().slice(0, 10)
    const traces = [...tracesPerDay].filter((row) => row.day === day)

    days.push({
      day,
      conversations: [...conversationsPerDay].find((row) => row.day === day)?.count ?? 0,
      customerMessages: [...messagesPerDay].find((row) => row.day === day)?.count ?? 0,
      answered: traces
        .filter((row) => row.outcome === 'sent')
        .reduce((sum, row) => sum + row.count, 0),
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
      answered: totalFor('sent'),
      handoffs: days.reduce((sum, day) => sum + day.handoffs, 0),
      errors: totalFor('error'),
      cost: allTraces.reduce((sum, row) => sum + Number(row.cost ?? 0), 0),
      tokensIn: allTraces.reduce((sum, row) => sum + (row.tokens_in ?? 0), 0),
      tokensOut: allTraces.reduce((sum, row) => sum + (row.tokens_out ?? 0), 0),
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
  }
}
