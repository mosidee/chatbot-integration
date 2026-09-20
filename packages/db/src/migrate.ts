/**
 * Apply database migrations.
 *
 * Extensions are created first, outside Drizzle's migration journal, because several
 * migrations depend on types (`vector`) and operator classes (`gin_trgm_ops`) that must
 * exist before any DDL referencing them runs.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { createDb } from './client'

const REQUIRED_EXTENSIONS = ['vector', 'pg_trgm'] as const

async function main() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is required')

  const { db, close } = createDb(connectionString, { max: 1 })

  try {
    for (const extension of REQUIRED_EXTENSIONS) {
      await db.execute(sql.raw(`CREATE EXTENSION IF NOT EXISTS "${extension}"`))
      console.log(`extension ready: ${extension}`)
    }

    const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle')
    await migrate(db, { migrationsFolder })
    console.log('migrations applied')
  } finally {
    await close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
