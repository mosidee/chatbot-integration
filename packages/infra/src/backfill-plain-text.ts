/**
 * Take the markdown out of replies the AI already sent.
 *
 * Every channel this product speaks renders text literally, so a reply the model wrote as
 * `**Growth ฿299**` reached the customer as asterisks. The turn now converts before
 * storing, but rows written before that change still carry the markup, and the console
 * shows them to agents exactly as they are.
 *
 * Only `messages.text` is rewritten, and only for rows the AI wrote. What the customer
 * typed is evidence and is never touched; neither is an agent's own message, which they
 * wrote as they meant it. `content` keeps the original, so nothing is lost: this changes
 * what is displayed and searched, not the record of what the model produced.
 *
 * Dry by default. Pass --write to commit, and DATABASE_URL decides which database:
 *
 *   bun run backfill:plain-text              # counts and a sample, no writes
 *   bun run backfill:plain-text --write      # rewrites in batches
 */
import { toPlainText } from '@ci/core'
import { createDb, schema } from '@ci/db'
import { and, eq, gt, inArray, sql } from 'drizzle-orm'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}

const write = process.argv.includes('--write')
const BATCH = 500

const { db, close } = createDb(databaseUrl)

/**
 * Rows worth looking at: an AI message whose text contains something markdown-shaped.
 *
 * The filter is deliberately loose. `toPlainText` decides what actually changes, and a row
 * it leaves alone costs one comparison; a row this misses stays wrong forever.
 */
const LOOKS_LIKE_MARKDOWN = sql`(
  ${schema.messages.text} LIKE '%**%'
  OR ${schema.messages.text} LIKE '%\`%'
  OR ${schema.messages.text} ~ '(^|\n) *#{1,6} '
  OR ${schema.messages.text} ~ '(^|\n) *[-*+] '
  OR ${schema.messages.text} ~ '\\[[^]]+\\]\\([^)]+\\)'
)`

let scanned = 0
let changed = 0
let cursor = ''

// Paged by id rather than offset: the set does not move under us, and a crash can be
// resumed by eye from the last id printed.
for (;;) {
  const rows = await db
    .select({ id: schema.messages.id, text: schema.messages.text })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.senderType, 'ai'),
        LOOKS_LIKE_MARKDOWN,
        ...(cursor ? [gt(schema.messages.id, cursor)] : []),
      ),
    )
    .orderBy(schema.messages.id)
    .limit(BATCH)

  if (rows.length === 0) break
  scanned += rows.length
  cursor = rows[rows.length - 1]?.id ?? ''

  const updates = rows
    .map((row) => ({ id: row.id, next: toPlainText(row.text) }))
    .filter((row, index) => row.next !== rows[index]?.text)

  if (updates.length > 0) {
    if (changed === 0) {
      const sample = updates[0]
      const before = rows.find((row) => row.id === sample?.id)?.text ?? ''
      console.log('--- first change ---')
      console.log(`before: ${before.slice(0, 200)}`)
      console.log(`after:  ${sample?.next.slice(0, 200)}`)
      console.log('--------------------')
    }

    if (write) {
      /**
       * One statement per batch rather than per row: a CASE over the ids, so a few hundred
       * rewrites are one round trip. Scoped by the same ids it just read, so nothing else
       * can be caught by it.
       */
      const cases = sql.join(
        updates.map((row) => sql`WHEN ${row.id} THEN ${row.next}`),
        sql` `,
      )
      await db
        .update(schema.messages)
        .set({ text: sql`CASE ${schema.messages.id} ${cases} END` })
        .where(
          inArray(
            schema.messages.id,
            updates.map((row) => row.id),
          ),
        )
    }
    changed += updates.length
  }

  console.log(`scanned ${scanned}, would change ${changed}`)
  if (rows.length < BATCH) break
}

console.log(
  write
    ? `done: ${changed} of ${scanned} messages rewritten`
    : `dry run: ${changed} of ${scanned} messages would change. Pass --write to apply.`,
)

await close()
