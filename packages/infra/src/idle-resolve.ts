import { applyEffects, type Effect, type Logger, transition } from '@ci/core'
import { type Database, schema } from '@ci/db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { createEffectPorts } from './effect-ports'
import type { Runtime } from './runtime'

/**
 * Resolving conversations the customer has stopped replying to.
 *
 * Nothing closed a conversation on its own, so every one the AI answered and the customer
 * simply walked away from stayed open for good. That mattered for more than a tidy inbox:
 * resolving is what folds a conversation into the customer's summary, so those were never
 * remembered, and the AI met a returning customer as a stranger.
 *
 * What qualifies, all of it:
 *
 * - **Open, and the AI is the one answering** — on its own (`ai`) or drafting for a person
 *   to approve (`ai_supervised`). A conversation waiting for a person is owed a reply by
 *   somebody, and closing it would hide that; one a colleague owns right now is theirs to
 *   close. A conversation a colleague handed *back* is the AI's again and counts. Leaving
 *   supervised workspaces out would have meant none of their customers was ever summarised,
 *   which is the thing this exists to fix.
 * - **Our side spoke last**, the AI or a colleague. The customer speaking last means they
 *   are the one waiting. A system message last — the "somebody is coming" line, with
 *   nobody having come — also does not count: that customer was promised a person.
 * - **Silent for the workspace's chosen number of hours** since that last message.
 *
 * Or, instead of the last two: **nobody has written at all.** A LINE follow — somebody adding
 * the account as a friend — opens a conversation holding one channel event and nothing
 * else. It asks nothing, so the AI rightly says nothing, and with no message from anybody
 * the rule above never matched: every new follower left an open conversation that a person
 * had to close by hand. Such a conversation closes once its newest event is as old as the
 * workspace's hours, and only while it still holds no message from anybody.
 *
 * Who spoke last is read from the messages themselves rather than `last_message_at`, which
 * says when but not who: a system holding message must not count as our side answering, and
 * the column only began moving for agent replies with migration 0017. Channel events (a
 * follow, an unsend, a postback) are not anybody speaking and never decide it.
 *
 * A customer who writes again reopens the conversation, the same as after any resolve.
 */

export type IdleResolveResult = {
  /** How many conversations this pass closed. */
  resolved: number
  cutoff: Date
}

/**
 * Why a conversation qualifies, which is also what the close re-checks and what the note says.
 *
 * - `answered`: our side spoke last and the customer has been quiet since.
 * - `events_only`: nobody has written at all, only channel events (`event` names the newest).
 */
export type IdleCandidate =
  | { id: string; lastMessageId: string; reason: 'answered' }
  | { id: string; lastMessageId: string; reason: 'events_only'; event: string }

/** The conversations in one workspace that qualify right now, with their last message. */
export async function findIdleConversations(
  db: Database,
  input: { workspaceId: string; hours: number; now?: Date },
): Promise<IdleCandidate[]> {
  const now = input.now ?? new Date()
  const cutoff = new Date(now.getTime() - input.hours * 60 * 60 * 1000)

  const rows = await db.execute<{
    id: string
    spoken_id: string | null
    event_id: string | null
    event_name: string | null
  }>(sql`
    SELECT c.id, spoken.id AS spoken_id, quiet.id AS event_id, quiet.event_name
    FROM ${schema.conversations} c
    -- The newest message somebody wrote, channel events aside.
    LEFT JOIN LATERAL (
      SELECT m.id, m.sender_type, m.created_at
      FROM ${schema.messages} m
      WHERE m.conversation_id = c.id
        AND m.workspace_id = ${input.workspaceId}
        AND coalesce(m.content->>'kind', '') <> 'event'
      -- Ids are time-ordered, so they settle two messages written in the same instant
      -- rather than leaving "who spoke last" to whichever row the planner meets first.
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT 1
    ) spoken ON true
    -- Only where nobody wrote anything: the newest event, which starts the clock instead.
    LEFT JOIN LATERAL (
      SELECT m.id, m.created_at, m.content->>'event' AS event_name
      FROM ${schema.messages} m
      WHERE spoken.id IS NULL
        AND m.conversation_id = c.id
        AND m.workspace_id = ${input.workspaceId}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT 1
    ) quiet ON true
    WHERE c.workspace_id = ${input.workspaceId}
      AND c.status = 'open'
      AND c.mode IN ('ai', 'ai_supervised')
      AND (
        (spoken.sender_type IN ('ai', 'human')
          AND spoken.created_at < ${cutoff.toISOString()}::timestamptz)
        OR (spoken.id IS NULL
          AND quiet.created_at < ${cutoff.toISOString()}::timestamptz)
      )
  `)

  // The message's id rather than its time. Postgres keeps microseconds and a JavaScript
  // Date keeps milliseconds, so a timestamp carried out and back compared as earlier than
  // the message it came from, and "nothing newer than this" was never true.
  return [...rows].flatMap((row): IdleCandidate[] => {
    if (row.spoken_id) return [{ id: row.id, lastMessageId: row.spoken_id, reason: 'answered' }]
    if (row.event_id) {
      return [
        {
          id: row.id,
          lastMessageId: row.event_id,
          reason: 'events_only',
          event: row.event_name ?? 'channel',
        },
      ]
    }
    return []
  })
}

/**
 * Close what qualifies in one workspace.
 *
 * Each conversation is closed in its own transaction, under a condition that repeats the
 * rule: a customer message that lands between the search and the close means the
 * conversation is no longer idle, and the update then touches nothing. Effects come from
 * the state machine's own `set_status` transition, so the summary runs exactly as it does
 * when a person presses Resolve.
 */
export async function resolveIdleConversations(
  runtime: Runtime,
  logger: Logger,
  input: { workspaceId: string; hours: number; now?: Date },
): Promise<IdleResolveResult> {
  const { db, publisher } = runtime
  const now = input.now ?? new Date()
  const cutoff = new Date(now.getTime() - input.hours * 60 * 60 * 1000)
  const candidates = await findIdleConversations(db, { ...input, now })

  let resolved = 0
  for (const candidate of candidates) {
    const notifications: (() => Promise<void>)[] = []

    const closed = await db.transaction(async (tx) => {
      const updated = await tx
        .update(schema.conversations)
        .set({ status: 'resolved', updatedAt: now })
        .where(
          and(
            eq(schema.conversations.id, candidate.id),
            eq(schema.conversations.workspaceId, input.workspaceId),
            eq(schema.conversations.status, 'open'),
            inArray(schema.conversations.mode, ['ai', 'ai_supervised']),
            candidate.reason === 'answered'
              ? // Nobody has written since the message the search found. A customer reply in
                // between reopens the question, and a newer reply from our side restarts the
                // clock; either way this is no longer the conversation that qualified.
                sql`NOT EXISTS (
                  SELECT 1 FROM ${schema.messages} m
                  WHERE m.conversation_id = ${candidate.id}
                    AND m.workspace_id = ${input.workspaceId}
                    AND m.id <> ${candidate.lastMessageId}
                    AND m.created_at >= (
                      SELECT created_at FROM ${schema.messages}
                      WHERE id = ${candidate.lastMessageId}
                        AND workspace_id = ${input.workspaceId}
                    )
                    AND coalesce(m.content->>'kind', '') <> 'event'
                )`
              : // Still nobody has written anything. The customer's first words arriving
                // mid-sweep make it a conversation with somebody waiting in it.
                sql`NOT EXISTS (
                  SELECT 1 FROM ${schema.messages} m
                  WHERE m.conversation_id = ${candidate.id}
                    AND m.workspace_id = ${input.workspaceId}
                    AND coalesce(m.content->>'kind', '') <> 'event'
                )`,
          ),
        )
        .returning({
          mode: schema.conversations.mode,
          assigneeUserId: schema.conversations.assigneeUserId,
          handoffReason: schema.conversations.handoffReason,
        })
      const row = updated[0]
      if (!row) return false

      const { effects } = transition(
        {
          mode: row.mode,
          status: 'open',
          assigneeUserId: row.assigneeUserId,
          waitingHumanSince: null,
          handoffReason: row.handoffReason,
        },
        { type: 'set_status', at: now, status: 'resolved' },
      )

      // Said where an agent reading the thread will see it, so a closed conversation is not
      // mistaken for one somebody dealt with.
      const note: Effect = {
        type: 'add_internal_note',
        body:
          candidate.reason === 'answered'
            ? `Resolved automatically: no reply from the customer for ${input.hours} hours after our last message.`
            : // Not "nobody was waiting": a postback is a button the customer pressed, and
              // the AI does not answer those either.
              `Resolved automatically: nobody wrote in the ${input.hours} hours after the customer's ${candidate.event} event.`,
      }

      await applyEffects(
        [note, ...effects],
        { workspaceId: input.workspaceId, conversationId: candidate.id },
        createEffectPorts(runtime, logger, {
          executor: tx,
          afterCommit: (fn) => notifications.push(fn),
        }),
        logger,
      )
      return true
    })

    if (!closed) continue
    resolved += 1

    // After the commit, when it is true: the console and the Inbox badge hear about it.
    await publisher
      .publish(input.workspaceId, { type: 'conversation.updated', conversationId: candidate.id })
      .catch((error: unknown) => {
        logger.warn('publishing an automatic resolve failed', {
          conversationId: candidate.id,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    for (const notify of notifications) await notify().catch(() => {})
  }

  return { resolved, cutoff }
}
