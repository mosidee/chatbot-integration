import { type RedactionOptions, redactText } from '@ci/core'
import { type Database, schema } from '@ci/db'
import { MAX_TAGS_PER_CONVERSATION, normaliseTag, normaliseTags, type TagCount } from '@ci/shared'
import { and, eq, sql } from 'drizzle-orm'

/**
 * Conversation tags. Free text, normalised (`normaliseTag`), redacted, and changed by one
 * statement or under a row lock, because the AI's turn and a person in the console can add
 * to the same conversation at the same moment and a read-modify-write lost one of them.
 *
 * A tag is text that is not a message, typed by an agent or produced by a model reading the
 * customer's words, so it is masked where it is written like every other such text.
 */

function clean(raw: readonly string[], redaction: RedactionOptions): string[] {
  return normaliseTags(raw.map((tag) => redactText(tag, redaction).text))
}

export type AddTagsResult =
  | { status: 'ok'; tags: string[] }
  | { status: 'not_found' }
  | { status: 'full'; tags: string[] }

/**
 * Add tags to one conversation.
 *
 * `fit` (the AI's turn) adds what fits under the limit and drops the rest; `strict` (a person)
 * refuses the whole request when it would go past it, so the console can say so. A
 * conversation that already holds more than the limit — stored before it existed — keeps
 * them all but gains no more.
 */
export async function addConversationTags(
  db: Database,
  workspaceId: string,
  conversationId: string,
  raw: readonly string[],
  redaction: RedactionOptions,
  mode: 'fit' | 'strict' = 'fit',
): Promise<AddTagsResult> {
  const wanted = clean(raw, redaction)
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ tags: schema.conversations.tags })
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.id, conversationId),
          eq(schema.conversations.workspaceId, workspaceId),
        ),
      )
      .for('update')
    if (!row) return { status: 'not_found' }

    const current = row.tags
    const added = wanted.filter((tag) => !current.includes(tag))
    if (added.length === 0) return { status: 'ok', tags: current }

    const room = Math.max(0, MAX_TAGS_PER_CONVERSATION - current.length)
    if (mode === 'strict' && added.length > room) return { status: 'full', tags: current }
    const kept = added.slice(0, room)
    if (kept.length === 0) return { status: 'ok', tags: current }

    const tags = [...current, ...kept]
    await tx
      .update(schema.conversations)
      .set({ tags, updatedAt: new Date() })
      .where(
        and(
          eq(schema.conversations.id, conversationId),
          eq(schema.conversations.workspaceId, workspaceId),
        ),
      )
    return { status: 'ok', tags }
  })
}

/** Remove one tag. Null when the conversation is not in this workspace. */
export async function removeConversationTag(
  db: Database,
  workspaceId: string,
  conversationId: string,
  raw: string,
): Promise<string[] | null> {
  const tag = normaliseTag(raw) ?? ''
  const [row] = await db
    .update(schema.conversations)
    .set({
      tags: sql`array_remove(${schema.conversations.tags}, ${tag})`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.conversations.id, conversationId),
        eq(schema.conversations.workspaceId, workspaceId),
      ),
    )
    .returning({ tags: schema.conversations.tags })
  return row?.tags ?? null
}

/**
 * Every tag in the workspace with how many conversations carry it, most used first.
 *
 * `minUses` is what the AI is offered with: a tag on one conversation only may name that
 * customer (a name, an order reference), and offering it in somebody else's conversation is
 * the cross-customer leak recall is scoped twice to prevent.
 */
export async function listWorkspaceTags(
  db: Database,
  workspaceId: string,
  options: { minUses?: number; limit?: number } = {},
): Promise<TagCount[]> {
  const rows = await db.execute<{ tag: string; count: number }>(sql`
    SELECT t AS tag, count(*)::int AS count
    FROM ${schema.conversations}, unnest(${schema.conversations.tags}) AS t
    WHERE ${schema.conversations.workspaceId} = ${workspaceId}
    GROUP BY t
    HAVING count(*) >= ${options.minUses ?? 1}
    ORDER BY count(*) DESC, t
    LIMIT ${options.limit ?? 500}
  `)
  return rows.map((row) => ({ tag: row.tag, count: Number(row.count) }))
}

/**
 * Rename a tag on every conversation in the workspace. Renaming onto a tag a conversation
 * already has merges the two there, keeping the first position. Returns how many
 * conversations changed; 'empty' when nothing is left of the new name.
 */
export async function renameWorkspaceTag(
  db: Database,
  workspaceId: string,
  fromRaw: string,
  toRaw: string,
  redaction: RedactionOptions,
): Promise<number | 'empty'> {
  const from = normaliseTag(fromRaw)
  const [to] = clean([toRaw], redaction)
  if (!from || !to) return 'empty'
  if (from === to) return 0
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE ${schema.conversations} AS c
    SET tags = (
          SELECT array_agg(x.t ORDER BY x.pos)
          FROM (
            SELECT u.t, min(u.pos) AS pos
            FROM unnest(array_replace(c.tags, ${from}, ${to})) WITH ORDINALITY AS u(t, pos)
            GROUP BY u.t
          ) AS x
        ),
        updated_at = now()
    WHERE c.workspace_id = ${workspaceId} AND ${from} = ANY (c.tags)
    RETURNING c.id
  `)
  return rows.length
}

/** Remove a tag from every conversation in the workspace. Returns how many changed. */
export async function deleteWorkspaceTag(
  db: Database,
  workspaceId: string,
  raw: string,
): Promise<number> {
  const tag = normaliseTag(raw)
  if (!tag) return 0
  const rows = await db
    .update(schema.conversations)
    .set({
      tags: sql`array_remove(${schema.conversations.tags}, ${tag})`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.conversations.workspaceId, workspaceId),
        sql`${tag} = ANY (${schema.conversations.tags})`,
      ),
    )
    .returning({ id: schema.conversations.id })
  return rows.length
}
