/**
 * Drop and rebuild the development database.
 *
 * This destroys every row. Two guards stand in the way, because the command sits next to
 * `db:migrate` and `db:seed` in package.json and reads like a convenience:
 *
 *  - It refuses when NODE_ENV is production.
 *  - It refuses any database that is not on localhost, unless CI or an explicit
 *    CONFIRM_DESTRUCTIVE_RESET=yes says otherwise.
 *
 * Dropping `public` alone is not enough: Drizzle's journal lives in its own `drizzle`
 * schema, so the next migrate would be a no-op against an empty database and hand back
 * something that claims to be migrated.
 */
import { $ } from 'bun'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to reset the database: NODE_ENV is production.')
  process.exit(1)
}

const host = (() => {
  try {
    return new URL(databaseUrl).hostname
  } catch {
    return ''
  }
})()

const isLocal = ['localhost', '127.0.0.1', '::1', 'postgres'].includes(host)
if (!isLocal && process.env.CONFIRM_DESTRUCTIVE_RESET !== 'yes') {
  console.error(
    [
      `Refusing to reset a database on "${host}", which is not local.`,
      'This deletes every row. If you are certain, re-run with CONFIRM_DESTRUCTIVE_RESET=yes.',
    ].join('\n'),
  )
  process.exit(1)
}

console.log(`Resetting ${host} — this deletes every row.`)

await $`docker compose -f docker-compose.dev.yml exec -T postgres psql -U ci -d chatbot_integration -c ${'DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;'}`.quiet()

await $`bun run db:migrate`
await $`bun run db:seed`

console.log('Database reset.')
