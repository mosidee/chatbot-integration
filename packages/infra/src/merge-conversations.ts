/**
 * Fold a person's split conversations back into one, per channel.
 *
 * These exist because a resolved conversation used to be final: the customer's next message
 * started a new one, so an unbroken chat on their phone became several rows in the console.
 * That behaviour is fixed, and this is for the history it left behind.
 *
 * Lives in the package rather than in `scripts/`, like the migrate and seed scripts do,
 * because `@ci/infra` is deliberately not on the path map: nothing outside a workspace
 * imports the runtime wiring.
 *
 * Reports by default and writes nothing. Set `CONFIRM_MERGE_CONVERSATIONS=yes` to perform
 * it, the same shape as the confirmation `db:reset` asks for, because this is irreversible:
 * eight tables are repointed and the emptied conversations are deleted.
 */
import { createDb } from '@ci/db'
import { findAllSplitConversations, mergeConversations } from './merge'

async function main() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is required')

  const confirmed = process.env.CONFIRM_MERGE_CONVERSATIONS === 'yes'
  const { db, close } = createDb(connectionString, { max: 1 })

  try {
    const workspaces = await findAllSplitConversations(db)

    let groups = 0
    let conversationsRemoved = 0
    let messagesMoved = 0

    for (const workspace of workspaces) {
      if (workspace.status !== 'active') {
        console.log(`skipping ${workspace.slug}: workspace is ${workspace.status}`)
        continue
      }
      if (workspace.groups.length === 0) continue

      console.log(`\n${workspace.slug}`)

      for (const group of workspace.groups) {
        groups += 1
        const who = group.displayName ?? group.externalId
        console.log(
          `  ${who}: ${group.absorbedIds.length + 1} threads, ${group.messages} messages` +
            ` -> 1 thread (${group.survivorId.slice(0, 8)})`,
        )

        if (!confirmed) continue

        const result = await mergeConversations(db, {
          workspaceId: workspace.workspaceId,
          survivorId: group.survivorId,
          absorbedIds: group.absorbedIds,
          userId: null,
        })
        if (!result) {
          console.log('    nothing to do')
          continue
        }

        conversationsRemoved += result.absorbed
        messagesMoved += result.messages
        console.log(
          `    moved ${result.messages} messages, ${result.notes} notes, ` +
            `${result.suggestions} suggestions, ${result.feedback} ratings, ` +
            `${result.traces} traces, ${result.handoffEvents} handoffs, ` +
            `${result.embeddings} recall rows, ${result.verifications} verification codes`,
        )
      }
    }

    if (groups === 0) {
      console.log('Nothing to merge: every customer already has one conversation per channel.')
      return
    }

    if (!confirmed) {
      console.log(
        `\n${groups} customer(s) would be merged. Nothing was written.` +
          '\nRe-run with CONFIRM_MERGE_CONVERSATIONS=yes to do it.',
      )
      return
    }

    console.log(
      `\nMerged ${groups} customer(s): ${messagesMoved} messages moved, ` +
        `${conversationsRemoved} empty conversations removed.`,
    )
  } finally {
    await close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
